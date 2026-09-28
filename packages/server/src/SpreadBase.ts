import { createHash } from 'node:crypto';
import { PASSWORD_MARK, fold, isBlank, isPasswordMark, sameValue, toSchema, validateValue } from '@spreadbase/core';
import type {
	BatchInput,
	BatchResult,
	CellValue,
	ChangeEvent,
	FieldConflict,
	ListQuery,
	LookupQuery,
	LookupResult,
	LookupSpec,
	Page,
	Position,
	ResolveResult,
	Row,
	SheetDefinition,
	SheetSchema
} from '@spreadbase/core';
import { NotFoundError, SpreadBaseError, ValidationError } from './errors.ts';
import type { IdempotencyStore, SheetSource, SheetTx } from './source.ts';

type MaybePromise<T> = T | Promise<T>;

/**
 * Lo que reciben los handlers: el contexto que pase la app (el usuario, la
 * petición…) y, si la fuente es transaccional, `tx`, la transacción del lote.
 */
export type BatchContext = Record<string, unknown> & { tx?: SheetTx };

/**
 * Escritura de dominio (SB-3). Si se da, SpreadBase la llama en lugar de
 * escribir la fuente directamente, **después** de validar y resolver la
 * concurrencia: el handler solo recibe lo que hay que aplicar. Con una fuente
 * transaccional, escribe con `ctx.tx.db` dentro de la misma transacción; si
 * lanza, el lote entero se deshace (SB-20).
 *
 * `insertMany` y `updateMany` devuelven las filas resultantes, en el mismo
 * orden en que las recibieron. El `rowVersion` lo pone la fuente: si la fila
 * devuelta no lo trae, el motor la vuelve a leer.
 */
export interface SheetHandlers {
	insertMany?: (items: { values: Record<string, CellValue> }[], ctx: BatchContext) => MaybePromise<Record<string, unknown>[]>;
	updateMany?: (
		items: { id: string; values: Record<string, CellValue>; row: Row }[],
		ctx: BatchContext
	) => MaybePromise<Record<string, unknown>[]>;
	deleteMany?: (items: { id: string; row: Row }[], ctx: BatchContext) => MaybePromise<void>;
}

export interface SpreadBaseOptions extends SheetDefinition {
	source: SheetSource;
	handlers?: SheetHandlers;
}

export interface BatchOptions {
	/** Contexto para los handlers: el usuario, la petición… */
	context?: Record<string, unknown>;
	/** `Idempotency-Key` del cliente (SB-18). Sin ella, cada envío se aplica. */
	idempotencyKey?: string;
}

export interface BatchOutcome {
	result: BatchResult;
	/** La llave ya se había usado: es la respuesta guardada, no se aplicó nada. */
	replayed: boolean;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** Tope de textos por petición de `resolve`: el cliente parte en tramos. */
export const MAX_RESOLVE_TEXTS = 500;

/** Idempotencia en memoria, para fuentes sin transacción. */
function memoryIdempotency(): IdempotencyStore {
	const saved = new Map<string, { bodyHash: string; result: BatchResult; expires: number }>();
	return {
		get(key) {
			const hit = saved.get(key);
			if (hit && hit.expires < Date.now()) saved.delete(key);
			return saved.get(key);
		},
		put(key, bodyHash, result) {
			const now = Date.now();
			for (const [k, v] of saved) if (v.expires < now) saved.delete(k);
			saved.set(key, { bodyHash, result, expires: now + IDEMPOTENCY_TTL_MS });
		}
	};
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
	private readonly memoryStore = memoryIdempotency();
	/** Sin transacción, los lotes se aplican de uno en uno: leer, comparar y escribir no se intercalan. */
	private queue: Promise<unknown> = Promise.resolve();
	private readonly passwordFields: string[];

	constructor({ source, handlers, ...definition }: SpreadBaseOptions) {
		if (Object.keys(definition.columns).length === 0) throw new Error(`La hoja ${definition.id} no tiene columnas`);
		this.definition = definition;
		this.idField = definition.idField ?? 'id';
		this.source = source;
		this.handlers = handlers ?? {};
		// Una columna lookup a medias falla al arrancar, no en el primer uso.
		for (const [field, spec] of Object.entries(definition.columns)) {
			if (spec.type !== 'lookup') continue;
			const lookup = spec.lookup;
			if (!lookup?.value || !lookup.display || typeof lookup.search !== 'function' || typeof lookup.byIds !== 'function') {
				throw new Error(`La columna "${field}" (lookup) necesita lookup.value, lookup.display, lookup.search y lookup.byIds`);
			}
		}
		// Sin `hash`, una contraseña se guardaría en claro: no se arranca.
		for (const [field, spec] of Object.entries(definition.columns)) {
			if (spec.type === 'password' && typeof spec.hash !== 'function') {
				throw new Error(`La columna "${field}" (password) necesita hash(plain, ctx): nunca se guarda en claro`);
			}
		}
		const sortBy = definition.defaultSort?.field;
		if (sortBy && (!(sortBy in definition.columns) || definition.columns[sortBy]!.type === 'password')) {
			throw new Error(`defaultSort: no se puede ordenar por "${sortBy}"`);
		}
		this.passwordFields = Object.entries(definition.columns)
			.filter(([, spec]) => spec.type === 'password')
			.map(([field]) => field);
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

	/** Un tramo de filas. Con columnas `lookup`, trae el nombre de cada id en `labels` (SB-21). */
	async list(query: ListQuery, context: Record<string, unknown> = {}): Promise<Page> {
		const page = { ...(await this.source.list(this.checkQuery(query))) };
		page.rows = page.rows.map((row) => this.mask(row));
		const lookups = this.lookupFields();
		if (lookups.length === 0) return page;
		const labels: Record<string, Record<string, string>> = {};
		for (const [field, lookup] of lookups) {
			const ids = unique(page.rows.map((row) => row[field]));
			labels[field] = {};
			if (ids.length === 0) continue;
			for (const row of await lookup.byIds(ids, context)) {
				labels[field][String(row[lookup.value])] = String(row[lookup.display] ?? '');
			}
		}
		return { ...page, labels };
	}

	// -- lookup (SB-21) -------------------------------------------------------

	/** Un tramo del recurso de una columna `lookup`, para el popover. */
	async lookup(field: string, query: LookupQuery, context: Record<string, unknown> = {}): Promise<LookupResult> {
		const lookup = this.lookupOf(field);
		const { rows, total } = await lookup.search(query.q, { offset: query.offset, limit: query.limit }, context);
		return { rows, total: Number(total), offset: query.offset, limit: query.limit };
	}

	/**
	 * Texto pegado → filas que coinciden, por `display` (sin acentos ni
	 * mayúsculas) o por `value`. La app devuelve candidatas; el emparejado es de aquí.
	 */
	async resolve(field: string, texts: string[], context: Record<string, unknown> = {}): Promise<ResolveResult> {
		const lookup = this.lookupOf(field);
		if (!lookup.resolve) throw new SpreadBaseError(400, 'lookup_not_resolvable', `La columna "${field}" no resuelve texto pegado`);
		const wanted = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
		if (wanted.length > MAX_RESOLVE_TEXTS) throw new ValidationError(`Hasta ${MAX_RESOLVE_TEXTS} textos por petición`);
		const matches: ResolveResult['matches'] = Object.fromEntries(wanted.map((t) => [t, []]));
		if (wanted.length === 0) return { matches };

		const candidates = await lookup.resolve(wanted, context);
		for (const text of wanted) {
			const needle = fold(text);
			const byValue = candidates.filter((row) => String(row[lookup.value]) === text);
			// Un id exacto gana: pegar una exportación con ids no debe dar «ambiguo».
			matches[text] = byValue.length > 0 ? byValue : candidates.filter((row) => fold(String(row[lookup.display] ?? '')) === needle);
		}
		return { matches };
	}

	private lookupFields(): [string, LookupSpec][] {
		return Object.entries(this.definition.columns)
			.filter(([, spec]) => spec.type === 'lookup' && spec.lookup)
			.map(([field, spec]) => [field, spec.lookup!]);
	}

	private lookupOf(field: string): LookupSpec {
		const spec = this.definition.columns[field];
		if (!spec || spec.type !== 'lookup' || !spec.lookup) throw new NotFoundError(`"${field}" no es una columna lookup`);
		return spec.lookup;
	}

	async get(id: string): Promise<Row> {
		const row = await this.read(this.source, id);
		if (!row) throw new NotFoundError(`No existe la fila ${id}`);
		return row;
	}

	// -- contraseñas (SB-22) ----------------------------------------------------

	/**
	 * Lo guardado en una columna `password` nunca sale: se cambia por una marca
	 * opaca derivada de ello (otro hash, de un solo sentido). La marca cambia
	 * cuando cambia la contraseña, así que la concurrencia por campo sigue
	 * funcionando sin exponer nada. Lo hace el motor, no cada fuente: aunque una
	 * fuente o un handler devuelvan el hash, lo que sale ya va enmascarado.
	 */
	private mask<R extends Record<string, unknown>>(row: R): R {
		if (this.passwordFields.length === 0) return row;
		const out: Record<string, unknown> = { ...row };
		for (const field of this.passwordFields) {
			const stored = out[field];
			out[field] = isBlank(stored)
				? null
				: isPasswordMark(stored)
					? stored
					: // Con el id de la fila: dos filas con lo mismo guardado no dan la misma marca.
						PASSWORD_MARK +
						createHash('sha256').update(`${String(row[this.idField])}\u0000${String(stored)}`).digest('hex').slice(0, 16);
		}
		return out as R;
	}

	/** Una fila de la fuente, ya enmascarada. */
	private async read(source: SheetSource, id: string): Promise<Row | undefined> {
		const row = await source.get(id);
		return row ? this.mask(row) : undefined;
	}

	/** Cambia cada contraseña en claro por `hash(plain)`, justo antes de escribir. */
	private async hashPasswords(values: Record<string, CellValue>, ctx: BatchContext): Promise<void> {
		for (const field of this.passwordFields) {
			const plain = values[field];
			if (typeof plain === 'string' && plain !== '') values[field] = await this.definition.columns[field]!.hash!(plain, ctx);
		}
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

	/**
	 * Filtros sobre columnas desconocidas se ignoran; ordenar por una desconocida
	 * es un error. Sin orden pedido, el de la hoja (`defaultSort`).
	 */
	private checkQuery(input: ListQuery): ListQuery {
		const query = input.sort ? input : { ...input, sort: this.definition.defaultSort ?? null };
		const columns = this.definition.columns;
		if (query.sort && (!(query.sort.field in columns) || this.passwordFields.includes(query.sort.field))) {
			throw new ValidationError(`No se puede ordenar por "${query.sort.field}"`);
		}
		// Filtrar por una contraseña sería un oráculo para adivinar el hash: se ignora.
		const filters = Object.fromEntries(
			Object.entries(query.filters).filter(([field]) => field in columns && !this.passwordFields.includes(field))
		);
		return { ...query, filters };
	}

	// -- escritura ------------------------------------------------------------

	/** Recibe cada fila aplicada (SB-8), tras confirmar. Devuelve la función para dejar de escuchar. */
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
	 *
	 * Con una fuente transaccional, todo ocurre en una transacción: bloqueo,
	 * comparación, escritura e idempotencia. Si algo lanza, no queda nada escrito.
	 */
	async batch(input: BatchInput, options: BatchOptions = {}): Promise<BatchOutcome> {
		const key = options.idempotencyKey || undefined;
		if (key && key.length > 200) {
			throw new SpreadBaseError(400, 'invalid_idempotency_key', 'Idempotency-Key admite hasta 200 caracteres');
		}
		const bodyHash = key ? createHash('sha256').update(JSON.stringify(input)).digest('hex') : '';
		const context = options.context ?? {};

		const run = async (source: SheetSource, tx: SheetTx | undefined, store: IdempotencyStore) => {
			if (key) {
				const saved = await store.get(key);
				if (saved) {
					if (saved.bodyHash !== bodyHash) {
						throw new SpreadBaseError(422, 'idempotency_key_reused', 'Esta Idempotency-Key ya se usó con otro cuerpo');
					}
					return { result: saved.result, replayed: true, events: [] as ChangeEvent[] };
				}
			}
			const { result, events } = await this.applyBatch(input, { ...context, tx }, source, tx);
			if (key) await store.put(key, bodyHash, result);
			return { result, replayed: false, events };
		};

		let outcome: { result: BatchResult; replayed: boolean; events: ChangeEvent[] };
		if (this.source.transaction) {
			outcome = await this.source.transaction((tx) => run(tx, tx, tx.idempotency ?? this.memoryStore));
		} else {
			const queued = this.queue.then(() => run(this.source, undefined, this.memoryStore));
			this.queue = queued.catch(() => undefined);
			outcome = await queued;
		}

		// Los eventos salen después de confirmar: nadie se entera de algo que se deshizo.
		for (const event of outcome.events) for (const listener of this.listeners) listener(event);
		return { result: outcome.result, replayed: outcome.replayed };
	}

	private async applyBatch(
		input: BatchInput,
		ctx: BatchContext,
		source: SheetSource,
		tx: SheetTx | undefined
	): Promise<{ result: BatchResult; events: ChangeEvent[] }> {
		// Bloquear primero, en orden de id: dos lotes sobre las mismas filas no se esperan en círculo.
		if (tx) {
			const ids = [...new Set([...input.updates.map((u) => u.id), ...input.deletes.map((d) => d.id)])].sort();
			if (ids.length > 0) await tx.lock(ids);
		}

		await this.validateBatch(input, source, ctx);

		const result: BatchResult = { created: [], updated: [], deleted: [], notices: [], conflicts: [] };
		const events: ChangeEvent[] = [];
		const writable = this.writableFields();

		// -- ediciones: concurrencia por campo (G-14) y política (G-15)
		const toUpdate: { id: string; values: Record<string, CellValue>; row: Row }[] = [];
		for (const { id, rowVersion, changes, base } of input.updates) {
			const row = await this.read(source, id);
			if (!row) {
				result.conflicts.push({ op: 'update', id, reason: 'not_found', remote: null });
				continue;
			}
			const fields = Object.entries(changes);

			// Atajo: el testigo que leyó el cliente → nadie más tocó la fila.
			if (!sameVersion(row.rowVersion, rowVersion)) {
				// Conflicto solo si otro dejó el campo en un valor distinto del que lee el
				// cliente **y** del que quiere: si los dos quieren lo mismo, no hay nada que resolver.
				const clashes: FieldConflict[] = fields
					.filter(([field, change]) => !sameValue(row[field], change.from) && !sameValue(row[field], change.to))
					.map(([field, change]) => ({ field, from: change.from, yours: change.to, remote: row[field] }));
				if (clashes.length > 0) {
					result.conflicts.push({ op: 'update', id, reason: 'field_conflict', fields: clashes, remote: { ...row } });
					continue;
				}
				if (this.policy === 'strict') {
					result.conflicts.push({ op: 'update', id, reason: 'version_mismatch', remote: { ...row } });
					continue;
				}
				// Lo que el cliente leyó en los campos que no tocó y ya es otro: lo cambió otro usuario (SB-16).
				const touched = new Set(fields.map(([field]) => field));
				const foreign = Object.entries(base ?? {})
					.filter(([field, seen]) => writable.has(field) && !touched.has(field) && !sameValue(row[field], seen))
					.map(([field]) => field);
				if (foreign.length > 0) result.notices.push({ id, fields: foreign });
			}
			toUpdate.push({ id, values: Object.fromEntries(fields.map(([field, change]) => [field, change.to])), row });
		}

		// -- bajas: eliminar lo que otro editó es siempre conflicto (G-16)
		const toDelete: { id: string; row: Row }[] = [];
		for (const { id, rowVersion } of input.deletes) {
			const row = await this.read(source, id);
			// Ya no existe: lo que el cliente quería ya ocurrió. No es un conflicto.
			if (!row) {
				result.deleted.push(id);
				continue;
			}
			if (!sameVersion(row.rowVersion, rowVersion)) {
				result.conflicts.push({ op: 'delete', id, reason: 'version_mismatch', remote: { ...row } });
				continue;
			}
			toDelete.push({ id, row });
		}

		// -- aplicar: los handlers de dominio si los hay; si no, la fuente.
		// Las contraseñas llegan ya como hash: ni los handlers ni la fuente ven el texto en claro.
		for (const u of toUpdate) await this.hashPasswords(u.values, ctx);
		const updated = this.handlers.updateMany
			? await this.withVersions(source, await this.handlers.updateMany(toUpdate, ctx))
			: await sequential(toUpdate, (u) => source.update(u.id, u.values));
		updated.forEach((row, i) => {
			const u = toUpdate[i]!;
			result.updated.push(this.mask({ ...row }));
			events.push({ sheet: this.id, op: 'update', id: u.id, fields: Object.keys(u.values), rowVersion: row.rowVersion });
		});

		if (this.handlers.deleteMany) await this.handlers.deleteMany(toDelete, ctx);
		else await sequential(toDelete, (d) => source.remove(d.id));
		for (const d of toDelete) {
			result.deleted.push(d.id);
			events.push({ sheet: this.id, op: 'delete', id: d.id, fields: [], rowVersion: null });
		}

		const toInsert = input.creates.map((c) => ({ values: { ...c.values } }));
		for (const c of toInsert) await this.hashPasswords(c.values, ctx);
		const created = this.handlers.insertMany
			? await this.withVersions(source, await this.handlers.insertMany(toInsert, ctx))
			: await sequential(toInsert, (c) => source.insert(c.values));
		created.forEach((row, i) => {
			const c = input.creates[i]!;
			result.created.push({ key: c.key, row: this.mask({ ...row }) });
			events.push({ sheet: this.id, op: 'create', id: String(row[this.idField]), fields: Object.keys(c.values), rowVersion: row.rowVersion });
		});

		return { result, events };
	}

	/** Filas devueltas por un handler sin `rowVersion`: se vuelven a leer de la fuente, que lo calcula. */
	private async withVersions(source: SheetSource, rows: Record<string, unknown>[]): Promise<Row[]> {
		return sequential(rows, async (row) => {
			if (row.rowVersion !== undefined && row.rowVersion !== null) return row as Row;
			const fresh = await source.get(String(row[this.idField]));
			if (!fresh) throw new Error(`El handler devolvió la fila ${String(row[this.idField])}, pero la fuente no la encuentra`);
			return fresh;
		});
	}

	private writableFields(): Set<string> {
		return new Set(
			Object.entries(this.definition.columns)
				.filter(([field, spec]) => !spec.readOnly && field !== this.idField)
				.map(([field]) => field)
		);
	}

	private async validateBatch(input: BatchInput, source: SheetSource, ctx: BatchContext): Promise<void> {
		const problems: { path: string; message: string }[] = [];
		const seen = new Set<string>();
		const columns = this.definition.columns;
		/** Por columna lookup: id → rutas donde aparece. Se comprueban todos juntos al final. */
		const lookupIds = new Map<string, Map<string, string[]>>();

		const check = (path: string, values: Record<string, unknown>, row: Record<string, unknown>) => {
			for (const [field, value] of Object.entries(values)) {
				const spec = columns[field];
				const message = !spec
					? 'Campo inexistente'
					: spec.readOnly || field === this.idField
						? 'Campo de solo lectura'
						: (validateValue(spec, value) ?? spec.validate?.(value as CellValue, row) ?? null);
				if (message) problems.push({ path: `${path}.${field}`, message });
				else if (spec?.type === 'lookup' && !isBlank(value)) {
					const ids = lookupIds.get(field) ?? new Map<string, string[]>();
					const paths = ids.get(String(value)) ?? [];
					paths.push(`${path}.${field}`);
					ids.set(String(value), paths);
					lookupIds.set(field, ids);
				}
			}
		};

		for (const [i, u] of input.updates.entries()) {
			if (seen.has(u.id)) problems.push({ path: `updates[${i}].id`, message: 'Fila repetida en el lote' });
			seen.add(u.id);
			const targets = Object.fromEntries(Object.entries(u.changes).map(([f, c]) => [f, c?.to]));
			const current = (await this.read(source, u.id)) ?? {};
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

		// Una sola consulta por columna lookup, con todos los ids del lote.
		for (const [field, ids] of lookupIds) {
			const lookup = columns[field]!.lookup!;
			const found = new Set((await lookup.byIds([...ids.keys()], ctx)).map((row) => String(row[lookup.value])));
			for (const [id, paths] of ids) {
				if (!found.has(id)) for (const path of paths) problems.push({ path, message: 'No corresponde a ningún registro' });
			}
		}

		if (problems.length > 0) throw new ValidationError('El lote tiene valores inválidos', problems);
	}
}

/** Ids distintos y no vacíos, como texto. */
const unique = (values: unknown[]): string[] => [...new Set(values.filter((v) => !isBlank(v)).map(String))];

/** Los testigos son opacos: se comparan como texto (`1` y `"1"` son el mismo). */
const sameVersion = (a: unknown, b: unknown) => a !== null && a !== undefined && String(a) === String(b);

/** Una conexión de base no admite consultas en paralelo dentro de una transacción. */
async function sequential<T, R>(items: T[], fn: (item: T) => MaybePromise<R>): Promise<R[]> {
	const out: R[] = [];
	for (const item of items) out.push(await fn(item));
	return out;
}
