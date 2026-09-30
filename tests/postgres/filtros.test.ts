/**
 * Filtros por columna (SB-33) contra una base real. La regla de referencia es
 * `matchesFilter` de core, que la fuente en memoria usa tal cual: cada filtro
 * se corre en Postgres y en memoria (sobre las mismas filas) y debe dar lo
 * mismo. Datos con lo que suele romper: vacíos y NULL, acentos, `%` y `_`,
 * decimales y dos horas del mismo día.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SpreadBase, memorySource, parseListQuery, postgresSource, types } from '@spreadbase/server';
import type { ColumnFilter, ListQuery } from '@spreadbase/server';
import { createPool } from '../support/postgres.ts';

const pool = createPool();

const people = [
	{ id: 'u1', name: 'Ana' },
	{ id: 'u2', name: 'Beto' }
];

const columns = {
	id: { type: types.TEXT, label: 'ID' },
	name: { type: types.TEXT, label: 'Nombre' },
	amount: { type: types.NUMBER, label: 'Importe' },
	due: { type: types.DATE, label: 'Vence' },
	at: { type: types.DATETIME, label: 'Cuándo' },
	active: { type: types.BOOLEAN, label: 'Activo' },
	status: {
		type: types.SELECT,
		label: 'Estatus',
		options: [
			{ value: 'open', label: 'Abierto' },
			{ value: 'closed', label: 'Cerrado' }
		]
	},
	owner: {
		type: types.LOOKUP,
		label: 'Dueño',
		lookup: {
			value: 'id',
			display: 'name',
			search: () => ({ rows: people, total: people.length }),
			byIds: (ids: string[]) => people.filter((p) => ids.includes(p.id))
		}
	}
};

const query = (where: ColumnFilter[] = [], q: Partial<ListQuery> = {}): ListQuery => ({
	offset: 0,
	limit: 100,
	sort: null,
	filters: {},
	search: '',
	where,
	...q
});

let pg: SpreadBase;
let mem: SpreadBase;

beforeAll(async () => {
	await pool.query(`
		DROP TABLE IF EXISTS sb_test_filtros;
		CREATE TABLE sb_test_filtros (
			id text PRIMARY KEY, name text, amount numeric(12,2), due date, at timestamptz,
			active boolean, status text, owner text
		);
		INSERT INTO sb_test_filtros VALUES
			('a', 'Grúas del Norte', 1500.50, '2026-06-01', '2026-06-01 09:15', true,  'open',   'u1'),
			('b', 'gruas norte',      200,     '2026-06-15', '2026-06-15 23:10', false, 'closed', 'u2'),
			('c', '100% Transportes', 0,       '2026-07-01', '2026-07-01 00:05', true,  'open',   NULL),
			('d', 'Carga_Rápida',     -50,     NULL,         NULL,               NULL,  NULL,     'u1'),
			('e', '',                 NULL,    '2026-06-15', '2026-06-15 08:00', false, 'closed', 'u2'),
			('f', NULL,               1500.5,  '2025-12-31', '2025-12-31 12:00', true,  'open',   'u1');
	`);
	pg = new SpreadBase({ id: 'filtros', columns, source: postgresSource({ pool, table: 'sb_test_filtros' }) });
	// En memoria, las mismas filas tal como las lee Postgres (mismo formato de cada tipo).
	const rows = (await pg.list(query([], { limit: 100 }))).rows.map(({ rowVersion: _, ...r }) => r);
	mem = new SpreadBase({ id: 'filtros-mem', columns, source: memorySource({ rows }) });
});

afterAll(async () => {
	await pool.query('DROP TABLE IF EXISTS sb_test_filtros');
	await pool.end();
});

const ids = async (s: SpreadBase, where: ColumnFilter[], q: Partial<ListQuery> = {}) =>
	(await s.list(query(where, q))).rows.map((r) => String(r.id)).sort();

/** Corre el filtro en las dos fuentes: deben coincidir entre sí y con lo esperado. */
async function expectBoth(where: ColumnFilter[], expected: string[]) {
	const [a, b] = await Promise.all([ids(pg, where), ids(mem, where)]);
	expect(a, `postgres ${JSON.stringify(where)}`).toEqual(expected);
	expect(b, `memoria ${JSON.stringify(where)}`).toEqual(expected);
}

describe('filtros por columna · texto', () => {
	it('contiene, empieza y termina: sin acentos ni mayúsculas', async () => {
		await expectBoth([{ field: 'name', op: 'contains', value: 'GRUAS' }], ['a', 'b']);
		await expectBoth([{ field: 'name', op: 'starts', value: 'grú' }], ['a', 'b']);
		await expectBoth([{ field: 'name', op: 'ends', value: 'norte' }], ['a', 'b']);
		await expectBoth([{ field: 'name', op: 'eq', value: 'GRUAS NORTE' }], ['b']);
	});

	it('% y _ son letras, no comodines', async () => {
		await expectBoth([{ field: 'name', op: 'contains', value: '%' }], ['c']);
		await expectBoth([{ field: 'name', op: 'contains', value: '_' }], ['d']);
		await expectBoth([{ field: 'name', op: 'starts', value: '100%' }], ['c']);
	});

	it('«no contiene» y «no es igual» incluyen las vacías (como Excel); texto vacío y NULL son lo mismo', async () => {
		await expectBoth([{ field: 'name', op: 'not_contains', value: 'norte' }], ['c', 'd', 'e', 'f']);
		await expectBoth([{ field: 'name', op: 'ne', value: 'gruas norte' }], ['a', 'c', 'd', 'e', 'f']);
		await expectBoth([{ field: 'name', op: 'empty' }], ['e', 'f']);
		await expectBoth([{ field: 'name', op: 'not_empty' }], ['a', 'b', 'c', 'd']);
	});
});

describe('filtros por columna · número y fecha', () => {
	it('comparaciones y «entre» (incluye los extremos); decimales sin importar el formato', async () => {
		await expectBoth([{ field: 'amount', op: 'gt', value: 0 }], ['a', 'b', 'f']);
		await expectBoth([{ field: 'amount', op: 'gte', value: 0 }], ['a', 'b', 'c', 'f']);
		await expectBoth([{ field: 'amount', op: 'lt', value: 0 }], ['d']);
		await expectBoth([{ field: 'amount', op: 'between', value: 0, value2: 200 }], ['b', 'c']);
		await expectBoth([{ field: 'amount', op: 'eq', value: '1500.5' }], ['a', 'f']);
		await expectBoth([{ field: 'amount', op: 'ne', value: 1500.5 }], ['b', 'c', 'd', 'e']);
	});

	it('fechas: desde, hasta, entre; la fecha-hora se compara por su día', async () => {
		await expectBoth([{ field: 'due', op: 'gte', value: '2026-06-15' }], ['b', 'c', 'e']);
		await expectBoth([{ field: 'due', op: 'lt', value: '2026-06-01' }], ['f']);
		await expectBoth([{ field: 'due', op: 'between', value: '2026-06-01', value2: '2026-06-30' }], ['a', 'b', 'e']);
		// 08:00 y 23:10 del 15 de junio: «es el día» toma las dos.
		await expectBoth([{ field: 'at', op: 'eq', value: '2026-06-15' }], ['b', 'e']);
		await expectBoth([{ field: 'at', op: 'empty' }], ['d']);
	});
});

describe('filtros por columna · lista de valores', () => {
	it('«in» con vacías; booleanos, catálogos y lookups; varias columnas se combinan con Y', async () => {
		await expectBoth([{ field: 'status', op: 'in', values: ['open', null] }], ['a', 'c', 'd', 'f']);
		await expectBoth([{ field: 'active', op: 'in', values: [false] }], ['b', 'e']);
		await expectBoth([{ field: 'owner', op: 'in', values: ['u1'] }], ['a', 'd', 'f']);
		await expectBoth([{ field: 'amount', op: 'in', values: [1500.5, 0] }], ['a', 'c', 'f']);
		await expectBoth([{ field: 'at', op: 'in', values: ['2026-06-15'] }], ['b', 'e']);
		await expectBoth(
			[
				{ field: 'owner', op: 'in', values: ['u1'] },
				{ field: 'amount', op: 'gt', value: 1000 }
			],
			['a', 'f']
		);
		await expectBoth([{ field: 'status', op: 'in', values: [] }], []);
	});

	it('valores distintos con su cuenta, dentro de la consulta: vacías primero, en orden; el lookup con nombres', async () => {
		for (const s of [pg, mem]) {
			const status = await s.values('status', query());
			expect(status).toEqual({
				values: [
					{ value: null, count: 1 },
					{ value: 'closed', count: 2 },
					{ value: 'open', count: 3 }
				],
				truncated: false
			});
			const amounts = await s.values('amount', query([{ field: 'status', op: 'in', values: ['open'] }]));
			expect(amounts.values).toEqual([
				{ value: 0, count: 1 },
				{ value: 1500.5, count: 2 }
			]);
			const days = await s.values('at', query());
			expect(days.values.map((v) => v.value)).toEqual([null, '2025-12-31', '2026-06-01', '2026-06-15', '2026-07-01']);
			const owners = await s.values('owner', query());
			expect(owners.labels).toEqual({ u1: 'Ana', u2: 'Beto' });
			expect((await s.values('active', query())).values).toEqual([
				{ value: null, count: 1 },
				{ value: false, count: 2 },
				{ value: true, count: 3 }
			]);
		}
	});

	it('la posición de una fila respeta los filtros', async () => {
		const where: ColumnFilter[] = [{ field: 'amount', op: 'gt', value: 0 }];
		expect(await pg.position('b', query(where, { sort: { field: 'amount', dir: 'asc' } }))).toMatchObject({ position: 0, total: 3 });
		expect(await pg.position('d', query(where))).toMatchObject({ position: null, total: 3 });
	});
});

describe('filtros por columna · reglas', () => {
	it('un operador que no aplica al tipo o sin valor es 400; columnas desconocidas se ignoran', async () => {
		await expect(pg.list(query([{ field: 'status', op: 'gt', value: 1 }]))).rejects.toMatchObject({ status: 400 });
		await expect(pg.list(query([{ field: 'amount', op: 'gt' }]))).rejects.toMatchObject({ status: 400 });
		await expect(pg.list(query([{ field: 'due', op: 'gt', value: '15/06/2026' }]))).rejects.toMatchObject({ status: 400 });
		expect(await ids(pg, [{ field: 'nope', op: 'empty' }])).toHaveLength(6);
	});

	it('?where= llega como JSON; mal formado es 400', () => {
		const where = JSON.stringify([{ field: 'amount', op: 'between', value: 0, value2: 10 }]);
		expect(parseListQuery({ where, status: 'open' })).toMatchObject({
			filters: { status: ['open'] },
			where: [{ field: 'amount', op: 'between', value: 0, value2: 10 }]
		});
		expect(() => parseListQuery({ where: '[{' })).toThrow(/JSON/);
		expect(() => parseListQuery({ where: '[{"field":1}]' })).toThrow(/where\[0\]/);
	});
});
