/**
 * Kit de contrato de SpreadBase (SB-26).
 *
 * La concurrencia —conflicto por campo, `merge`/`strict`, bloqueo en la
 * transacción, idempotencia— es del motor y se prueba en SpreadBase una vez.
 * Lo que una app puede romper es **cómo conecta** cada hoja al motor: la
 * fuente (vista, `versionColumn`), los handlers, las rutas, los procesos que
 * escriben por fuera. Este kit corre contra una hoja de la app los casos
 * mínimos que lo demuestran, por HTTP, como dos usuarios:
 *
 * | Caso | Si falla, el módulo… |
 * |---|---|
 * | K-1 mismo campo → `field_conflict` | no detecta versiones (huella o `versionColumn`) |
 * | K-2 otro campo → se combina con aviso (`strict`: se rechaza) | su vista no trae una columna editable |
 * | K-3 eliminar lo editado → conflicto | sus bajas no respetan la versión |
 * | K-4 reintento con la misma llave → no duplica | sus rutas no pasan `Idempotency-Key` |
 * | K-5 otro proceso cambió la fila → conflicto | lo que escribe fuera de la hoja no mueve la versión |
 *
 * ```ts
 * import { edit, sheetContract } from '@spreadbase/testing';
 *
 * sheetContract({
 *   name: 'clientes',
 *   url: 'http://localhost:4000/api/customers/sheet',
 *   reset: () => fetch('…/dev/reset', { method: 'POST' }),
 *   edits: [edit.text('name'), edit.toggle('active')],
 *   external: (id, field) => pool.query(`UPDATE customers SET ${field} = … WHERE id = $1`, [id])
 * });
 * ```
 *
 * Registra un `describe` de Vitest; se llama en el nivel superior de un
 * archivo de prueba. Cada caso deja la hoja como la encontró (`reset`).
 */
import { beforeEach, describe, expect, it } from 'vitest';

type Json = Record<string, any>;
/** Quién edita: dos usuarios y un proceso externo. */
export type Actor = 'A' | 'B' | 'externo';

export interface Schema {
	idField: string;
	allowDelete: boolean;
	policy: 'merge' | 'strict';
	columns: Record<string, Json>;
}

/** Contexto que recibe un generador de valores. */
export interface EditContext {
	schema: Schema;
	/** GET relativo a la hoja (`/lookup/campo?q=`…), con las cabeceras del kit. */
	get: (path: string) => Promise<Json>;
}

/** Cómo cambiar un campo editable: un valor distinto del actual, y distinto por actor. */
export interface Edit {
	field: string;
	value: (row: Json, who: Actor, ctx: EditContext) => unknown | Promise<unknown>;
}

export interface SheetContractOptions {
	/** Nombre para el reporte («clientes», «catálogo de emisoras»…). */
	name: string;
	/** Base del protocolo de la hoja: la misma URL que `new Sheet(url)`. */
	url: string;
	/** Deja la hoja como la semilla. Corre antes de cada caso. */
	reset: () => unknown | Promise<unknown>;
	/**
	 * Dos campos editables. El **primero** lo editan los dos usuarios con
	 * valores distintos (un texto, una opción, un registro: no una casilla,
	 * que solo tiene un valor distinto). El segundo, uno solo.
	 */
	edits: [Edit, Edit];
	/** Qué fila usar, de la primera página. Default: la primera. */
	row?: (rows: Json[]) => Json | undefined;
	/**
	 * Otro proceso escribe en la fila **por fuera de la hoja** (un worker, SQL
	 * directo). Debe dejar `field` en un valor distinto del que tenía. Sin él,
	 * K-5 se omite.
	 */
	external?: (id: string, field: string) => unknown | Promise<unknown>;
	/** Cabeceras en cada petición (autenticación). */
	headers?: () => Record<string, string>;
}

/** Generadores de valores para `edits`, según el tipo de la columna. */
export const edit = {
	/** Texto: el actual con una marca del actor, dentro de `maxLength`. */
	text: (field: string): Edit => ({
		field,
		value: (row, who, { schema }) => {
			const max = schema.columns[field]?.maxLength ?? 200;
			const mark = ` (${who} ${Math.random().toString(36).slice(2, 6)})`;
			return `${String(row[field] ?? '').slice(0, Math.max(0, max - mark.length))}${mark}`;
		}
	}),
	/** Casilla: la contraria. Solo sirve como segundo campo. */
	toggle: (field: string): Edit => ({ field, value: (row) => !row[field] }),
	/** Lista (`select`): una opción distinta de la actual, y distinta por actor. */
	option: (field: string): Edit => ({
		field,
		value: (row, who, { schema }) => pick(schema.columns[field]?.options?.map((o: Json) => o.value) ?? [], row[field], who, field)
	}),
	/** Búsqueda (`lookup`): un registro distinto del actual, y distinto por actor. */
	lookup: (field: string): Edit => ({
		field,
		value: async (row, who, { schema, get }) => {
			const valueField = schema.columns[field]?.lookup?.value ?? 'id';
			const { rows } = await get(`/lookup/${encodeURIComponent(field)}?limit=10`);
			return pick((rows as Json[]).map((r) => r[valueField]), row[field], who, field);
		}
	}),
	/** Cualquier otro: la función decide el valor. */
	custom: (field: string, value: Edit['value']): Edit => ({ field, value })
};

/** Un valor de `candidates` distinto de `current`; A, B y el proceso externo toman uno distinto cada uno. */
function pick(candidates: unknown[], current: unknown, who: Actor, field: string): unknown {
	const others = candidates.filter((c) => String(c) !== String(current));
	const at = { A: 0, B: 1, externo: 2 }[who];
	if (others.length === 0) throw new Error(`sheetContract: «${field}» no tiene otro valor posible`);
	return others[Math.min(at, others.length - 1)];
}

export function sheetContract(options: SheetContractOptions): void {
	const base = options.url.replace(/\/+$/, '');
	const [a, b] = options.edits;

	async function request(path: string, init: { method?: string; body?: unknown; key?: string } = {}) {
		const res = await fetch(`${base}${path}`, {
			method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
			headers: {
				'content-type': 'application/json',
				...options.headers?.(),
				...(init.key ? { 'Idempotency-Key': init.key } : {})
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body)
		});
		const text = await res.text();
		return { status: res.status, body: (text ? JSON.parse(text) : null) as Json, replayed: res.headers.get('Idempotent-Replayed') === 'true' };
	}
	const get = async (path: string) => (await request(path)).body;
	const batch = (body: Json, key?: string) => request('/batch', { body, key });

	let schema: Schema;
	const ctx = (): EditContext => ({ schema, get });

	/** La fila del caso, recién leída. */
	async function target(): Promise<Json> {
		const { rows } = await get('?limit=50');
		const row = options.row ? options.row(rows) : rows[0];
		if (!row) throw new Error(`sheetContract(${options.name}): la hoja no tiene filas para probar`);
		return row;
	}
	const idOf = (row: Json) => String(row[schema.idField]);
	const reread = async (row: Json) => get(`/${encodeURIComponent(idOf(row))}`);

	/** Una edición como la manda `new Sheet(url)`: con `base`, lo que el usuario leyó en lo que no toca. */
	function update(row: Json, field: string, to: unknown) {
		const seen: Json = {};
		for (const [f, column] of Object.entries(schema.columns)) {
			if (f !== field && f !== schema.idField && !column.readOnly && f in row) seen[f] = row[f];
		}
		return { id: row[schema.idField], rowVersion: row.rowVersion, changes: { [field]: { from: row[field], to } }, base: seen };
	}

	describe(`contrato de la hoja · ${options.name}`, () => {
		beforeEach(async () => {
			await options.reset();
			schema = (await get('/schema')) as Schema;
		});

		it('K-1 · dos usuarios editan el mismo campo: el segundo recibe field_conflict y no pisa al primero', async () => {
			const row = await target();
			const mine = await a.value(row, 'B', ctx());
			const first = await batch({ updates: [update(row, a.field, mine)] });
			expect(first.status, JSON.stringify(first.body)).toBe(200);
			expect(first.body.updated).toHaveLength(1);

			const second = await batch({ updates: [update(row, a.field, await a.value(row, 'A', ctx()))] });
			expect(second.status).toBe(200);
			expect(second.body.conflicts).toHaveLength(1);
			expect(second.body.conflicts[0]).toMatchObject({ op: 'update', reason: 'field_conflict' });
			expect(second.body.conflicts[0].fields.map((f: Json) => f.field)).toEqual([a.field]);
			expect(String((await reread(row))[a.field])).toBe(String(mine));
		});

		it('K-2 · editan campos distintos: con merge se combinan y se avisa; con strict se rechaza', async () => {
			const row = await target();
			const theirs = await a.value(row, 'B', ctx());
			await batch({ updates: [update(row, a.field, theirs)] });

			const mine = await b.value(row, 'A', ctx());
			const res = await batch({ updates: [update(row, b.field, mine)] });
			expect(res.status).toBe(200);
			if (schema.policy === 'strict') {
				expect(res.body.conflicts[0]).toMatchObject({ op: 'update', reason: 'version_mismatch' });
				return;
			}
			expect(res.body.conflicts).toEqual([]);
			expect(res.body.updated).toHaveLength(1);
			// El aviso nombra lo que cambió el otro: la vista trae la columna.
			expect(res.body.notices).toEqual([{ id: row[schema.idField], fields: [a.field] }]);
			const now = await reread(row);
			expect(String(now[a.field])).toBe(String(theirs));
			expect(String(now[b.field])).toBe(String(mine));
		});

		it('K-3 · eliminar una fila que otro editó es conflicto y la fila sigue ahí', async (test) => {
			if (!schema.allowDelete) return test.skip();
			const row = await target();
			await batch({ updates: [update(row, a.field, await a.value(row, 'B', ctx()))] });
			const res = await batch({ deletes: [{ id: row[schema.idField], rowVersion: row.rowVersion }] });
			expect(res.status).toBe(200);
			expect(res.body.deleted).toEqual([]);
			expect(res.body.conflicts[0]).toMatchObject({ op: 'delete' });
			expect((await reread(row))[schema.idField]).toBe(row[schema.idField]);
		});

		it('K-4 · reintentar con la misma Idempotency-Key no aplica dos veces; otra petición con esa llave es 422', async () => {
			const row = await target();
			const key = `contract-${Math.random().toString(36).slice(2)}`;
			const body = { updates: [update(row, a.field, await a.value(row, 'A', ctx()))] };
			const first = await batch(body, key);
			expect(first.status, JSON.stringify(first.body)).toBe(200);
			const version = (await reread(row)).rowVersion;

			const again = await batch(body, key);
			expect(again.status).toBe(200);
			expect(again.replayed).toBe(true);
			expect(again.body).toEqual(first.body);
			expect((await reread(row)).rowVersion).toBe(version);

			const other = await batch({ updates: [update(row, b.field, await b.value(row, 'B', ctx()))] }, key);
			expect(other.status).toBe(422);
		});

		it('K-5 · otro proceso cambió el campo por fuera de la hoja: editarlo con lo leído antes es conflicto', async (test) => {
			if (!options.external) return test.skip();
			const row = await target();
			await options.external(idOf(row), a.field);
			const changed = await reread(row);
			expect(String(changed[a.field]), 'external() debe cambiar el campo').not.toBe(String(row[a.field]));
			expect(changed.rowVersion, 'lo escrito por fuera debe mover la versión').not.toBe(row.rowVersion);

			const res = await batch({ updates: [update(row, a.field, await a.value(row, 'A', ctx()))] });
			expect(res.body.conflicts[0]).toMatchObject({ op: 'update', reason: 'field_conflict' });
		});
	});
}
