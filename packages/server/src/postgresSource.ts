import type { BatchResult, CellValue, ListQuery, Page, Row, SheetDefinition } from '@spreadbase/core';
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

	/** WHERE de filtros y búsqueda, con sus parámetros a partir de `start`. */
	function where(query: ListQuery, start = 1): { sql: string; params: unknown[] } {
		const clauses: string[] = [];
		const params: unknown[] = [];
		for (const [field, values] of Object.entries(query.filters)) {
			if (!isColumn(field) || values.length === 0) continue;
			params.push(values);
			clauses.push(`${ident(field)}::text = ANY($${start + params.length - 1})`);
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
		if (!query.sort || !isColumn(query.sort.field)) return `ORDER BY ${id}`;
		const dir = query.sort.dir === 'desc' ? 'DESC' : 'ASC';
		const type = def().columns[query.sort.field]?.type;
		const textual = type === 'text' || type === 'select' || type === 'lookup';
		const collate = options.collation && textual ? ` COLLATE ${ident(options.collation)}` : '';
		return `ORDER BY ${ident(query.sort.field)}${collate} ${dir} NULLS LAST, ${id}`;
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
		async function get(id: string): Promise<Row | undefined> {
			const { rows } = await db.query(`SELECT ${selectList()} FROM ${view} WHERE ${ident(idField)} = $1`, [id]);
			return rows[0] as Row | undefined;
		}

		const source: SheetSource = {
			attach(d) {
				definition = d;
				idField = d.idField ?? 'id';
			},

			async list(query): Promise<Page> {
				const w = where(query);
				const n = w.params.length;
				const [data, count] = await Promise.all([
					db.query(`SELECT ${selectList()} FROM ${view} ${w.sql} ${orderBy(query)} LIMIT $${n + 1} OFFSET $${n + 2}`, [
						...w.params,
						query.limit,
						query.offset
					]),
					db.query(`SELECT count(*)::int AS total FROM ${view} ${w.sql}`, w.params)
				]);
				return {
					rows: data.rows as Row[],
					total: Number(count.rows[0]?.total ?? 0),
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
