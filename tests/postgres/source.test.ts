/**
 * `postgresSource` contra una base real (docs/02-fuentes-transacciones-handlers.md).
 *
 * El «otro usuario» escribe con SQL directo, como lo haría un worker o un
 * script: la concurrencia tiene que enterarse igual, sin triggers ni columnas
 * de versión (SB-4).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SpreadBase, parseBatch, postgresSource, types } from '@spreadbase/server';
import type { BatchInput, Row, SheetHandlers } from '@spreadbase/server';
import { createPool } from '../support/postgres.ts';

const pool = createPool();
const IDEMPOTENCY = 'sb_test_idempotency';

afterAll(async () => {
	await pool.end();
});

beforeEach(async () => {
	await pool.query(`
		DROP VIEW IF EXISTS sb_test_v_products;
		DROP TABLE IF EXISTS sb_test_products, sb_test_price_history, ${IDEMPOTENCY};
		CREATE TABLE sb_test_products (
			id         text PRIMARY KEY,
			name       text NOT NULL,
			sku        text NOT NULL,
			price      numeric(12, 2) NOT NULL,
			stock      integer NOT NULL DEFAULT 0,
			status     text NOT NULL DEFAULT 'draft',
			since      date,
			deleted_at timestamptz
		);
		CREATE VIEW sb_test_v_products AS
			SELECT id, name, sku, price, stock, status, since FROM sb_test_products WHERE deleted_at IS NULL;
		CREATE TABLE sb_test_price_history (product_id text, old_price numeric(12, 2), new_price numeric(12, 2), changed_by text);
		INSERT INTO sb_test_products (id, name, sku, price, stock, status, since) VALUES
			('p1', 'Camión Rojo',    'CAM-001', 1500.00, 3,  'active', '2024-01-15'),
			('p2', 'Grúa Azul',      'GRU-002', 2500.50, 0,  'draft',  '2024-02-01'),
			('p3', 'Tractor Verde',  'TRA-003', 1500.00, 10, 'active', NULL),
			('p4', 'Remolque Negro', 'REM-004', 800.00,  1,  'paused', '2023-12-31'),
			('p5', 'Montacargas',    'MON-005', 3200.00, 7,  'active', '2024-03-10');
	`);
});

const columns = {
	id: { type: types.TEXT, label: 'ID' },
	name: { type: types.TEXT, label: 'Nombre', required: true, searchable: true },
	sku: { type: types.TEXT, label: 'SKU', required: true, searchable: true },
	price: { type: types.NUMBER, label: 'Precio', required: true, min: 0 },
	// Lo mueve el inventario, no la hoja: de solo lectura.
	stock: { type: types.NUMBER, label: 'Existencias', readOnly: true },
	status: {
		type: types.SELECT,
		label: 'Estado',
		required: true,
		options: ['draft', 'active', 'paused'].map((v) => ({ value: v, label: v }))
	},
	since: { type: types.DATE, label: 'Desde' }
};

let seq = 100;
function sheet(opts: { policy?: 'merge' | 'strict'; handlers?: SheetHandlers; view?: boolean } = {}) {
	return new SpreadBase({
		id: 'products',
		allowInsert: true,
		allowDelete: true,
		policy: opts.policy,
		columns,
		source: postgresSource({
			pool,
			table: 'sb_test_products',
			view: opts.view ? 'sb_test_v_products' : undefined,
			idempotencyTable: IDEMPOTENCY,
			createId: () => `p${++seq}`
		}),
		handlers: opts.handlers
	});
}

const WRITABLE = ['name', 'sku', 'price', 'status', 'since'];
const query = (q: Partial<Parameters<SpreadBase['list']>[0]> = {}) => ({ offset: 0, limit: 100, sort: null, filters: {}, search: '', ...q });

/** Edición como la manda el cliente: `from`/`to` del campo y `base` con lo demás que leyó. */
const edit = (row: Row, field: string, to: unknown) => ({
	id: String(row.id),
	rowVersion: row.rowVersion,
	changes: { [field]: { from: row[field] as never, to: to as never } },
	base: Object.fromEntries(WRITABLE.filter((f) => f !== field).map((f) => [f, (row[f] ?? null) as never]))
});
const batch = (b: Partial<BatchInput>): BatchInput => ({ creates: [], updates: [], deletes: [], ...b });
const dbRow = async (id: string) => (await pool.query('SELECT * FROM sb_test_products WHERE id = $1', [id])).rows[0];

describe('lectura', () => {
	it('lista con tipos del protocolo: números como número, fechas como texto', async () => {
		const page = await sheet().list(query());
		expect(page.total).toBe(5);
		expect(page.rows.map((r) => r.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
		expect(page.rows[0]).toMatchObject({ name: 'Camión Rojo', price: 1500, stock: 3, since: '2024-01-15' });
		expect(page.rows[2]!.since).toBeNull();
		expect(page.rows[0]!.rowVersion).toMatch(/^[0-9a-f]{32}$/);
	});

	it('ordena con desempate por id y pagina sin repetir ni saltar', async () => {
		const s = sheet();
		const byPrice = await s.list(query({ sort: { field: 'price', dir: 'asc' } }));
		expect(byPrice.rows.map((r) => r.id)).toEqual(['p4', 'p1', 'p3', 'p2', 'p5']); // p1 y p3 empatan: por id
		const seen: string[] = [];
		for (let offset = 0; offset < 5; offset += 2) {
			const page = await s.list(query({ sort: { field: 'price', dir: 'desc' }, offset, limit: 2 }));
			seen.push(...page.rows.map((r) => String(r.id)));
		}
		expect(seen).toEqual(['p5', 'p2', 'p1', 'p3', 'p4']);
	});

	it('filtra por columna y busca sin distinguir acentos ni mayúsculas', async () => {
		const s = sheet();
		expect((await s.list(query({ filters: { status: ['active'] } }))).total).toBe(3);
		expect((await s.list(query({ search: 'camion' }))).rows.map((r) => r.id)).toEqual(['p1']);
		expect((await s.list(query({ search: 'GRUA' }))).rows.map((r) => r.id)).toEqual(['p2']);
		expect((await s.list(query({ search: 'tra-003' }))).rows.map((r) => r.id)).toEqual(['p3']);
	});

	it('da la posición de una fila en la consulta, o null si la excluye', async () => {
		const s = sheet();
		expect(await s.position('p3', query({ sort: { field: 'price', dir: 'asc' } }))).toEqual({ id: 'p3', position: 2, total: 5 });
		expect(await s.position('p2', query({ filters: { status: ['active'] } }))).toEqual({ id: 'p2', position: null, total: 3 });
	});

	it('la huella cambia con cualquier escritura en una columna escribible, venga de donde venga', async () => {
		const s = sheet();
		const before = (await s.get('p1')).rowVersion;
		await pool.query(`UPDATE sb_test_products SET name = 'Camión Rojo 2' WHERE id = 'p1'`);
		const after = (await s.get('p1')).rowVersion;
		expect(after).not.toBe(before);
		// Una de solo lectura (existencias) no cuenta: no es «otro usuario» (SB-16).
		await pool.query(`UPDATE sb_test_products SET stock = 99 WHERE id = 'p1'`);
		expect((await s.get('p1')).rowVersion).toBe(after);
	});

	it('una fila inexistente es 404', async () => {
		await expect(sheet().get('nada')).rejects.toMatchObject({ status: 404, code: 'not_found' });
	});
});

describe('tablas grandes (SB-35)', () => {
	// 150 000 filas: por encima del umbral de conteo exacto (100 000).
	const BIG = 'sb_test_big';
	const bigColumns = {
		id: { type: types.NUMBER, label: 'ID' },
		grupo: { type: types.TEXT, label: 'Grupo' },
		monto: { type: types.NUMBER, label: 'Monto' }
	};
	const big = (opts: { count?: 'exact' | 'auto' | 'estimate'; deferredJoinFrom?: number } = {}) =>
		new SpreadBase({ id: 'big', columns: bigColumns, source: postgresSource({ pool, table: BIG, ...opts }) });

	beforeEach(async () => {
		await pool.query(`
			DROP TABLE IF EXISTS ${BIG};
			CREATE TABLE ${BIG} (id int PRIMARY KEY, grupo text NOT NULL, monto numeric(12, 2) NOT NULL);
			INSERT INTO ${BIG} SELECT g, 'g' || (g % 7), (g * 37) % 1000 FROM generate_series(1, 150000) g;
			ANALYZE ${BIG};
		`);
	});
	afterAll(async () => {
		await pool.query(`DROP TABLE IF EXISTS ${BIG}`);
	});

	it('con muchas filas, el total es la estimación del planificador; con pocas, exacto', async () => {
		const estimated = (await big().list(query({ limit: 10 }))).total;
		expect(Math.abs(estimated - 150000) / 150000).toBeLessThan(0.1);
		expect((await big({ count: 'exact' }).list(query({ limit: 10 }))).total).toBe(150000);
		// Una tabla chica sigue contándose exacto (la de productos: 5).
		expect((await sheet().list(query())).total).toBe(5);
	});

	it('al llegar al final, el total deja de ser estimado: es lo que hay', async () => {
		const last = await big({ count: 'estimate' }).list(query({ offset: 149990, limit: 100 }));
		expect(last.rows).toHaveLength(10);
		expect(last.total).toBe(150000);
		// Pedir más allá del final no inventa filas: el total no pasa de lo contado.
		const beyond = await big({ count: 'exact' }).list(query({ offset: 400000, limit: 100 }));
		expect(beyond.rows).toHaveLength(0);
		expect(beyond.total).toBe(150000);
	});

	it('un salto hondo con unión diferida da las mismas filas que el OFFSET de siempre', async () => {
		const q = query({ sort: { field: 'monto', dir: 'desc' }, filters: { grupo: ['g3'] }, offset: 12000, limit: 50 });
		const plain = await big({ count: 'exact', deferredJoinFrom: Infinity }).list(q);
		const deferred = await big({ count: 'exact', deferredJoinFrom: 0 }).list(q);
		expect(deferred.rows.map((r) => r.id)).toEqual(plain.rows.map((r) => r.id));
		expect(deferred.rows).toHaveLength(50);
	});

	it('una llave integer viaja como texto: se ordena como número y el lote del cliente la edita', async () => {
		const s = new SpreadBase({ id: 'big', columns: { ...bigColumns, id: { ...bigColumns.id, readOnly: true } }, source: postgresSource({ pool, table: BIG }) });
		const { rows } = await s.list(query({ sort: { field: 'id', dir: 'asc' }, offset: 8, limit: 3 }));
		expect(rows.map((r) => r.id)).toEqual(['9', '10', '11']);
		// Lo que manda el cliente: el id y la huella tal como los leyó.
		const row = rows[1]!;
		const input = parseBatch({ updates: [{ id: row.id, rowVersion: row.rowVersion, changes: { monto: { from: row.monto, to: 1 } } }] });
		const { result } = await s.batch(input);
		expect(result.updated[0]).toMatchObject({ id: '10', monto: 1 });
		// Un id que no es número no existe (sin error de la base).
		await expect(s.get('abc')).rejects.toMatchObject({ status: 404, code: 'not_found' });
	});
});

describe('lote sin handlers: escribe la fuente', () => {
	it('edita, crea y elimina', async () => {
		const s = sheet();
		const p1 = await s.get('p1');
		const { result } = await s.batch(
			batch({
				updates: [edit(p1, 'price', 1750)],
				creates: [{ key: 'tmp_1', values: { name: 'Nuevo', sku: 'NEW-001', price: 10, status: 'draft' } }],
				deletes: [{ id: 'p4', rowVersion: (await s.get('p4')).rowVersion }]
			})
		);
		expect(result.conflicts).toEqual([]);
		expect(result.updated[0]).toMatchObject({ id: 'p1', price: 1750 });
		expect(result.updated[0]!.rowVersion).not.toBe(p1.rowVersion);
		expect(result.created[0]).toMatchObject({ key: 'tmp_1', row: { id: 'p101', name: 'Nuevo', price: 10 } });
		expect(result.deleted).toEqual(['p4']);
		expect(Number((await dbRow('p1')).price)).toBe(1750);
		expect(await dbRow('p4')).toBeUndefined();
	});

	it('un lote inválido no escribe nada', async () => {
		const s = sheet();
		const p1 = await s.get('p1');
		await expect(s.batch(batch({ updates: [edit(p1, 'price', 1), { ...edit(p1, 'stock', 5), id: 'p2' }] }))).rejects.toMatchObject({
			status: 400
		});
		expect(Number((await dbRow('p1')).price)).toBe(1500);
	});
});

describe('concurrencia contra escrituras externas', () => {
	it('mismo campo, valores distintos → field_conflict y no se escribe', async () => {
		const s = sheet();
		const mine = await s.get('p1');
		await pool.query(`UPDATE sb_test_products SET price = 1600 WHERE id = 'p1'`);
		const { result } = await s.batch(batch({ updates: [edit(mine, 'price', 1750)] }));
		expect(result.conflicts[0]).toMatchObject({
			id: 'p1',
			reason: 'field_conflict',
			fields: [{ field: 'price', from: 1500, yours: 1750, remote: 1600 }]
		});
		expect(Number((await dbRow('p1')).price)).toBe(1600);
	});

	it('mismo campo, mismo valor → se aplica (SB-17)', async () => {
		const s = sheet();
		const mine = await s.get('p1');
		await pool.query(`UPDATE sb_test_products SET price = 1750 WHERE id = 'p1'`);
		const { result } = await s.batch(batch({ updates: [edit(mine, 'price', 1750)] }));
		expect(result.conflicts).toEqual([]);
		expect(result.notices).toEqual([]);
	});

	it('otro campo, merge → se aplica, se conserva lo ajeno y se avisa desde base (SB-16)', async () => {
		const s = sheet();
		const mine = await s.get('p1');
		await pool.query(`UPDATE sb_test_products SET status = 'paused' WHERE id = 'p1'`);
		const { result } = await s.batch(batch({ updates: [edit(mine, 'price', 1750)] }));
		expect(result.conflicts).toEqual([]);
		expect(result.notices).toEqual([{ id: 'p1', fields: ['status'] }]);
		expect(result.updated[0]).toMatchObject({ price: 1750, status: 'paused' });
	});

	it('otro campo, strict → version_mismatch', async () => {
		const s = sheet({ policy: 'strict' });
		const mine = await s.get('p1');
		await pool.query(`UPDATE sb_test_products SET status = 'paused' WHERE id = 'p1'`);
		const { result } = await s.batch(batch({ updates: [edit(mine, 'price', 1750)] }));
		expect(result.conflicts[0]).toMatchObject({ id: 'p1', reason: 'version_mismatch' });
	});

	it('un cambio en una de solo lectura no es conflicto ni aviso', async () => {
		const s = sheet({ policy: 'strict' });
		const mine = await s.get('p1');
		await pool.query(`UPDATE sb_test_products SET stock = 50 WHERE id = 'p1'`);
		const { result } = await s.batch(batch({ updates: [edit(mine, 'price', 1750)] }));
		expect(result.conflicts).toEqual([]);
		expect(result.notices).toEqual([]);
	});

	it('bajas: eliminar lo editado es conflicto; lo eliminado se reporta; editar lo eliminado es not_found', async () => {
		const s = sheet();
		const p2 = await s.get('p2');
		const p3 = await s.get('p3');
		const p5 = await s.get('p5');
		await pool.query(`UPDATE sb_test_products SET name = 'Otra' WHERE id = 'p2'`);
		await pool.query(`DELETE FROM sb_test_products WHERE id IN ('p3', 'p5')`);
		const { result } = await s.batch(
			batch({
				deletes: [
					{ id: 'p2', rowVersion: p2.rowVersion },
					{ id: 'p3', rowVersion: p3.rowVersion }
				],
				updates: [edit(p5, 'price', 1)]
			})
		);
		expect(result.deleted).toEqual(['p3']);
		expect(result.conflicts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ op: 'delete', id: 'p2', reason: 'version_mismatch' }),
				expect.objectContaining({ op: 'update', id: 'p5', reason: 'not_found' })
			])
		);
		expect(await dbRow('p2')).toBeDefined();
	});

	it('dos lotes a la vez sobre la misma fila: el bloqueo los ordena y el segundo ve el conflicto', async () => {
		const s = sheet();
		const read = await s.get('p1');
		const [a, b] = await Promise.all([
			s.batch(batch({ updates: [edit(read, 'price', 1111)] })),
			s.batch(batch({ updates: [edit(read, 'price', 2222)] }))
		]);
		const applied = [a, b].filter((o) => o.result.updated.length === 1);
		const clashed = [a, b].filter((o) => o.result.conflicts.length === 1);
		expect(applied).toHaveLength(1);
		expect(clashed).toHaveLength(1);
		expect(Number((await dbRow('p1')).price)).toBe(applied[0]!.result.updated[0]!.price);
	});
});

describe('transacción y handlers (SB-19, SB-20)', () => {
	/** Handlers del ejemplo de la tienda: historial de precios y regla de activación. */
	const shop = (): SheetHandlers => ({
		updateMany: async (items, ctx) => {
			const db = ctx.tx!.db as import('pg').PoolClient;
			const out: Record<string, unknown>[] = [];
			for (const { id, values, row } of items) {
				if (values.status === 'active' && Number(row.stock) <= 0) throw new Error(`${row.name} no se puede activar sin existencias`);
				if ('price' in values) {
					await db.query('INSERT INTO sb_test_price_history VALUES ($1, $2, $3, $4)', [id, row.price, values.price, ctx.user]);
				}
				const fields = Object.keys(values);
				await db.query(`UPDATE sb_test_products SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE id = $1`, [
					id,
					...fields.map((f) => values[f])
				]);
				out.push({ id });
			}
			return out; // sin rowVersion: el motor relee la fila y la fuente pone la huella
		},
		deleteMany: async (items, ctx) => {
			const db = ctx.tx!.db as import('pg').PoolClient;
			await db.query('UPDATE sb_test_products SET deleted_at = now() WHERE id = ANY($1)', [items.map((i) => i.id)]);
		}
	});

	it('el handler escribe con la conexión de la transacción y recibe el contexto', async () => {
		const s = sheet({ handlers: shop(), view: true });
		const p1 = await s.get('p1');
		const { result } = await s.batch(batch({ updates: [edit(p1, 'price', 1750)] }), { context: { user: 'ana' } });
		expect(result.updated[0]).toMatchObject({ id: 'p1', price: 1750 });
		expect(result.updated[0]!.rowVersion).toMatch(/^[0-9a-f]{32}$/);
		const history = (await pool.query('SELECT * FROM sb_test_price_history')).rows;
		expect(history).toEqual([expect.objectContaining({ product_id: 'p1', changed_by: 'ana' })]);
	});

	it('si el handler lanza, se deshace todo el lote', async () => {
		const s = sheet({ handlers: shop(), view: true });
		const p1 = await s.get('p1');
		const p2 = await s.get('p2'); // sin existencias
		await expect(
			s.batch(batch({ updates: [edit(p1, 'price', 1750), edit(p2, 'status', 'active')] }), { idempotencyKey: 'k-rollback' })
		).rejects.toThrow('no se puede activar sin existencias');
		expect(Number((await dbRow('p1')).price)).toBe(1500);
		expect((await pool.query('SELECT count(*)::int AS n FROM sb_test_price_history')).rows[0].n).toBe(0);
		expect((await pool.query(`SELECT count(*)::int AS n FROM ${IDEMPOTENCY} WHERE key = 'k-rollback'`)).rows[0].n).toBe(0);
	});

	it('borrado lógico por handler: la fila sale de la vista', async () => {
		const s = sheet({ handlers: shop(), view: true });
		const p4 = await s.get('p4');
		const { result } = await s.batch(batch({ deletes: [{ id: 'p4', rowVersion: p4.rowVersion }] }));
		expect(result.deleted).toEqual(['p4']);
		expect((await s.list(query())).rows.map((r) => r.id)).not.toContain('p4');
		expect((await dbRow('p4')).deleted_at).not.toBeNull();
	});
});

describe('idempotencia en la base (SB-18)', () => {
	const create = (name: string) => batch({ creates: [{ key: 'tmp', values: { name, sku: 'IDE-001', price: 1, status: 'draft' } }] });
	const countByName = async (name: string) =>
		(await pool.query('SELECT count(*)::int AS n FROM sb_test_products WHERE name = $1', [name])).rows[0].n;

	it('la librería crea su tabla y guarda ahí la respuesta', async () => {
		const s = sheet();
		await s.batch(create('Idem A'), { idempotencyKey: 'k-a' });
		const stored = (await pool.query(`SELECT sheet, key FROM ${IDEMPOTENCY}`)).rows;
		expect(stored).toEqual([{ sheet: 'products', key: 'k-a' }]);
	});

	it('el reintento con la misma llave devuelve la misma respuesta y no duplica', async () => {
		const s = sheet();
		const first = await s.batch(create('Idem B'), { idempotencyKey: 'k-b' });
		const retry = await s.batch(create('Idem B'), { idempotencyKey: 'k-b' });
		expect(first.replayed).toBe(false);
		expect(retry.replayed).toBe(true);
		expect(retry.result).toEqual(first.result);
		expect(await countByName('Idem B')).toBe(1);
	});

	it('la misma llave con otro cuerpo es 422', async () => {
		const s = sheet();
		await s.batch(create('Idem C'), { idempotencyKey: 'k-c' });
		await expect(s.batch(create('Otro'), { idempotencyKey: 'k-c' })).rejects.toMatchObject({ status: 422, code: 'idempotency_key_reused' });
	});

	it('si borran la tabla con el servidor en marcha, se recrea en el siguiente lote', async () => {
		const s = sheet();
		await s.batch(create('Idem E'), { idempotencyKey: 'k-e1' });
		await pool.query(`DROP TABLE ${IDEMPOTENCY}`);
		await expect(s.batch(create('Idem E2'), { idempotencyKey: 'k-e2' })).rejects.toMatchObject({ code: '42P01' });
		const { replayed } = await s.batch(create('Idem E2'), { idempotencyKey: 'k-e2' });
		expect(replayed).toBe(false);
		expect(await countByName('Idem E2')).toBe(1);
	});

	it('dos envíos simultáneos con la misma llave no aplican el lote dos veces', async () => {
		const s = sheet();
		const outcomes = await Promise.allSettled([
			s.batch(create('Idem D'), { idempotencyKey: 'k-d' }),
			s.batch(create('Idem D'), { idempotencyKey: 'k-d' })
		]);
		expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
		expect(await countByName('Idem D')).toBe(1);
	});
});
