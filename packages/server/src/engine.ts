/**
 * El motor de una hoja remota. **No sabe nada del cliente**: solo del esquema
 * (`SheetDef` de `@spreadbase/core`), sus filas y las reglas del protocolo
 * (SB-5). Es genérico de dominio: la demo de 50 000 casos y, después, cualquier
 * módulo, comparten exactamente este código.
 *
 * Estado en memoria (SB-2: el almacenamiento llega como datos). Un adaptador
 * Postgres se diseña cuando exista el esquema real.
 */
import {
	canonicalize,
	idFieldOf,
	sameValue,
	validateField,
	writableFields,
	normalizeForSearch,
	type BatchCreate,
	type BatchRequest,
	type BatchResponse,
	type Conflict,
	type FieldConflict,
	type Notice,
	type PageRequest,
	type PageResult,
	type RemoteChangePolicy,
	type SheetDef
} from '@spreadbase/core';
import { NotFoundError, ValidationError } from './errors.ts';

export type Row = Record<string, unknown> & { rowVersion: number };

interface ListQuery {
	offset: number;
	limit: number;
	sort?: { field: string; dir: 'asc' | 'desc' } | null;
	filters?: Record<string, string[]>;
	search?: string;
}

export const DEFAULT_LIMIT = 60;

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

export interface EngineOptions {
	/** Cómo se genera el id de una fila creada. La demo: `row_${n}`. */
	newId?: (nextIndex: number) => string;
	/** Iniciales de las filas nuevas: defaults del esquema antes de lo que manda el cliente. */
	rowDefaults?: (nextIndex: number) => Record<string, unknown>;
	/** Política de cambios ajenos (G-15). */
	policy?: RemoteChangePolicy;
}

export class SheetEngine {
	readonly sheet: SheetDef;
	private rows: Row[] = [];
	private byId = new Map<unknown, Row>();
	private nextIndex = 1;
	/** Sube con cada escritura. Invalida las vistas y viaja en cada respuesta. */
	private version = 0;
	private views = new Map<string, { version: number; rows: Row[]; position?: Map<unknown, number> }>();
	/** En qué versión de la fila cambió cada campo, para los `notices`. */
	private fieldVersions = new Map<unknown, Record<string, number>>();
	private readonly idField: string;
	private readonly policy: RemoteChangePolicy;

	constructor(sheet: SheetDef, rows: Row[], private readonly options: EngineOptions = {}) {
		this.sheet = sheet;
		this.idField = idFieldOf(sheet);
		this.policy = options.policy ?? 'merge';
		let max = 0;
		for (const row of rows) {
			const fromId = Number(String(row[this.idField]).match(/(\d+)$/)?.[1]);
			if (!isNaN(fromId)) max = Math.max(max, fromId);
		}
		this.replaceRows(rows, max + 1);
	}

	/** Reemplaza el contenido completo: se usa para resembrar, no en producción. */
	replaceRows(rows: Row[], nextIndex?: number): void {
		this.rows = rows;
		this.byId = new Map(rows.map((r) => [r[this.idField], r]));
		this.fieldVersions.clear();
		if (nextIndex !== undefined) this.nextIndex = nextIndex;
		this.version++;
		this.views.clear();
	}

	get total(): number {
		return this.rows.length;
	}

	// -- lectura -------------------------------------------------------------

	private fieldNames = () => Object.keys(this.sheet.fields);

	private view(query: ListQuery): { rows: Row[]; key: string } {
		const key = JSON.stringify([query.sort, query.filters, query.search]);
		const cached = this.views.get(key);
		if (cached?.version === this.version) return { rows: cached.rows, key };

		const needle = normalizeForSearch((query.search ?? '').trim());
		const searchFields = this.fieldNames().filter((f) => this.sheet.fields[f].kind === 'text');
		const filters = Object.entries(query.filters ?? {})
			.map(([field, values]) => [field, new Set(values)] as const)
			.filter(([, set]) => set.size > 0);

		let rows = this.rows.filter((row) => {
			for (const [field, values] of filters) {
				if (!values.has(String(row[field] ?? ''))) return false;
			}
			if (needle === '') return true;
			const hay = [...searchFields.map((f) => row[f]), row[this.idField]].join(' ');
			return normalizeForSearch(String(hay)).includes(needle);
		});

		/*
			El orden **siempre** termina en el id. Sin desempate, dos filas con el
			mismo valor pueden intercambiarse entre dos consultas y una fila
			aparecer en dos páginas —o en ninguna— al paginar.
		*/
		const sort = query.sort;
		if (sort) {
			const dir = sort.dir === 'asc' ? 1 : -1;
			const numeric = this.sheet.fields[sort.field]?.kind === 'number';
			rows = rows.sort((a, b) => {
				const va = a[sort.field];
				const vb = b[sort.field];
				if (va == null && vb != null) return 1;
				if (vb == null && va != null) return -1;
				if (va != null && vb != null && va !== vb) {
					const cmp = numeric ? Number(va) - Number(vb) : collator.compare(String(va), String(vb));
					if (cmp !== 0) return cmp * dir;
				}
				const ai = String(a[this.idField]);
				const bi = String(b[this.idField]);
				return ai < bi ? -1 : ai > bi ? 1 : 0;
			});
		}

		this.views.set(key, { version: this.version, rows });
		return { rows, key };
	}

	list(query: ListQuery): PageResult<Row> & { offset: number; limit: number } {
		const { rows } = this.view(query);
		return {
			rows: rows.slice(query.offset, query.offset + query.limit),
			total: rows.length,
			offset: query.offset,
			limit: query.limit,
			version: this.version
		};
	}

	byIdOrThrow(id: unknown): Row {
		const row = this.byId.get(id);
		if (!row) throw new NotFoundError(`No existe la fila ${String(id)}`);
		return row;
	}

	/** Posición global de una fila dentro de una consulta. `null` si no la incluye. */
	position(id: unknown, query: ListQuery): { id: unknown; position: number | null; total: number; version: number } {
		this.byIdOrThrow(id);
		const { rows, key } = this.view(query);
		const cached = this.views.get(key)!;
		if (!cached.position) cached.position = new Map(rows.map((r, i) => [r[this.idField], i]));
		return { id, position: cached.position.get(id) ?? null, total: rows.length, version: this.version };
	}

	/** Lo que el grid necesita antes de pintar: esquema, opciones y política. */
	catalogs() {
		return {
			sheet: this.sheet,
			remoteChanges: this.policy
		};
	}

	// -- guardado ------------------------------------------------------------

	/**
	 * Concurrencia por campo (G-14): compara el `from` de cada campo con el
	 * valor actual del servidor. Solo choca lo que de verdad cambiaron los dos.
	 * Los cambios ajenos en otros campos se conservan y se informan (`merge`) o
	 * rechazan (`strict`). Las bajas sobre filas editadas siempre chocan (G-16).
	 */
	batch(input: BatchRequest): BatchResponse<Row> {
		this.validateBatch(input);

		const result: BatchResponse<Row> = { created: [], updated: [], deleted: [], notices: [], conflicts: [] };
		const now = new Date().toISOString();

		for (const update of input.updates) {
			const row = this.byId.get(update.id);
			if (!row) {
				result.conflicts.push({ op: 'update', id: update.id, reason: 'not_found', remote: null });
				continue;
			}
			const fields = Object.entries(update.changes) as [string, { from: unknown; to: unknown }][];

			// Atajo: misma versión que leyó el cliente → nadie más tocó la fila.
			if (row.rowVersion !== update.rowVersion) {
				const clashes: FieldConflict[] = fields
					.filter(([field, change]) => !sameValue(row[field], change.from))
					.map(([field, change]) => ({ field, from: change.from, yours: change.to, remote: row[field] }));
				if (clashes.length > 0) {
					result.conflicts.push({ op: 'update', id: update.id, reason: 'field_conflict', fields: clashes, remote: { ...row } });
					continue;
				}
				if (this.policy === 'strict') {
					result.conflicts.push({ op: 'update', id: update.id, reason: 'version_mismatch', remote: { ...row } });
					continue;
				}
				const touched = new Set(fields.map(([field]) => field));
				const foreign = Object.entries(this.fieldVersions.get(update.id) ?? {}).filter(
					([field, version]) => version > update.rowVersion && !touched.has(field)
				);
				if (foreign.length > 0) result.notices.push({ id: update.id, fields: foreign.map(([f]) => f) });
			}

			this.writeFields(row, fields.map(([field, change]) => [field, change.to]), now);
			result.updated.push({ ...row });
		}

		const toDelete = new Set<unknown>();
		for (const del of input.deletes) {
			const row = this.byId.get(del.id);
			// Ya no existe: lo que el cliente quería ya ocurrió. No es un conflicto.
			if (!row) {
				result.deleted.push(del.id);
				continue;
			}
			if (row.rowVersion !== del.rowVersion) {
				result.conflicts.push({ op: 'delete', id: del.id, reason: 'version_mismatch', remote: { ...row } });
				continue;
			}
			toDelete.add(del.id);
			this.byId.delete(del.id);
			this.fieldVersions.delete(del.id);
			result.deleted.push(del.id);
		}
		if (toDelete.size > 0) this.rows = this.rows.filter((r) => !toDelete.has(r[this.idField]));

		for (const { key, values } of input.creates) {
			const index = this.nextIndex++;
			const row = {
				...(this.options.rowDefaults?.(index) ?? {}),
				[this.idField]: this.options.newId?.(index) ?? `row_${index}`,
				...values,
				rowVersion: 1,
			} as Row;
			this.rows.push(row);
			this.byId.set(row[this.idField], row);
			result.created.push({ key, row });
		}

		if (result.updated.length || result.deleted.length || result.created.length) this.version++;
		return result;
	}

	/** Escribe campos, sube la versión de la fila y anota en qué versión cambió cada campo. */
	private writeFields(row: Row, fields: [string, unknown][], now: string): void {
		row.rowVersion++;
		(row as Row & { updated_at?: string }).updated_at = now;
		const versions = this.fieldVersions.get(row[this.idField]) ?? {};
		for (const [field, value] of fields) {
			row[field] = value;
			versions[field] = row.rowVersion;
		}
		this.fieldVersions.set(row[this.idField], versions);
	}

	/** Lote mal formado: se rechaza entero, sin aplicar nada. */
	private validateBatch(input: BatchRequest): void {
		const problems: { path: string; message: string }[] = [];
		const seen = new Set<unknown>();
		const writable = new Set(writableFields(this.sheet));

		const checkValues = (path: string, values: Record<string, unknown>, baseRow?: Row) => {
			for (const [field, value] of Object.entries(values)) {
				if (!writable.has(field)) {
					problems.push({ path: `${path}.${field}`, message: 'No editable' });
					continue;
				}
				const spec = this.sheet.fields[field];
				const canonical = canonicalize(spec, value);
				// Un validador de fila necesita la fila completa, no solo el lote.
				const row = { ...(baseRow ?? {}), ...values } as Record<string, any>;
				const message = validateField(field, spec, canonical, row);
				if (message) problems.push({ path: `${path}.${field}`, message });
			}
		};

		input.updates.forEach((u, i) => {
			if (seen.has(u.id)) problems.push({ path: `updates[${i}].id`, message: 'Fila repetida en el lote' });
			seen.add(u.id);
			checkValues(
				`updates[${i}].changes`,
				Object.fromEntries(Object.entries(u.changes).map(([f, c]) => [f, c?.to])),
				this.byId.get(u.id)
			);
		});
		input.deletes.forEach((d, i) => {
			if (seen.has(d.id)) problems.push({ path: `deletes[${i}].id`, message: 'Fila repetida en el lote' });
			seen.add(d.id);
		});
		input.creates.forEach((c, i) => checkValues(`creates[${i}].values`, c.values));

		if (problems.length > 0) {
			throw new ValidationError('El lote tiene valores inválidos', problems);
		}
	}

	// -- utilidades de prueba (uso exclusivo de demos y tests) ---------------

	/**
	 * Simula a otro usuario editando: cambia `fields` de las filas y sube su
	 * versión. Usada por los tests E2E para provocar avisos y conflictos.
	 */
	mutateDirectly(id: unknown, fields: [string, unknown][]): void {
		const row = this.byIdOrThrow(id);
		this.writeFields(row, fields, new Date().toISOString());
		this.version++;
		this.views.clear();
	}
}
