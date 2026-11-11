import { createHash } from 'node:crypto';
import { filterKind, fold } from '@spreadbase/core';
import type { BatchResult, CellValue, ColumnFilter, ColumnType, DistinctValue, ListQuery, Page, Row, SheetDefinition } from '@spreadbase/core';
import type { IdempotencyStore, SheetSource, SheetTx } from './source.ts';

/*
	Lo mínimo del driver `mongodb`: la librería no depende de él (como `pg` en
	`postgresSource`), recibe el cliente o la base de la app. Solo se importa
	—diferido— para construir un `ObjectId` a partir de un id de texto.
*/
type Doc = Record<string, any>;
export interface MongoCollectionLike {
	aggregate(pipeline: Doc[], options?: any): { toArray(): Promise<Doc[]> };
	findOne(filter: Doc, options?: any): Promise<Doc | null>;
	countDocuments(filter: Doc, options?: any): Promise<number>;
	estimatedDocumentCount(options?: any): Promise<number>;
	insertOne(doc: Doc, options?: any): Promise<{ insertedId: unknown }>;
	updateOne(filter: Doc, update: Doc, options?: any): Promise<{ matchedCount: number }>;
	deleteOne(filter: Doc, options?: any): Promise<unknown>;
	deleteMany(filter: Doc, options?: any): Promise<unknown>;
	createIndex(spec: Doc, options?: any): Promise<unknown>;
}
export interface MongoDbLike {
	collection(name: string): MongoCollectionLike;
	/** El `Db` del driver lo trae: de ahí sale la sesión de la transacción. */
	readonly client?: MongoClientLike;
}
export interface MongoSessionLike {
	withTransaction<T>(fn: () => Promise<T>, options?: any): Promise<T>;
	endSession(): Promise<void>;
}
export interface MongoClientLike {
	db(name?: string): MongoDbLike;
	startSession(): MongoSessionLike;
}

export interface MongoSourceOptions {
	/** Cliente de `mongodb`. Con él y sin `db`, la base de la cadena de conexión. La conexión es de la app (SB-2). */
	client?: MongoClientLike;
	/** La base (`client.db('aggy')`) o su nombre (con `client`). */
	db?: MongoDbLike | string;
	/** Colección de los documentos de la hoja. */
	collection: string;
	/**
	 * Filtro fijo: la hoja es este subconjunto de la colección, p. ej.
	 * `{ accountId, dataTableId }` cuando muchas tablas comparten una colección.
	 * Toda lectura y escritura lo lleva, y los campos de igualdad (no los
	 * operadores `$in`, `$gt`…) se agregan a cada documento nuevo.
	 */
	filter?: Doc;
	/** Campo del documento que identifica la fila. Default: `_id`. Viaja siempre como texto. */
	idField?: string;
	/**
	 * Campo contador de versión. Sin él, `rowVersion` es una huella de los
	 * campos escribibles (SB-4). Con él, la fuente lo pone en 1 al crear y le
	 * suma 1 en cada escritura; **todo** proceso que escriba la colección debe
	 * hacer lo mismo (`$inc`), o sus cambios no se notarán.
	 */
	versionField?: string;
	/** Id de un documento nuevo cuando no hay handler. Sin él y con `_id`, lo pone el driver (`ObjectId`). */
	createId?: () => unknown;
	/**
	 * Collation para ordenar y comparar, p. ej. `{ locale: 'es', strength: 1 }`
	 * (sin acentos ni mayúsculas, como la fuente en memoria). Sin ella, por bytes.
	 */
	collation?: Doc;
	/** Colección de idempotencia (SB-18), con índice TTL. Default: `spreadbase_idempotency`. */
	idempotencyCollection?: string;
	/** Cuánto se guarda una respuesta idempotente. Default: 24 h. */
	idempotencyTtlHours?: number;
	/** Colección de los candados de fila (ver `lock`). Default: `spreadbase_locks`. */
	lockCollection?: string;
	/**
	 * Lotes en una transacción de Mongo (SB-19). Exige un replica set (uno de un
	 * solo nodo basta). Default: `true` si hay cliente. Con `false`, el motor
	 * aplica los lotes de uno en uno en el proceso, como en memoria.
	 */
	transactions?: boolean;
	/** Opciones de la transacción. Default: lectura `snapshot`, escritura `majority`. */
	transactionOptions?: Doc;
	/**
	 * Cuántas filas hay (SB-35). `exact` cuenta siempre. `auto` (default) usa
	 * `estimatedDocumentCount` —instantáneo, de los metadatos— solo cuando la
	 * consulta es la colección entera (sin filtro fijo ni de la persona) y pasa
	 * de `exactCountUpTo`. `estimate` lo hace siempre que la consulta es la
	 * colección entera. Con filtro, siempre exacto: la estimación es de toda la
	 * colección.
	 */
	count?: 'exact' | 'auto' | 'estimate';
	/** Con `count: 'auto'`, hasta cuántos documentos estimados se cuenta exacto. Default: 100 000. */
	exactCountUpTo?: number;
}

/** Mayúsculas y acentos que se pliegan, igual que `SQL_FOLD` de `postgresSource`. */
const FOLD_PAIRS: [string, string][] = [...'áéíóúüñàèìòùÁÉÍÓÚÜÑÀÈÌÒÙ'].map((c) => [c, fold(c)]);

/** Un ObjectId de texto: 24 hexadecimales. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ¿Un valor de BSON con tipo propio (ObjectId, Decimal128…)? */
const bsonType = (v: unknown): string | undefined =>
	typeof v === 'object' && v !== null ? ((v as { _bsontype?: string })._bsontype ?? undefined) : undefined;

const pad = (n: number) => String(n).padStart(2, '0');
const day = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/*
	Expresiones de agregación. Los filtros (SB-33) se evalúan con `$expr` para
	seguir la misma regla que `matchesFilter` de core —vacío = null, texto sin
	acentos ni mayúsculas, número como número aunque se guarde como texto,
	fecha-hora por su día—, venga como venga guardado cada valor.
*/
const ifNull = (e: unknown) => ({ $ifNull: [e, null] });
const toStr = (e: unknown) => ({ $convert: { input: e, to: 'string', onError: null, onNull: null } });
const toNum = (e: unknown) => ({ $convert: { input: e, to: 'double', onError: null, onNull: null } });
const isBlank = (e: unknown) => ({ $in: [ifNull(e), [null, '']] });
const notBlank = (e: unknown) => ({ $not: [isBlank(e)] });
/** Texto plegado: minúsculas y sin los acentos del español. */
const folded = (e: unknown) =>
	FOLD_PAIRS.reduce<unknown>((acc, [find, replacement]) => ({ $replaceAll: { input: acc, find, replacement } }), {
		$toLower: { $ifNull: [toStr(e), ''] }
	});
/** Un día `AAAA-MM-DD`, se guarde como `Date` o como texto. */
const dayOf = (e: unknown) => ({
	$cond: [{ $eq: [{ $type: e }, 'date'] }, { $dateToString: { format: '%Y-%m-%d', date: e, timezone: 'UTC' } }, { $substrCP: [{ $ifNull: [toStr(e), ''] }, 0, 10] }]
});

/** Valor con que se agrupa y compara una columna (`filterValueOf` de core). */
function filterValueExpr(e: unknown, type: ColumnType | undefined): unknown {
	const value = (() => {
		switch (type) {
			case 'number':
				return toNum(e);
			case 'date':
			case 'datetime':
				return dayOf(e);
			case 'boolean':
				return { $in: [e, [true, 'true']] };
			default:
				return toStr(e);
		}
	})();
	return { $cond: [isBlank(e), null, value] };
}

/**
 * Fuente sobre MongoDB.
 *
 * - **Sin requisitos en la colección** (SB-4): `rowVersion` es la huella md5
 *   de los campos escribibles, calculada al leer. Cualquier escritura la
 *   cambia, venga de donde venga. O un contador (`versionField`).
 * - **Una hoja puede ser parte de una colección** (`filter`): las tablas de
 *   una cuenta que comparten `datadocuments`.
 * - **Transaccional** (SB-19) con un replica set: cada lote corre en
 *   `session.withTransaction`; los handlers reciben la sesión en `ctx.tx.db`.
 *   Mongo no tiene `SELECT … FOR UPDATE`: `lock` escribe un candado por fila en
 *   `spreadbase_locks` dentro de la transacción. Dos lotes sobre la misma fila
 *   chocan al escribir el candado (`WriteConflict`) y el driver reintenta el
 *   segundo desde el principio, ya con lo que confirmó el primero. Como las
 *   lecturas de la transacción son de una foto fija, lo que otro proceso
 *   escriba en el documento después de esa foto también hace chocar la
 *   escritura y reintentar.
 * - **Idempotencia en la base** (SB-18), en la misma transacción, con un
 *   índice TTL que borra las respuestas vencidas.
 *
 * Exige MongoDB 4.4 o más (`$replaceAll` para plegar acentos en los filtros).
 */
export function mongoSource(options: MongoSourceOptions): SheetSource {
	const docId = options.idField ?? '_id';
	const fixed = options.filter ?? {};
	const countMode = options.count ?? 'auto';
	const exactCountUpTo = options.exactCountUpTo ?? 100_000;
	const ttlHours = options.idempotencyTtlHours ?? 24;
	const collation = options.collation ? { collation: options.collation } : {};

	const db: MongoDbLike = (() => {
		if (options.db && typeof options.db !== 'string') return options.db;
		if (!options.client) throw new Error('mongoSource: falta `client` o `db`');
		return options.client.db(typeof options.db === 'string' ? options.db : undefined);
	})();
	const client = options.client ?? db.client;
	const collection = db.collection(options.collection);
	const idempotency = db.collection(options.idempotencyCollection ?? 'spreadbase_idempotency');
	const locks = db.collection(options.lockCollection ?? 'spreadbase_locks');

	let definition: SheetDefinition | null = null;
	let idField = 'id';
	let ready: Promise<void> | null = null;
	let ObjectId: (new (hex: string) => unknown) | null = null;

	const def = () => {
		if (!definition) throw new Error('mongoSource: la fuente no está unida a una hoja (new SpreadBase({ source }))');
		return definition;
	};
	const columns = () => Object.entries(def().columns);
	const writable = () => columns().filter(([f, c]) => !c.readOnly && f !== idField).map(([f]) => f);
	const isColumn = (field: string) => field in def().columns;
	/** Ruta en el documento de un campo de la hoja: el id es `_id` (u `options.idField`). */
	const path = (field: string) => (field === idField ? docId : field);
	const ref = (field: string) => `$${path(field)}`;

	/** Los campos de igualdad del filtro fijo: los lleva cada documento nuevo. */
	const fixedValues = (): Doc =>
		Object.fromEntries(
			Object.entries(fixed).filter(([k, v]) => {
				if (k.startsWith('$')) return false;
				if (typeof v !== 'object' || v === null || v instanceof Date || bsonType(v)) return true;
				return !Object.keys(v).some((op) => op.startsWith('$'));
			})
		);

	/** El driver se carga la primera vez que hace falta un `ObjectId`. */
	async function objectId(): Promise<new (hex: string) => unknown> {
		if (!ObjectId) {
			try {
				ObjectId = (await import('mongodb')).ObjectId as unknown as new (hex: string) => unknown;
			} catch {
				throw new Error('mongoSource necesita el paquete `mongodb`: npm install mongodb');
			}
		}
		return ObjectId;
	}

	/** Filtro de un id de texto: un ObjectId de 24 hexadecimales también se busca como tal. */
	async function byId(id: string): Promise<Doc> {
		if (docId === '_id' && OBJECT_ID.test(id)) {
			const OID = await objectId();
			return { ...fixed, _id: { $in: [new OID(id), id] } };
		}
		return { ...fixed, [docId]: id };
	}

	/** Valor de BSON → el de JSON: ObjectId como texto, Decimal128 como número. */
	function plain(value: unknown): unknown {
		const kind = bsonType(value);
		if (kind === 'ObjectId' || kind === 'ObjectID') return String(value);
		if (kind === 'Decimal128' || kind === 'Long' || kind === 'Int32' || kind === 'Double') return Number(String(value));
		return value;
	}

	/**
	 * Un documento en el formato canónico del cliente: números como número,
	 * fecha `AAAA-MM-DD`, fecha-hora `AAAA-MM-DD HH:mm` (UTC si es `Date`). Leer
	 * otro formato haría que `from` y `base` no coincidieran con lo guardado.
	 */
	function toRow(doc: Doc): Row {
		const row: Row = { rowVersion: versionOf(doc) };
		for (const [field, spec] of columns()) {
			if (field === idField) {
				row[field] = String(plain(doc[docId]));
				continue;
			}
			const raw = plain(doc[field]);
			if (raw === undefined || raw === null) {
				row[field] = null;
				continue;
			}
			switch (spec.type) {
				case 'number':
					row[field] = raw === '' ? null : Number.isFinite(Number(raw)) ? Number(raw) : (raw as CellValue);
					break;
				case 'date':
					row[field] = raw instanceof Date ? day(raw) : raw === '' ? null : String(raw).slice(0, 10);
					break;
				case 'datetime':
					row[field] =
						raw instanceof Date
							? `${day(raw)} ${pad(raw.getUTCHours())}:${pad(raw.getUTCMinutes())}`
							: raw === ''
								? null
								: String(raw).replace('T', ' ').slice(0, 16);
					break;
				case 'boolean':
					row[field] = raw === true || raw === 'true';
					break;
				// Archivos (SB-38): se guardan como subdocumentos (`FILE`) o listas de ellos (`FOLDER`); una URL suelta (SB-30) sigue siendo texto.
				case 'file':
				case 'folder':
					row[field] = (Array.isArray(raw) ? raw.map(fileFromDoc) : typeof raw === 'object' ? fileFromDoc(raw) : String(raw)) as CellValue;
					break;
				default:
					row[field] = raw instanceof Date ? raw.toISOString() : (raw as CellValue);
			}
		}
		return row;
	}

	/** Un archivo guardado en un documento, con sus números de BSON como número (`tamano` puede llegar como Int32 o Long). */
	function fileFromDoc(value: unknown): unknown {
		if (typeof value !== 'object' || value === null) return value;
		return Object.fromEntries(Object.entries(value as Doc).filter(([k]) => k !== '_id').map(([k, v]) => [k, plain(v)]));
	}

	/** Huella md5 de los campos escribibles tal como están guardados, o el contador. */
	function versionOf(doc: Doc): string {
		if (options.versionField) return String(doc[options.versionField] ?? 0);
		const values = writable().map((f) => {
			const v = plain(doc[f]);
			return v instanceof Date ? { $date: v.toISOString() } : (v ?? null);
		});
		return createHash('md5').update(JSON.stringify(values)).digest('hex');
	}

	/** Un filtro de columna (SB-33) como expresión: la regla de `matchesFilter`. */
	function filterExpr(filter: ColumnFilter): unknown {
		if (!isColumn(filter.field)) return null;
		const e = ref(filter.field);
		const type = def().columns[filter.field]!.type;
		const kind = filterKind(type);
		switch (filter.op) {
			case 'empty':
				return isBlank(e);
			case 'not_empty':
				return notBlank(e);
			case 'in': {
				const values = filter.values ?? [];
				const present = values.filter((v) => v !== null);
				const value = filterValueExpr(e, type);
				const wanted =
					type === 'number'
						? present.map(Number)
						: type === 'boolean'
							? present.map((v) => v === true || v === 'true')
							: type === 'datetime'
								? present.map((v) => String(v).slice(0, 10))
								: present.map(String);
				const parts: unknown[] = [];
				if (wanted.length) parts.push({ $and: [notBlank(e), { $in: [value, wanted] }] });
				if (values.some((v) => v === null)) parts.push(isBlank(e));
				return parts.length ? { $or: parts } : false;
			}
		}
		if (kind === 'text') {
			const text = folded(e);
			const needle = fold(String(filter.value ?? ''));
			const regex = (pattern: string) => ({ $regexMatch: { input: text, regex: pattern } });
			const has = { $gte: [{ $indexOfCP: [text, needle] }, 0] };
			switch (filter.op) {
				case 'eq':
					return { $and: [notBlank(e), { $eq: [text, needle] }] };
				case 'ne':
					return { $or: [isBlank(e), { $ne: [text, needle] }] };
				case 'contains':
					return { $and: [notBlank(e), has] };
				case 'not_contains':
					return { $or: [isBlank(e), { $not: [has] }] };
				case 'starts':
					return { $and: [notBlank(e), regex(`^${escapeRegex(needle)}`)] };
				case 'ends':
					return { $and: [notBlank(e), regex(`${escapeRegex(needle)}$`)] };
				default:
					return false;
			}
		}
		// Número o fecha: se compara el valor tipado (la fecha-hora, por su día).
		const typed = kind === 'number' ? toNum(e) : dayOf(e);
		const v = (value: unknown) => (kind === 'number' ? Number(value) : String(value));
		const present = (cmp: unknown) => ({ $and: [notBlank(e), { $ne: [typed, null] }, cmp] });
		switch (filter.op) {
			case 'eq':
				return present({ $eq: [typed, v(filter.value)] });
			case 'ne':
				return { $or: [isBlank(e), { $ne: [typed, v(filter.value)] }] };
			case 'gt':
				return present({ $gt: [typed, v(filter.value)] });
			case 'gte':
				return present({ $gte: [typed, v(filter.value)] });
			case 'lt':
				return present({ $lt: [typed, v(filter.value)] });
			case 'lte':
				return present({ $lte: [typed, v(filter.value)] });
			case 'between':
				return present({ $and: [{ $gte: [typed, v(filter.value)] }, { $lte: [typed, v(filter.value2)] }] });
			default:
				return false;
		}
	}

	/** `$match` de la consulta: filtro fijo de la fuente, filtros fijos de la hoja (SB-28), filtros (SB-33) y búsqueda. */
	function match(query: ListQuery): Doc {
		const exprs: unknown[] = [];
		for (const [field, values] of Object.entries(query.filters)) {
			if (!isColumn(field) || values.length === 0) continue;
			exprs.push({ $in: [{ $ifNull: [toStr(ref(field)), ''] }, values] });
		}
		for (const filter of query.where ?? []) {
			const expr = filterExpr(filter);
			if (expr !== null) exprs.push(expr);
		}
		const needle = fold(query.search.trim());
		if (needle) {
			const marked = columns().filter(([, c]) => c.searchable).map(([f]) => f);
			const fields = marked.length ? marked : columns().filter(([, c]) => c.type === 'text').map(([f]) => f);
			const any = [idField, ...fields.filter((f) => f !== idField)].map((f) => ({ $gte: [{ $indexOfCP: [folded(ref(f)), needle] }, 0] }));
			exprs.push({ $or: any });
		}
		if (!exprs.length) return { ...fixed };
		// Un filtro fijo con su propio `$expr` no se pisa: se combinan con Y.
		return '$expr' in fixed ? { $and: [fixed, { $expr: { $and: exprs } }] } : { ...fixed, $expr: { $and: exprs } };
	}

	/** ¿La consulta es la colección entera? Solo entonces sirve la estimación de los metadatos. */
	const wholeCollection = (m: Doc) => Object.keys(m).length === 0;

	/**
	 * Llaves de orden y el orden. **Siempre** termina en el id, para paginar sin
	 * repetir ni saltar filas. Los vacíos van al final en ambos sentidos (como
	 * `NULLS LAST`); un número guardado como texto se ordena como número.
	 */
	function sortStages(query: ListQuery): { fields: Doc; sort: Doc } {
		if (!query.sort || !isColumn(query.sort.field)) return { fields: {}, sort: { [docId]: 1 } };
		const e = ref(query.sort.field);
		const type = def().columns[query.sort.field]?.type;
		const dir = query.sort.dir === 'desc' ? -1 : 1;
		return {
			fields: { __sb_blank: { $cond: [{ $eq: [ifNull(e), null] }, 1, 0] }, __sb_key: type === 'number' ? toNum(e) : e },
			sort: { __sb_blank: 1, __sb_key: dir, [docId]: 1 }
		};
	}

	/** Crea los índices de idempotencia y candados la primera vez (fuera de la transacción: Mongo no deja hacerlo dentro). */
	function ensureReady(): Promise<void> {
		ready ??= Promise.all([
			idempotency.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
			// Los candados solo valen dentro de una transacción: una hora después sobran.
			locks.createIndex({ at: 1 }, { expireAfterSeconds: 3600 })
		])
			.then(() => undefined)
			.catch((err) => {
				ready = null;
				throw err;
			});
		return ready;
	}

	/** Las operaciones, fuera o dentro de la sesión de una transacción. */
	function bind(session?: MongoSessionLike) {
		const opts = session ? { session } : {};

		/** Cuántos documentos da la consulta: exacto, o la estimación si es la colección entera y son muchos (SB-35). */
		async function countRows(m: Doc): Promise<number> {
			if (countMode !== 'exact' && wholeCollection(m)) {
				const estimate = await collection.estimatedDocumentCount();
				if (countMode === 'estimate' || estimate > exactCountUpTo) return estimate;
			}
			return collection.countDocuments(m, { ...opts, ...collation });
		}

		async function get(id: string): Promise<Row | undefined> {
			const doc = await collection.findOne(await byId(id), opts);
			return doc ? toRow(doc) : undefined;
		}

		const source: SheetSource = {
			attach(d) {
				definition = d;
				idField = d.idField ?? 'id';
			},

			async list(query): Promise<Page> {
				const m = match(query);
				const { fields, sort } = sortStages(query);
				const pipeline: Doc[] = [{ $match: m }];
				if (Object.keys(fields).length) pipeline.push({ $addFields: fields });
				pipeline.push({ $sort: sort }, { $skip: query.offset }, { $limit: query.limit });
				// En una transacción, una operación a la vez: la sesión no admite dos en paralelo.
				const docs = await collection.aggregate(pipeline, { ...opts, ...collation }).toArray();
				const counted = await countRows(m);
				// Una estimación se corrige con lo que se ve, como en `postgresSource`.
				const seen = query.offset + docs.length;
				const total = docs.length === 0 ? Math.min(counted, query.offset) : docs.length < query.limit ? seen : Math.max(counted, seen);
				return { rows: docs.map(toRow), total, offset: query.offset, limit: query.limit, version: 0 };
			},

			async position(id, query) {
				const m = match(query);
				const { fields, sort } = sortStages(query);
				const total = await collection.countDocuments(m, { ...opts, ...collation });
				const target = await byId(id);
				const keyed = (filter: Doc): Doc[] => (Object.keys(fields).length ? [{ $match: filter }, { $addFields: fields }] : [{ $match: filter }]);
				const [hit] = await collection.aggregate(keyed({ $and: [m, { [docId]: target[docId] }] }), { ...opts, ...collation }).toArray();
				// La consulta excluye la fila: solo hace falta el total.
				if (!hit) return { position: null, total };
				// Cuántas van antes en el mismo orden: vacío, llave (en su sentido) y id.
				const lit = (v: unknown) => ({ $literal: v ?? null });
				const byIdBefore = { $lt: [`$${docId}`, lit(hit[docId])] };
				const before = Object.keys(fields).length
					? {
							$or: [
								{ $lt: ['$__sb_blank', lit(hit.__sb_blank)] },
								{ $and: [{ $eq: ['$__sb_blank', lit(hit.__sb_blank)] }, { [sort.__sb_key === -1 ? '$gt' : '$lt']: ['$__sb_key', lit(hit.__sb_key)] }] },
								{ $and: [{ $eq: ['$__sb_blank', lit(hit.__sb_blank)] }, { $eq: ['$__sb_key', lit(hit.__sb_key)] }, byIdBefore] }
							]
						}
					: byIdBefore;
				const [counted] = await collection
					.aggregate([...keyed(m), { $match: { $expr: before } }, { $count: 'n' }], { ...opts, ...collation })
					.toArray();
				return { position: Number(counted?.n ?? 0), total };
			},

			get,

			async values(field, query, limit) {
				const type = def().columns[field]?.type;
				const docs = await collection
					.aggregate(
						[
							{ $match: match(query) },
							{ $group: { _id: filterValueExpr(ref(field), type), count: { $sum: 1 } } },
							// null primero; luego en el orden de la columna.
							{ $sort: { _id: 1 } },
							{ $limit: limit }
						],
						{ ...opts, ...collation }
					)
					.toArray();
				return docs.map((d) => ({ value: d._id ?? null, count: Number(d.count) })) as DistinctValue[];
			},

			async insert(values) {
				const doc: Doc = { ...fixedValues() };
				for (const [field, spec] of columns()) {
					if (field === idField) continue;
					if (field in values) doc[field] = values[field];
					else if (spec.defaultValue !== undefined && spec.defaultValue !== null) doc[field] = spec.defaultValue;
				}
				if (options.createId) doc[docId] = options.createId();
				else if (docId !== '_id') {
					if (values[idField] === undefined || values[idField] === null) throw new Error(`mongoSource: sin createId, una fila nueva necesita «${idField}»`);
					doc[docId] = values[idField];
				}
				if (options.versionField) doc[options.versionField] = 1;
				const { insertedId } = await collection.insertOne(doc, opts);
				const id = String(plain(docId === '_id' ? insertedId : doc[docId]));
				const row = await get(id);
				if (!row) throw new Error(`mongoSource: el documento creado ${id} no aparece con el filtro de la hoja`);
				return row;
			},

			async update(id, values: Record<string, CellValue>) {
				const fields = Object.keys(values).filter((f) => isColumn(f) && f !== idField);
				if (fields.length > 0) {
					const update: Doc = { $set: Object.fromEntries(fields.map((f) => [f, values[f]])) };
					if (options.versionField) update.$inc = { [options.versionField]: 1 };
					await collection.updateOne(await byId(id), update, opts);
				}
				const row = await get(id);
				if (!row) throw new Error(`mongoSource: el documento ${id} no aparece con el filtro de la hoja tras actualizarlo`);
				return row;
			},

			async remove(id) {
				await collection.deleteOne(await byId(id), opts);
			}
		};
		return source;
	}

	function idempotencyStore(session: MongoSessionLike): IdempotencyStore {
		const opts = { session };
		return {
			async get(key) {
				const doc = await idempotency.findOne({ _id: { sheet: def().id, key }, expiresAt: { $gt: new Date() } }, opts);
				return doc ? { bodyHash: String(doc.bodyHash), result: doc.response as BatchResult } : undefined;
			},
			async put(key, bodyHash, result) {
				// Una vencida que el TTL no ha borrado aún no debe chocar.
				await idempotency.deleteMany({ _id: { sheet: def().id, key }, expiresAt: { $lte: new Date() } }, opts);
				// insertOne a secas, a propósito: si otro reintento con la misma llave se
				// adelantó, choca y esta transacción se deshace; al reintentarla se
				// encuentra la respuesta guardada. Así un lote nunca se aplica dos veces.
				await idempotency.insertOne(
					{ _id: { sheet: def().id, key }, bodyHash, response: result, expiresAt: new Date(Date.now() + ttlHours * 3_600_000) },
					opts
				);
			}
		};
	}

	const root = bind();

	if (client && options.transactions !== false) {
		const transactionOptions = options.transactionOptions ?? { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } };
		const ours = [options.idempotencyCollection ?? 'spreadbase_idempotency', options.lockCollection ?? 'spreadbase_locks'];

		root.transaction = async <T>(fn: (tx: SheetTx) => Promise<T>): Promise<T> => {
			await ensureReady();
			// `withTransaction` reintenta solo ante errores transitorios (`WriteConflict`).
			// Un alta simultánea del mismo candado o de la misma llave puede llegar
			// como llave duplicada: también se reintenta, unas pocas veces.
			for (let attempt = 1; ; attempt++) {
				const session = client.startSession();
				try {
					return await session.withTransaction(
						() =>
							fn({
								...bind(session),
								db: session,
								idempotency: idempotencyStore(session),
								async lock(ids) {
									for (const id of ids) {
										await locks.updateOne({ _id: `${def().id}:${id}` }, { $set: { at: new Date() } }, { session, upsert: true });
									}
								}
							}),
						transactionOptions
					);
				} catch (error) {
					const e = error as { code?: number; message?: string };
					if (e.code === 11000 && attempt < 5 && ours.some((name) => e.message?.includes(name))) continue;
					if (e.code === 20 || /replica set/i.test(e.message ?? '')) {
						throw new Error(
							`mongoSource: las transacciones de Mongo exigen un replica set (uno de un solo nodo basta) o \`transactions: false\`. ${e.message ?? ''}`
						);
					}
					throw error;
				} finally {
					await session.endSession();
				}
			}
		};
	}

	return root;
}
