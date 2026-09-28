import { NotFoundError, ValidationError } from '../../common/errors.ts';
import {
	FIELDS,
	HANDLERS,
	STAGES,
	generateCases,
	idFor
} from './sandbox.seed.ts';
import type {
	BatchInput,
	BatchResult,
	CaseRow,
	CellValue,
	FieldChange,
	FieldConflict,
	FieldName,
	ListQuery,
	RemoteChangePolicy
} from './sandbox.types.ts';

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

/** Campos que `mutate` puede cambiar para simular a otro usuario. */
export const MUTABLE_FIELDS = ['stage_code', 'handler_id', 'customer_name'] as const;
export type MutableField = (typeof MUTABLE_FIELDS)[number];

/**
 * Igualdad de valores de celda, normalizada: `null` y ausente son lo mismo, y
 * `1500` y `"1500.00"` también. Comparar el texto crudo daría conflictos falsos
 * por formato.
 */
function sameValue(a: unknown, b: unknown): boolean {
	const blank = (v: unknown) => v === null || v === undefined || v === '';
	if (blank(a) || blank(b)) return blank(a) && blank(b);
	if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
	return String(a) === String(b);
}

/** Minúsculas y sin acentos: «grúas» encuentra «Grúas» y «gruas». */
const fold = (s: string) =>
	s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/**
 * Almacén en memoria del sandbox.
 *
 * **Vistas cacheadas.** Filtrar y ordenar 50 000 filas cuesta decenas de ms, y
 * el scroll pide una página tras otra con la misma consulta. Cada combinación
 * de orden, filtros y búsqueda se calcula una vez y se reutiliza hasta que
 * cambian los datos (`version`). Es lo que haría un índice en Postgres.
 */
export class SandboxService {
	private rows: CaseRow[] = [];
	private byId = new Map<string, CaseRow>();
	private nextIndex = 1;
	/** Sube con cada escritura. Invalida las vistas y viaja en cada respuesta. */
	private version = 0;
	private views = new Map<string, { version: number; rows: CaseRow[]; position?: Map<string, number> }>();
	/**
	 * En qué versión de la fila cambió cada campo por última vez. Es lo que
	 * permite decir **qué** campos cambió otro usuario desde la versión que leyó
	 * el cliente (`notices`). En Postgres sería una tabla de historial o una
	 * columna por campo; aquí, un mapa.
	 */
	private fieldVersions = new Map<string, Partial<Record<FieldName, number>>>();

	constructor(
		private readonly size: number,
		/** Política de cambios ajenos de esta colección (G-15). */
		private readonly policy: RemoteChangePolicy = 'merge'
	) {
		this.reset();
	}

	reset(): { rows: number } {
		this.rows = generateCases(this.size);
		this.fieldVersions.clear();
		this.byId = new Map(this.rows.map((r) => [r.id, r]));
		this.nextIndex = this.size + 1;
		this.version++;
		this.views.clear();
		return { rows: this.rows.length };
	}

	catalogs() {
		return {
			stages: STAGES.map((s) => ({ value: s.code, label: s.name })),
			handlers: HANDLERS.map((h) => ({ value: h.id, label: h.name })),
			fields: FIELDS,
			/** Política de cambios ajenos de esta colección (G-15). Los tests la leen para saber qué esperar. */
			remoteChanges: this.policy
		};
	}

	// -- lectura --------------------------------------------------------------

	private view(query: ListQuery): { rows: CaseRow[]; key: string } {
		const key = JSON.stringify([query.sort, query.stage, query.handler, query.search]);
		const cached = this.views.get(key);
		if (cached?.version === this.version) return { rows: cached.rows, key };

		const stage = new Set(query.stage);
		const handler = new Set(query.handler);
		const needle = fold(query.search.trim());
		let rows = this.rows.filter(
			(r) =>
				(stage.size === 0 || stage.has(r.stage_code)) &&
				(handler.size === 0 || handler.has(r.handler_id ?? '')) &&
				(needle === '' ||
					fold(r.customer_name).includes(needle) ||
					fold(r.customer_rfc).includes(needle) ||
					r.id.includes(needle))
		);

		/*
			El orden **siempre** termina en el id. Sin desempate, dos filas con el
			mismo valor pueden intercambiarse entre dos consultas y una fila
			aparecer en dos páginas —o en ninguna— al paginar.
		*/
		const sort = query.sort;
		if (sort) {
			const dir = sort.dir === 'asc' ? 1 : -1;
			const numeric = FIELDS[sort.field].kind === 'number';
			rows = rows.sort((a, b) => {
				const va = a[sort.field];
				const vb = b[sort.field];
				// Los vacíos van al final en ambos sentidos.
				if (va === null && vb !== null) return 1;
				if (vb === null && va !== null) return -1;
				if (va !== null && vb !== null && va !== vb) {
					const cmp = numeric ? (va as number) - (vb as number) : collator.compare(String(va), String(vb));
					if (cmp !== 0) return cmp * dir;
				}
				return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
			});
		}
		// Sin orden explícito se conserva el del almacén, que ya es por id.

		this.views.set(key, { version: this.version, rows });
		return { rows, key };
	}

	list(query: ListQuery) {
		const { rows } = this.view(query);
		return {
			rows: rows.slice(query.offset, query.offset + query.limit),
			total: rows.length,
			offset: query.offset,
			limit: query.limit,
			version: this.version
		};
	}

	get(id: string): CaseRow {
		const row = this.byId.get(id);
		if (!row) throw new NotFoundError(`No existe la fila ${id}`);
		return row;
	}

	/**
	 * Posición global de una fila dentro de una consulta. Es lo que permite al
	 * panel de cambios llevar a una fila que no está cargada: se pide su
	 * posición y se carga la ventana alrededor. `null` si la consulta la excluye.
	 */
	position(id: string, query: ListQuery): { id: string; position: number | null; total: number } {
		this.get(id);
		const { rows, key } = this.view(query);
		const cached = this.views.get(key)!;
		cached.position ??= new Map(rows.map((r, i) => [r.id, i]));
		return { id, position: cached.position.get(id) ?? null, total: rows.length };
	}

	// -- escritura ------------------------------------------------------------

	/**
	 * Aplica un lote de altas, cambios y bajas.
	 *
	 * **Dos niveles de rechazo, deliberadamente distintos:**
	 * - Un lote **mal formado** —campo inexistente, valor inválido, campo no
	 *   editable— se rechaza entero con 400 y no se aplica nada. Es un defecto
	 *   del cliente, no una situación que el usuario deba resolver.
	 * - Una fila **en conflicto** —otro usuario la cambió o la eliminó— se
	 *   devuelve en `conflicts` y **el resto del lote se aplica**. Bloquear
	 *   2 000 cambios válidos por uno en conflicto obligaría a rehacerlos.
	 */
	batch(input: BatchInput): BatchResult {
		this.validateBatch(input);

		const result: BatchResult = { created: [], updated: [], deleted: [], notices: [], conflicts: [] };
		const now = new Date().toISOString();

		for (const { id, rowVersion, changes } of input.updates) {
			const row = this.byId.get(id);
			if (!row) {
				result.conflicts.push({ op: 'update', id, reason: 'not_found', remote: null });
				continue;
			}
			const fields = Object.entries(changes) as [FieldName, FieldChange][];

			// Atajo: misma versión que leyó el cliente → nadie más tocó la fila.
			if (row.rowVersion !== rowVersion) {
				// Concurrencia por campo (G-14): conflicto solo si el valor actual ya no es el que leyó.
				const clashes: FieldConflict[] = fields
					.filter(([field, change]) => !sameValue(row[field], change.from))
					.map(([field, change]) => ({ field, from: change.from, yours: change.to, remote: row[field] }));
				if (clashes.length > 0) {
					result.conflicts.push({ op: 'update', id, reason: 'field_conflict', fields: clashes, remote: { ...row } });
					continue;
				}
				// Cambios ajenos en otros campos: según la política de la colección (G-15).
				if (this.policy === 'strict') {
					result.conflicts.push({ op: 'update', id, reason: 'version_mismatch', remote: { ...row } });
					continue;
				}
				const touched = new Set(fields.map(([field]) => field));
				const foreign = Object.entries(this.fieldVersions.get(id) ?? {})
					.filter(([field, version]) => version > rowVersion && !touched.has(field as FieldName))
					.map(([field]) => field as FieldName);
				if (foreign.length > 0) result.notices.push({ id, fields: foreign });
			}

			this.writeFields(row, fields.map(([field, change]) => [field, change.to]), now);
			result.updated.push({ ...row });
		}

		const toDelete = new Set<string>();
		for (const { id, rowVersion } of input.deletes) {
			const row = this.byId.get(id);
			// Ya no existe: lo que el cliente quería ya ocurrió. No es un conflicto.
			if (!row) {
				result.deleted.push(id);
				continue;
			}
			// Borrar una fila que otro editó es siempre conflicto (G-16): se perdería su trabajo.
			if (row.rowVersion !== rowVersion) {
				result.conflicts.push({ op: 'delete', id, reason: 'version_mismatch', remote: { ...row } });
				continue;
			}
			toDelete.add(id);
			this.byId.delete(id);
			this.fieldVersions.delete(id);
			result.deleted.push(id);
		}
		if (toDelete.size > 0) this.rows = this.rows.filter((r) => !toDelete.has(r.id));

		for (const { key, values } of input.creates) {
			const row: CaseRow = {
				id: idFor(this.nextIndex++),
				customer_name: '',
				customer_rfc: '',
				stage_code: STAGES[0].code,
				handler_id: null,
				dpd: 0,
				overdue_amount: 0,
				total_amount: 0,
				charges_overdue: 0,
				contracts: 0,
				promise_amount: null,
				promise_date: null,
				last_contact_at: null,
				...(values as Partial<CaseRow>),
				rowVersion: 1,
				updated_at: now
			};
			this.rows.push(row);
			this.byId.set(row.id, row);
			result.created.push({ key, row });
		}

		if (result.updated.length || result.deleted.length || result.created.length) this.version++;
		return result;
	}

	/** Escribe campos, sube la versión de la fila y anota en qué versión cambió cada campo. */
	private writeFields(row: CaseRow, fields: [FieldName, CellValue][], now: string): void {
		row.rowVersion++;
		row.updated_at = now;
		const versions = this.fieldVersions.get(row.id) ?? {};
		for (const [field, value] of fields) {
			(row as unknown as Record<string, CellValue>)[field] = value;
			versions[field] = row.rowVersion;
		}
		this.fieldVersions.set(row.id, versions);
	}

	private validateBatch(input: BatchInput): void {
		const problems: { path: string; message: string }[] = [];
		const seen = new Set<string>();

		const checkValues = (path: string, values: Record<string, unknown>) => {
			for (const [field, value] of Object.entries(values)) {
				const message = validateValue(field, value);
				if (message) problems.push({ path: `${path}.${field}`, message });
			}
		};

		input.updates.forEach((u, i) => {
			if (seen.has(u.id)) problems.push({ path: `updates[${i}].id`, message: 'Fila repetida en el lote' });
			seen.add(u.id);
			const targets = Object.fromEntries(Object.entries(u.changes).map(([f, c]) => [f, c?.to]));
			checkValues(`updates[${i}].changes`, targets);
		});
		input.deletes.forEach((d, i) => {
			if (seen.has(d.id)) problems.push({ path: `deletes[${i}].id`, message: 'Fila repetida en el lote' });
			seen.add(d.id);
		});
		input.creates.forEach((c, i) => {
			checkValues(`creates[${i}].values`, c.values);
			for (const field of ['customer_name', 'customer_rfc'] as const) {
				if (c.values[field] == null) problems.push({ path: `creates[${i}].values.${field}`, message: 'Obligatorio' });
			}
		});

		if (problems.length > 0) throw new ValidationError('El lote tiene valores inválidos', problems);
	}

	// -- utilidades de prueba -------------------------------------------------

	/**
	 * Simula a otro usuario editando: cambia `count` filas al azar y sube su
	 * versión. Las filas que el cliente tenga pendientes de guardar entrarán
	 * en conflicto al guardar.
	 *
	 * `ids` permite elegir filas concretas, para provocar un conflicto a
	 * propósito sobre una fila que se acaba de editar en el navegador.
	 */
	mutate(
		count: number,
		ids?: string[],
		fields: MutableField[] = ['stage_code', 'handler_id']
	) {
		const now = new Date().toISOString();
		const targets = ids?.length
			? ids.map((id) => this.get(id))
			: Array.from({ length: Math.min(count, this.rows.length) }, () =>
					this.rows[Math.floor(Math.random() * this.rows.length)]!
				);

		const mutated = targets.map((row) => {
			const changes: [FieldName, CellValue][] = [];
			if (fields.includes('stage_code')) {
				const others = STAGES.filter((s) => s.code !== row.stage_code);
				changes.push(['stage_code', others[Math.floor(Math.random() * others.length)]!.code]);
			}
			if (fields.includes('handler_id')) {
				const others = HANDLERS.filter((h) => h.id !== row.handler_id);
				changes.push(['handler_id', others[Math.floor(Math.random() * others.length)]!.id]);
			}
			if (fields.includes('customer_name')) {
				changes.push(['customer_name', `${row.customer_name} · editado por otro`]);
			}
			this.writeFields(row, changes, now);
			return { id: row.id, rowVersion: row.rowVersion, fields };
		});
		if (mutated.length) this.version++;
		return { mutated };
	}
}

/** Mensaje de error si `value` no es válido para `field`; `null` si lo es. */
function validateValue(field: string, value: unknown): string | null {
	const spec = FIELDS[field as FieldName];
	if (!spec) return 'Campo inexistente';
	if (!spec.editable) return 'Campo de solo lectura';
	if (value === null) return spec.nullable ? null : 'No admite vacío';

	switch (spec.kind) {
		case 'text':
			if (typeof value !== 'string') return 'Debe ser texto';
			if (value.trim() === '' && !spec.nullable) return 'No admite vacío';
			return value.length > 200 ? 'Máximo 200 caracteres' : null;
		case 'number':
			return typeof value === 'number' && Number.isFinite(value) ? null : 'Debe ser un número';
		case 'date':
			return typeof value === 'string' &&
				/^\d{4}-\d{2}-\d{2}$/.test(value) &&
				!Number.isNaN(Date.parse(value))
				? null
				: 'Fecha inválida (AAAA-MM-DD)';
		case 'enum':
			return spec.values?.includes(value as string) ? null : 'Valor fuera del catálogo';
		default:
			return 'Campo no editable';
	}
}
