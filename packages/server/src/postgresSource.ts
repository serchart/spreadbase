import { filterKind } from '@spreadbase/core';
import type { BatchResult, CellValue, ColumnFilter, ColumnType, DistinctValue, ListQuery, Page, Row, SheetDefinition } from '@spreadbase/core';
import type { IdempotencyStore, SheetSource, SheetTx } from './source.ts';

/** Lo mínimo de `pg`: la librería no depende de él, recibe el pool de la app. */
export interface Queryable {
	query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface PoolLike extends Queryable {
	connect(): Promise<Queryable & { release(): void }>;
}

export interface PostgresSourceOptions {
	/** Pool de `pg` (u otro con `query` y `connect`). La conexión es de la app (SB-2). */
	pool: PoolLike;
	/** Tabla base: aquí se bloquea (`FOR UPDATE`) y se escribe cuando no hay handlers. */
	table: string;
	/** De dónde lee la hoja. Default: `table`. Útil para filtrar (borrado lógico) o unir tablas. */
	view?: string;
	/**
	 * Columna de versión que la tabla ya tenga (`updated_at`, `version`). Opcional: sin
	 * ella, `rowVersion` es una huella de las columnas escribibles (SB-4).
	 */
	versionColumn?: string;
	/** Id de una fila nueva cuando no hay handler. Sin él, lo pone la base (DEFAULT). */
	createId?: () => string;
	/** Tabla de idempotencia (SB-18). La crea la librería si no existe. Default: `spreadbase_idempotency`. */
	idempotencyTable?: string;
	/** Cuánto se guarda una respuesta idempotente. Default: 24 h. */
	idempotencyTtlHours?: number;
	/**
	 * Collation para ordenar las columnas de texto (`text`, `select`, `lookup`),
	 * p. ej. `es-x-icu`. Sin ella, la de la base: en imágenes con musl (alpine)
	 * ordena por bytes y «Óscar» queda después de «Zoe».
	 */
	collation?: string;
	/**
	 * Cuántas filas hay, para la barra de desplazamiento (SB-35). `exact` cuenta
	 * siempre (`count(*)`). `auto` (default) pregunta primero al planificador: si
	 * estima hasta `exactCountUpTo` filas, cuenta; si son más, devuelve la
	 * estimación. Contar 10 millones de filas en cada página tarda medio segundo;
	 * estimar, milisegundos. `estimate` estima siempre.
	 */
	count?: 'exact' | 'auto' | 'estimate';
	/** Con `count: 'auto'`, hasta cuántas filas estimadas se cuenta exacto. Default: 100 000. */
	exactCountUpTo?: number;
	/**
	 * Desde qué `offset` se pagina con una unión diferida (SB-35): primero los ids
	 * de la página (el salto recorre solo el índice) y luego sus filas. Saltar
	 * 5 millones de filas baja de segundos a décimas. Default: 2 000.
	 */
	deferredJoinFrom?: number;
}

/** `schema.tabla` → `"schema"."tabla"`, con comillas escapadas. */
const ident = (name: string) =>
	name
		.split('.')
		.map((part) => `"${part.replace(/"/g, '""')}"`)
		.join('.');

/** Minúsculas y sin acentos, en SQL; debe coincidir con `foldSearch` en JS. */
const SQL_FOLD = (expr: string) => `translate(lower(${expr}), 'áéíóúüñàèìòù', 'aeiouunaeiou')`;
const foldSearch = (s: string) =>
	s
		.toLowerCase()
		.replace(/[áà]/g, 'a')
		.replace(/[éè]/g, 'e')
		.replace(/[íì]/g, 'i')
		.replace(/[óò]/g, 'o')
		.replace(/[úùü]/g, 'u')
		.replace(/ñ/g, 'n');

/** Escapa `\`, `%` y `_` para usar un texto literal dentro de `LIKE`. */
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Cómo se agrupa y compara una columna en los filtros (SB-33), igual que
 * `filterValueOf` de core: número como número, fecha-hora por su día, texto
 * vacío como NULL.
 */
function filterExpr(col: string, type: ColumnType | undefined): string {
	switch (type) {
		case 'number':
			return `${col}::float8`;
		case 'date':
			return `${col}::text`;
		case 'datetime':
			return `${col}::date::text`;
		case 'boolean':
			return `${col}::text`;
		default:
			return `NULLIF(${col}::text, '')`;
	}
}

/**
 * Fuente sobre Postgres.
 *
 * - **Sin requisitos en la tabla** (SB-4): `rowVersion` es la huella md5 de las
 *   columnas escribibles, calculada en la misma consulta. Cualquier escritura
 *   la cambia, venga de donde venga.
 * - **Transaccional** (SB-19): cada lote corre en `BEGIN … COMMIT`, con las
 *   filas bloqueadas; los handlers reciben la conexión en `ctx.tx.db`.
 * - **Idempotencia en la base** (SB-18), en la misma transacción que el lote.
 */
export function postgresSource(options: PostgresSourceOptions): SheetSource {
	const table = ident(options.table);
	const view = ident(options.view ?? options.table);
	const idempotencyTable = ident(options.idempotencyTable ?? 'spreadbase_idempotency');
	const countMode = options.count ?? 'auto';
	const exactCountUpTo = options.exactCountUpTo ?? 100_000;
	const deferredJoinFrom = options.deferredJoinFrom ?? 2_000;
	const ttlHours = options.idempotencyTtlHours ?? 24;

	let definition: SheetDefinition | null = null;
	let idField = 'id';
	let ready: Promise<void> | null = null;

	const def = () => {
		if (!definition) throw new Error('postgresSource: la fuente no está unida a una hoja (new SpreadBase({ source }))');
		return definition;
	};
	const columns = () => Object.entries(def().columns);
	const writable = () => columns().filter(([f, c]) => !c.readOnly && f !== idField).map(([f]) => f);
	const isColumn = (field: string) => field in def().columns;

	/**
	 * Cómo se lee cada columna, en el formato canónico del cliente: números
	 * como número, fecha `AAAA-MM-DD`, fecha-hora `AAAA-MM-DD HH:mm` (en la zona
	 * de la sesión). Leer otro formato haría que `from` y `base` no coincidieran
	 * con lo guardado y daría conflictos y avisos falsos.
	 */
	function selectExpr(field: string): string {
		const col = ident(field);
		// El id viaja como texto (protocolo): una llave `integer` o `uuid` también.
		if (field === idField) return `${col}::text AS ${col}`;
		switch (def().columns[field]?.type) {
			case 'number':
				return `${col}::float8 AS ${col}`;
			case 'date':
				return `${col}::text AS ${col}`;
			case 'datetime':
				return `to_char(${col}, 'YYYY-MM-DD HH24:MI') AS ${col}`;
			default:
				return col;
		}
	}

	function versionExpr(): string {
		if (options.versionColumn) return `${ident(options.versionColumn)}::text`;
		const fields = writable();
		return fields.length ? `md5(jsonb_build_array(${fields.map(ident).join(', ')})::text)` : `'1'`;
	}

	const selectList = () => `${columns().map(([f]) => selectExpr(f)).join(', ')}, ${versionExpr()} AS "rowVersion"`;

	/**
	 * Un filtro de columna (SB-33) en SQL. La regla de referencia es
	 * `matchesFilter` de core (la usa la fuente en memoria): mismo trato de
	 * vacíos, acentos, mayúsculas y días.
	 */
	function filterClause(filter: ColumnFilter, param: (value: unknown) => string): string | null {
		if (!isColumn(filter.field)) return null;
		const col = ident(filter.field);
		const type = def().columns[filter.field]!.type;
		const kind = filterKind(type);
		const expr = filterExpr(col, type);
		const blank = `${expr} IS NULL`;
		switch (filter.op) {
			case 'empty':
				return blank;
			case 'not_empty':
				return `${expr} IS NOT NULL`;
			case 'in': {
				const values = filter.values ?? [];
				const present = values.filter((v) => v !== null).map((v) => (typeof v === 'number' ? String(Number(v)) : String(v)));
				const parts: string[] = [];
				if (present.length) parts.push(`${expr}::text = ANY(${param(present)})`);
				if (values.some((v) => v === null)) parts.push(blank);
				return parts.length ? `(${parts.join(' OR ')})` : 'false';
			}
		}
		if (kind === 'text') {
			const text = SQL_FOLD(`${col}::text`);
			const needle = foldSearch(String(filter.value ?? ''));
			const like = (pattern: string) => `${text} LIKE ${param(pattern)}`;
			switch (filter.op) {
				case 'eq':
					return `(${expr} IS NOT NULL AND ${text} = ${param(needle)})`;
				case 'ne':
					return `(${blank} OR ${text} <> ${param(needle)})`;
				case 'contains':
					return `(${expr} IS NOT NULL AND ${like(`%${likeLiteral(needle)}%`)})`;
				case 'not_contains':
					return `(${blank} OR NOT ${like(`%${likeLiteral(needle)}%`)})`;
				case 'starts':
					return `(${expr} IS NOT NULL AND ${like(`${likeLiteral(needle)}%`)})`;
				case 'ends':
					return `(${expr} IS NOT NULL AND ${like(`%${likeLiteral(needle)}`)})`;
				default:
					return 'false';
			}
		}
		// Número o fecha: se compara el valor tipado (la fecha-hora, por su día).
		const typed = kind === 'number' ? `${col}::numeric` : `${col}::date`;
		const cast = kind === 'number' ? 'numeric' : 'date';
		const v = (value: unknown) => `${param(String(value))}::${cast}`;
		switch (filter.op) {
			case 'eq':
				return `${typed} = ${v(filter.value)}`;
			case 'ne':
				return `(${col} IS NULL OR ${typed} <> ${v(filter.value)})`;
			case 'gt':
				return `${typed} > ${v(filter.value)}`;
			case 'gte':
				return `${typed} >= ${v(filter.value)}`;
			case 'lt':
				return `${typed} < ${v(filter.value)}`;
			case 'lte':
				return `${typed} <= ${v(filter.value)}`;
			case 'between':
				return `${typed} BETWEEN ${v(filter.value)} AND ${v(filter.value2)}`;
			default:
				return 'false';
		}
	}

	/** WHERE de filtros y búsqueda, con sus parámetros a partir de `start`. */
	function where(query: ListQuery, start = 1): { sql: string; params: unknown[] } {
		const clauses: string[] = [];
		const params: unknown[] = [];
		const param = (value: unknown) => {
			params.push(value);
			return `$${start + params.length - 1}`;
		};
		for (const [field, values] of Object.entries(query.filters)) {
			if (!isColumn(field) || values.length === 0) continue;
			params.push(values);
			clauses.push(`${ident(field)}::text = ANY($${start + params.length - 1})`);
		}
		for (const filter of query.where ?? []) {
			const clause = filterClause(filter, param);
			if (clause) clauses.push(clause);
		}
		const needle = foldSearch(query.search.trim());
		if (needle) {
			const marked = columns().filter(([, c]) => c.searchable).map(([f]) => f);
			const fields = marked.length ? marked : columns().filter(([, c]) => c.type === 'text').map(([f]) => f);
			params.push(`%${needle}%`);
			const p = `$${start + params.length - 1}`;
			const any = [idField, ...fields.filter((f) => f !== idField)].map((f) => `${SQL_FOLD(`${ident(f)}::text`)} LIKE ${p}`);
			clauses.push(`(${any.join(' OR ')})`);
		}
		return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
	}

	/** El orden **siempre** termina en el id, para paginar sin repetir ni saltar filas. */
	function orderBy(query: ListQuery): string {
		const id = ident(idField);
		if (!query.sort || !isColumn(query.sort.field)) return `ORDER BY ${view}.${id}`;
		const dir = query.sort.dir === 'desc' ? 'DESC' : 'ASC';
		const type = def().columns[query.sort.field]?.type;
		const textual = type === 'text' || type === 'select' || type === 'lookup';
		const collate = options.collation && textual ? ` COLLATE ${ident(options.collation)}` : '';
		// Calificada con la vista: un nombre suelto en ORDER BY es la columna de *salida*, y la
		// fecha-hora sale formateada a minuto (`selectExpr`): dos del mismo minuto empataban.
		return `ORDER BY ${view}.${ident(query.sort.field)}${collate} ${dir} NULLS LAST, ${view}.${id}`;
	}

	/** Crea la tabla de idempotencia la primera vez (SB-18). */
	function ensureReady(): Promise<void> {
		ready ??= options.pool
			.query(
				`CREATE TABLE IF NOT EXISTS ${idempotencyTable} (
					sheet      text NOT NULL,
					key        text NOT NULL,
					body_hash  text NOT NULL,
					response   jsonb NOT NULL,
					expires_at timestamptz NOT NULL,
					PRIMARY KEY (sheet, key)
				)`
			)
			.then(() => undefined)
			.catch((err) => {
				ready = null;
				throw err;
			});
		return ready;
	}

	/** Las operaciones, sobre el pool o sobre la conexión de una transacción. */
	function bind(db: Queryable) {
		/** Cuántas filas da la consulta: exacto, o la estimación del planificador si son muchas (SB-35). */
		async function countRows(w: { sql: string; params: unknown[] }): Promise<number> {
			if (countMode !== 'exact') {
				const { rows } = await db.query(`EXPLAIN (FORMAT JSON) SELECT 1 FROM ${view} ${w.sql}`, w.params);
				const plan = (rows[0]?.['QUERY PLAN'] as { Plan: { 'Plan Rows': number } }[] | undefined)?.[0]?.Plan;
				const estimate = Math.round(plan?.['Plan Rows'] ?? 0);
				if (countMode === 'estimate' || estimate > exactCountUpTo) return estimate;
			}
			const { rows } = await db.query(`SELECT count(*)::int AS total FROM ${view} ${w.sql}`, w.params);
			return Number(rows[0]?.total ?? 0);
		}

		async function get(id: string): Promise<Row | undefined> {
			try {
				const { rows } = await db.query(`SELECT ${selectList()} FROM ${view} WHERE ${ident(idField)} = $1`, [id]);
				return rows[0] as Row | undefined;
			} catch (err) {
				// Un id que no es del tipo de la llave («abc» en una `integer`) no existe: 404, no 500.
				if ((err as { code?: string }).code === '22P02') return undefined;
				throw err;
			}
		}

		const source: SheetSource = {
			attach(d) {
				definition = d;
				idField = d.idField ?? 'id';
			},

			async list(query): Promise<Page> {
				const w = where(query);
				const n = w.params.length;
				const order = orderBy(query);
				// Un salto hondo: los ids de la página primero (solo índice), luego sus filas (SB-35).
				const sql =
					query.offset >= deferredJoinFrom
						? `SELECT ${selectList()} FROM ${view} WHERE ${view}.${ident(idField)} IN (
								SELECT ${view}.${ident(idField)} FROM ${view} ${w.sql} ${order} LIMIT $${n + 1} OFFSET $${n + 2}
							) ${order}`
						: `SELECT ${selectList()} FROM ${view} ${w.sql} ${order} LIMIT $${n + 1} OFFSET $${n + 2}`;
				const [data, counted] = await Promise.all([db.query(sql, [...w.params, query.limit, query.offset]), countRows(w)]);
				// Una estimación se corrige con lo que se ve: una página incompleta es el final
				// (una vacía no dice dónde: se queda lo contado, sin pasar de donde se pidió).
				const seen = query.offset + data.rows.length;
				const total = data.rows.length === 0 ? Math.min(counted, query.offset) : data.rows.length < query.limit ? seen : Math.max(counted, seen);
				return {
					rows: data.rows as Row[],
					total,
					offset: query.offset,
					limit: query.limit,
					version: 0
				};
			},

			async position(id, query) {
				const w = where(query, 2);
				const { rows } = await db.query(
					`SELECT position, total FROM (
						SELECT ${ident(idField)} AS id, (row_number() OVER (${orderBy(query)}))::int - 1 AS position,
						       (count(*) OVER ())::int AS total
						FROM ${view} ${w.sql}
					) t WHERE id = $1`,
					[id, ...w.params]
				);
				if (rows[0]) return { position: Number(rows[0].position), total: Number(rows[0].total) };
				// La consulta excluye la fila: solo hace falta el total.
				const all = where(query);
				const count = await db.query(`SELECT count(*)::int AS total FROM ${view} ${all.sql}`, all.params);
				return { position: null, total: Number(count.rows[0]?.total ?? 0) };
			},

			get,

			async values(field, query, limit) {
				const w = where(query);
				const type = def().columns[field]?.type;
				const textual = type === 'text' || type === 'select' || type === 'lookup';
				const collate = options.collation && textual ? ` COLLATE ${ident(options.collation)}` : '';
				const { rows } = await db.query(
					`SELECT value, count FROM (
						SELECT ${filterExpr(ident(field), type)} AS value, count(*)::int AS count FROM ${view} ${w.sql} GROUP BY 1
					) v ORDER BY v.value${collate} NULLS FIRST LIMIT $${w.params.length + 1}`,
					[...w.params, limit]
				);
				return rows.map((r) => ({
					value: r.value === null ? null : type === 'number' ? Number(r.value) : type === 'boolean' ? r.value === 'true' : String(r.value),
					count: Number(r.count)
				})) as DistinctValue[];
			},

			async insert(values) {
				const fields = Object.keys(values).filter(isColumn);
				const params: unknown[] = fields.map((f) => values[f]);
				if (options.createId) {
					fields.unshift(idField);
					params.unshift(options.createId());
				}
				const sql = fields.length
					? `INSERT INTO ${table} (${fields.map(ident).join(', ')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})`
					: `INSERT INTO ${table} DEFAULT VALUES`;
				const { rows } = await db.query(`${sql} RETURNING ${ident(idField)} AS id`, params);
				const row = await get(String(rows[0]!.id));
				if (!row) throw new Error(`postgresSource: la fila creada ${String(rows[0]!.id)} no aparece en ${view}`);
				return row;
			},

			async update(id, values: Record<string, CellValue>) {
				const fields = Object.keys(values).filter(isColumn);
				if (fields.length > 0) {
					await db.query(`UPDATE ${table} SET ${fields.map((f, i) => `${ident(f)} = $${i + 2}`).join(', ')} WHERE ${ident(idField)} = $1`, [
						id,
						...fields.map((f) => values[f])
					]);
				}
				const row = await get(id);
				if (!row) throw new Error(`postgresSource: la fila ${id} no aparece en ${view} tras actualizarla`);
				return row;
			},

			async remove(id) {
				await db.query(`DELETE FROM ${table} WHERE ${ident(idField)} = $1`, [id]);
			}
		};
		return source;
	}

	function idempotencyStore(db: Queryable): IdempotencyStore {
		return {
			async get(key) {
				const { rows } = await db.query(
					`SELECT body_hash, response FROM ${idempotencyTable} WHERE sheet = $1 AND key = $2 AND expires_at > now()`,
					[def().id, key]
				);
				return rows[0] ? { bodyHash: String(rows[0].body_hash), result: rows[0].response as BatchResult } : undefined;
			},
			async put(key, bodyHash, result) {
				await db.query(`DELETE FROM ${idempotencyTable} WHERE sheet = $1 AND expires_at < now()`, [def().id]);
				// INSERT a secas, a propósito: si otro reintento con la misma llave se
				// adelantó, choca con la clave primaria y esta transacción se deshace
				// entera. Así un lote nunca se aplica dos veces.
				await db.query(
					`INSERT INTO ${idempotencyTable} (sheet, key, body_hash, response, expires_at)
					 VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
					[def().id, key, bodyHash, JSON.stringify(result), ttlHours]
				);
			}
		};
	}

	const root = bind(options.pool);

	root.transaction = async <T>(fn: (tx: SheetTx) => Promise<T>): Promise<T> => {
		await ensureReady();
		const client = await options.pool.connect();
		try {
			await client.query('BEGIN');
			const tx: SheetTx = {
				...bind(client),
				db: client,
				idempotency: idempotencyStore(client),
				async lock(ids) {
					await client.query(`SELECT 1 FROM ${table} WHERE ${ident(idField)} = ANY($1) ORDER BY ${ident(idField)} FOR UPDATE`, [ids]);
				}
			};
			const result = await fn(tx);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => undefined);
			// Alguien borró la tabla de idempotencia con el servidor en marcha: se recrea en el próximo lote.
			if ((error as { code?: string }).code === '42P01') ready = null;
			throw error;
		} finally {
			client.release();
		}
	};

	return root;
}
