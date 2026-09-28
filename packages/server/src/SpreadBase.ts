import { isBlank, sameValue, toSchema, validateValue } from '@spreadbase/core';
import type {
	BatchInput,
	BatchResult,
	CellValue,
	ChangeEvent,
	FieldConflict,
	ListQuery,
	Page,
	Position,
	Row,
	SheetDefinition,
	SheetSchema
} from '@spreadbase/core';
import { NotFoundError, ValidationError } from './errors.ts';
import type { SheetSource } from './source.ts';

type MaybePromise<T> = T | Promise<T>;

/** Lo que la app quiera pasar a sus handlers: el usuario, la petición… */
export type BatchContext = Record<string, unknown>;

/**
 * Escritura de dominio (SB-3). Si se da, SpreadBase la llama en lugar de
 * escribir la fuente directamente, **después** de validar y resolver la
 * concurrencia: el handler solo recibe lo que hay que aplicar.
 *
 * Deben devolver las filas resultantes con su nuevo `rowVersion`, en el mismo
 * orden en que las recibieron.
 */
export interface SheetHandlers {
	insertMany?: (items: { values: Record<string, CellValue> }[], ctx: BatchContext) => MaybePromise<Row[]>;
	updateMany?: (items: { id: string; values: Record<string, CellValue>; row: Row }[], ctx: BatchContext) => MaybePromise<Row[]>;
	deleteMany?: (items: { id: string; row: Row }[], ctx: BatchContext) => MaybePromise<void>;
}

export interface SpreadBaseOptions extends SheetDefinition {
	source: SheetSource;
	handlers?: SheetHandlers;
}

/**
 * Una hoja del lado del servidor: el motor de lectura por tramos y del lote
 * de guardado con concurrencia por campo. Vive en la capa de servicio; el
 * controlador y las rutas los pone la app (o `sheetRouter`).
 */
export class SpreadBase {
	readonly definition: SheetDefinition;
	readonly idField: string;
	private readonly source: SheetSource;
	private readonly handlers: SheetHandlers;
	private readonly listeners = new Set<(event: ChangeEvent) => void>();
	/** Los lotes se aplican de uno en uno: leer, comparar y escribir no se intercalan. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor({ source, handlers, ...definition }: SpreadBaseOptions) {
		if (Object.keys(definition.columns).length === 0) throw new Error(`La hoja ${definition.id} no tiene columnas`);
		this.definition = definition;
		this.idField = definition.idField ?? 'id';
		this.source = source;
		this.handlers = handlers ?? {};
		source.attach?.(definition);
	}

	get id(): string {
		return this.definition.id;
	}

	get policy() {
		return this.definition.policy ?? 'merge';
	}

	schema(): SheetSchema {
		return toSchema(this.definition);
	}

	// -- lectura --------------------------------------------------------------

	async list(query: ListQuery): Promise<Page> {
		return this.source.list(this.checkQuery(query));
	}

	async get(id: string): Promise<Row> {
		const row = await this.source.get(id);
		if (!row) throw new NotFoundError(`No existe la fila ${id}`);
		return row;
	}

	/**
	 * Posición global de una fila dentro de una consulta. Es lo que permite al
	 * cliente llevar a una fila que no está cargada. `null` si la consulta la excluye.
	 */
	async position(id: string, query: ListQuery): Promise<Position> {
		await this.get(id);
		const { position, total } = await this.source.position(id, this.checkQuery(query));
		return { id, position, total };
	}

	/** Filtros sobre columnas desconocidas se ignoran; ordenar por una desconocida es un error. */
	private checkQuery(query: ListQuery): ListQuery {
		const columns = this.definition.columns;
		if (query.sort && !(query.sort.field in columns)) {
			throw new ValidationError(`No se puede ordenar por "${query.sort.field}"`);
		}
		const filters = Object.fromEntries(Object.entries(query.filters).filter(([field]) => field in columns));
		return { ...query, filters };
	}

	// -- escritura ------------------------------------------------------------

	/** Recibe cada fila aplicada (SB-8). Devuelve la función para dejar de escuchar. */
	subscribe(listener: (event: ChangeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Aplica un lote de altas, cambios y bajas.
	 *
	 * **Dos niveles de rechazo, deliberadamente distintos:**
	 * - Un lote **mal formado** —campo inexistente, valor inválido, campo no
	 *   editable— se rechaza entero con 400 y no se aplica nada.
	 * - Una fila **en conflicto** —otro usuario la cambió o la eliminó— se
	 *   devuelve en `conflicts` y **el resto del lote se aplica** (G-11).
	 */
	batch(input: BatchInput, ctx: BatchContext = {}): Promise<BatchResult> {
		const run = this.queue.then(() => this.applyBatch(input, ctx));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async applyBatch(input: BatchInput, ctx: BatchContext): Promise<BatchResult> {
		await this.validateBatch(input);

		const result: BatchResult = { created: [], updated: [], deleted: [], notices: [], conflicts: [] };
		const events: ChangeEvent[] = [];

		// -- ediciones: concurrencia por campo (G-14) y política (G-15)
		const toUpdate: { id: string; values: Record<string, CellValue>; row: Row }[] = [];
		for (const { id, rowVersion, changes } of input.updates) {
			const row = await this.source.get(id);
			if (!row) {
				result.conflicts.push({ op: 'update', id, reason: 'not_found', remote: null });
				continue;
			}
			const fields = Object.entries(changes);

			// Atajo: misma versión que leyó el cliente → nadie más tocó la fila.
			if (row.rowVersion !== rowVersion) {
				const clashes: FieldConflict[] = fields
					.filter(([field, change]) => !sameValue(row[field], change.from))
					.map(([field, change]) => ({ field, from: change.from, yours: change.to, remote: row[field] }));
				if (clashes.length > 0) {
					result.conflicts.push({ op: 'update', id, reason: 'field_conflict', fields: clashes, remote: { ...row } });
					continue;
				}
				if (this.policy === 'strict') {
					result.conflicts.push({ op: 'update', id, reason: 'version_mismatch', remote: { ...row } });
					continue;
				}
				const touched = new Set(fields.map(([field]) => field));
				const foreign = (await this.source.changedFieldsSince(id, rowVersion)).filter((f) => !touched.has(f));
				if (foreign.length > 0) result.notices.push({ id, fields: foreign });
			}
			toUpdate.push({ id, values: Object.fromEntries(fields.map(([field, change]) => [field, change.to])), row });
		}

		// -- bajas: eliminar lo que otro editó es siempre conflicto (G-16)
		const toDelete: { id: string; row: Row }[] = [];
		for (const { id, rowVersion } of input.deletes) {
			const row = await this.source.get(id);
			// Ya no existe: lo que el cliente quería ya ocurrió. No es un conflicto.
			if (!row) {
				result.deleted.push(id);
				continue;
			}
			if (row.rowVersion !== rowVersion) {
				result.conflicts.push({ op: 'delete', id, reason: 'version_mismatch', remote: { ...row } });
				continue;
			}
			toDelete.push({ id, row });
		}

		// -- aplicar: los handlers de dominio si los hay; si no, la fuente
		const updated = this.handlers.updateMany
			? await this.handlers.updateMany(toUpdate, ctx)
			: await Promise.all(toUpdate.map((u) => this.source.update(u.id, u.values)));
		updated.forEach((row, i) => {
			result.updated.push({ ...row });
			events.push({ sheet: this.id, op: 'update', id: toUpdate[i]!.id, fields: Object.keys(toUpdate[i]!.values), rowVersion: row.rowVersion });
		});

		if (this.handlers.deleteMany) await this.handlers.deleteMany(toDelete, ctx);
		else for (const d of toDelete) await this.source.remove(d.id);
		for (const d of toDelete) {
			result.deleted.push(d.id);
			events.push({ sheet: this.id, op: 'delete', id: d.id, fields: [], rowVersion: null });
		}

		const toInsert = input.creates.map((c) => ({ values: c.values }));
		const created = this.handlers.insertMany
			? await this.handlers.insertMany(toInsert, ctx)
			: await Promise.all(toInsert.map((c) => this.source.insert(c.values)));
		created.forEach((row, i) => {
			result.created.push({ key: input.creates[i]!.key, row: { ...row } });
			events.push({ sheet: this.id, op: 'create', id: String(row[this.idField]), fields: Object.keys(input.creates[i]!.values), rowVersion: row.rowVersion });
		});

		for (const event of events) for (const listener of this.listeners) listener(event);
		return result;
	}

	private async validateBatch(input: BatchInput): Promise<void> {
		const problems: { path: string; message: string }[] = [];
		const seen = new Set<string>();
		const columns = this.definition.columns;

		const check = (path: string, values: Record<string, unknown>, row: Record<string, unknown>) => {
			for (const [field, value] of Object.entries(values)) {
				const spec = columns[field];
				const message = !spec
					? 'Campo inexistente'
					: spec.readOnly || field === this.idField
						? 'Campo de solo lectura'
						: (validateValue(spec, value) ?? spec.validate?.(value as CellValue, row) ?? null);
				if (message) problems.push({ path: `${path}.${field}`, message });
			}
		};

		for (const [i, u] of input.updates.entries()) {
			if (seen.has(u.id)) problems.push({ path: `updates[${i}].id`, message: 'Fila repetida en el lote' });
			seen.add(u.id);
			const targets = Object.fromEntries(Object.entries(u.changes).map(([f, c]) => [f, c?.to]));
			const current = (await this.source.get(u.id)) ?? {};
			check(`updates[${i}].changes`, targets, { ...current, ...targets });
		}
		input.deletes.forEach((d, i) => {
			if (seen.has(d.id)) problems.push({ path: `deletes[${i}].id`, message: 'Fila repetida en el lote' });
			seen.add(d.id);
		});
		if (input.creates.length > 0 && !this.definition.allowInsert) {
			problems.push({ path: 'creates', message: 'La hoja no admite altas' });
		}
		if (input.deletes.length > 0 && !this.definition.allowDelete) {
			problems.push({ path: 'deletes', message: 'La hoja no admite bajas' });
		}
		input.creates.forEach((c, i) => {
			check(`creates[${i}].values`, c.values, c.values);
			for (const [field, spec] of Object.entries(columns)) {
				if (spec.required && field !== this.idField && !spec.readOnly && isBlank(c.values[field]) && spec.defaultValue == null) {
					problems.push({ path: `creates[${i}].values.${field}`, message: 'Obligatorio' });
				}
			}
		});

		if (problems.length > 0) throw new ValidationError('El lote tiene valores inválidos', problems);
	}
}
