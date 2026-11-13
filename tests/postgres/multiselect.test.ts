/**
 * Selección múltiple (SB-41) contra una base real: la lista de valores se
 * guarda como JSON —en `jsonb` (recomendado) o en `text`— y se lee como
 * lista. Los filtros por valor son «contiene alguna de» (`?|`), «vacía» es
 * sin ninguna (`null` o `[]`), la lista de valores cuenta cuántas filas
 * contienen cada opción y los filtros fijos (SB-28) aceptan la fila con
 * alguno de los valores.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SpreadBase, postgresSource, types } from '@spreadbase/server';
import type { Row } from '@spreadbase/server';
import { createPool } from '../support/postgres.ts';

const pool = createPool();
const IDEMPOTENCY = 'sb_test_multi_idempotency';

afterAll(async () => {
	await pool.end();
});

beforeEach(async () => {
	await pool.query(`
		DROP TABLE IF EXISTS sb_test_multi, ${IDEMPOTENCY};
		CREATE TABLE sb_test_multi (
			id     text PRIMARY KEY,
			name   text NOT NULL,
			brands jsonb,
			tags   text
		);
		INSERT INTO sb_test_multi VALUES
			('a1', 'Centro',  '["byd","honda"]', '["vip"]'),
			('a2', 'Norte',   '["chevrolet"]',   NULL),
			('a3', 'Sur',     NULL,              '[]'),
			('a4', 'Oriente', '[]',              '["vip","new"]');
	`);
});

const BRANDS = [
	{ value: 'byd', label: 'BYD' },
	{ value: 'chevrolet', label: 'Chevrolet' },
	{ value: 'honda', label: 'Honda' },
	{ value: 'toyota', label: 'Toyota' }
];
const TAGS = [
	{ value: 'new', label: 'Nueva' },
	{ value: 'vip', label: 'VIP' }
];

let seq = 10;
const sheet = () =>
	new SpreadBase({
		id: 'multi',
		allowInsert: true,
		columns: {
			id: { type: types.TEXT, label: 'ID' },
			name: { type: types.TEXT, label: 'Name', required: true },
			brands: { type: types.MULTISELECT, label: 'Brands', options: BRANDS },
			tags: { type: types.MULTISELECT, label: 'Tags (text)', options: TAGS }
		},
		source: postgresSource({ pool, table: 'sb_test_multi', idempotencyTable: IDEMPOTENCY, createId: () => `a${++seq}` })
	});

const query = (extra: Record<string, unknown> = {}) => ({ offset: 0, limit: 50, sort: null, filters: {}, search: '', ...extra });
const ids = async (s: SpreadBase, extra: Record<string, unknown>) => (await s.list(query(extra) as never)).rows.map((r) => r.id).sort();
const change = (row: Row, field: string, to: unknown) => ({ id: String(row.id), rowVersion: row.rowVersion, changes: { [field]: { from: row[field] as never, to: to as never } } });

describe('multiselect en Postgres (SB-41)', () => {
	it('lee la lista de jsonb y de texto', async () => {
		const s = sheet();
		const rows = (await s.list(query() as never)).rows;
		expect(rows.find((r) => r.id === 'a1')).toMatchObject({ brands: ['byd', 'honda'], tags: ['vip'] });
		expect(rows.find((r) => r.id === 'a3')).toMatchObject({ brands: null, tags: [] });
	});

	it('filtra por valor «contiene alguna de», vacía y no vacía, en jsonb y en texto', async () => {
		const s = sheet();
		expect(await ids(s, { where: [{ field: 'brands', op: 'in', values: ['honda'] }] })).toEqual(['a1']);
		expect(await ids(s, { where: [{ field: 'brands', op: 'in', values: ['honda', 'chevrolet'] }] })).toEqual(['a1', 'a2']);
		expect(await ids(s, { where: [{ field: 'brands', op: 'in', values: [null, 'chevrolet'] }] })).toEqual(['a2', 'a3', 'a4']);
		expect(await ids(s, { where: [{ field: 'brands', op: 'empty' }] })).toEqual(['a3', 'a4']);
		expect(await ids(s, { where: [{ field: 'brands', op: 'not_empty' }] })).toEqual(['a1', 'a2']);
		expect(await ids(s, { where: [{ field: 'tags', op: 'in', values: ['vip'] }] })).toEqual(['a1', 'a4']);
		expect(await ids(s, { where: [{ field: 'tags', op: 'empty' }] })).toEqual(['a2', 'a3']);
		// Filtro fijo (SB-28): la fila pasa con alguno de los valores.
		expect(await ids(s, { filters: { brands: ['byd', 'chevrolet'] } })).toEqual(['a1', 'a2']);
	});

	it('la lista de valores cuenta cuántas filas contienen cada opción; las vacías aparte', async () => {
		const s = sheet();
		expect((await s.values('brands', query() as never)).values).toEqual([
			{ value: null, count: 2 },
			{ value: 'byd', count: 1 },
			{ value: 'chevrolet', count: 1 },
			{ value: 'honda', count: 1 }
		]);
		// Con los demás filtros aplicados.
		expect((await s.values('tags', query({ where: [{ field: 'brands', op: 'not_empty' }] }) as never)).values).toEqual([
			{ value: null, count: 1 },
			{ value: 'vip', count: 1 }
		]);
	});

	it('escribe la lista como JSON en jsonb y en texto; sin conflicto falso al volver a editar', async () => {
		const s = sheet();
		const a2 = await s.get('a2');
		const { result } = await s.batch({
			creates: [{ key: 'n', values: { name: 'Poniente', brands: ['byd', 'toyota'], tags: ['new'] } }],
			updates: [{ ...change(a2, 'brands', ['chevrolet', 'honda']), changes: { brands: { from: ['chevrolet'], to: ['chevrolet', 'honda'] }, tags: { from: null, to: ['vip'] } } }],
			deletes: []
		});
		expect(result.conflicts).toEqual([]);
		expect(result.created[0]!.row).toMatchObject({ brands: ['byd', 'toyota'], tags: ['new'] });
		const after = await s.get('a2');
		expect(after).toMatchObject({ brands: ['chevrolet', 'honda'], tags: ['vip'] });
		const raw = (await pool.query(`SELECT jsonb_typeof(brands) AS t, tags FROM sb_test_multi WHERE id = 'a2'`)).rows[0];
		expect(raw.t).toBe('array');
		expect(JSON.parse(raw.tags)).toEqual(['vip']);
		const { result: again } = await s.batch({ creates: [], updates: [change(after, 'brands', null)], deletes: [] });
		expect(again.conflicts).toEqual([]);
		expect((await s.get('a2')).brands).toBeNull();
	});

	it('valida: solo valores de options, sin repetidos y como lista', async () => {
		const s = sheet();
		const a1 = await s.get('a1');
		const rejects = (to: unknown, message: string) =>
			expect(s.batch({ creates: [], updates: [change(a1, 'brands', to)], deletes: [] })).rejects.toMatchObject({
				status: 400,
				details: [{ path: 'updates[0].changes.brands', message }]
			});
		await rejects(['byd', 'ferrari'], 'Valor fuera del catálogo');
		await rejects(['byd', 'byd'], 'Opción repetida');
		await rejects('byd', 'Debe ser una lista de opciones');
	});
});
