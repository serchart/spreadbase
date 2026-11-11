/**
 * Filtros por columna (SB-33) en `mongoSource`. Como en
 * `postgres/filtros.test.ts`, la regla de referencia es `matchesFilter` de
 * core (la fuente en memoria): cada filtro corre en Mongo y en memoria sobre
 * las mismas filas y debe dar lo mismo. En Mongo, además, los valores vienen
 * como los guarda una app sin esquema: números como texto, fechas como `Date`
 * o como texto, booleanos como `'true'`. Si no hay Mongo, se omite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { SpreadBase, memorySource, mongoSource, types } from '@spreadbase/server';
import type { ColumnFilter, ListQuery } from '@spreadbase/server';
import { connectMongo } from '../support/mongo.ts';

const client = await connectMongo();
const db = client?.db('spreadbase_test') as Db;
const COLLECTION = 'sb_test_filtros';

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

let mongo: SpreadBase;
let mem: SpreadBase;

beforeAll(async () => {
	if (!client) return;
	await db.collection(COLLECTION).drop().catch(() => undefined);
	const at = (s: string) => new Date(`${s}:00Z`);
	await db.collection(COLLECTION).insertMany([
		{ _id: 'a', name: 'Grúas del Norte', amount: 1500.5, due: '2026-06-01', at: at('2026-06-01T09:15'), active: true, status: 'open', owner: 'u1' },
		{ _id: 'b', name: 'gruas norte', amount: '200', due: new Date('2026-06-15T00:00:00Z'), at: '2026-06-15 23:10', active: 'false', status: 'closed', owner: 'u2' },
		{ _id: 'c', name: '100% Transportes', amount: 0, due: '2026-07-01', at: at('2026-07-01T00:05'), active: true, status: 'open', owner: null },
		// Sin los campos: ausente es vacío.
		{ _id: 'd', name: 'Carga_Rápida', amount: -50, owner: 'u1' },
		{ _id: 'e', name: '', amount: '', due: '2026-06-15', at: at('2026-06-15T08:00'), active: false, status: 'closed', owner: 'u2' },
		{ _id: 'f', name: null, amount: '1500.50', due: '2025-12-31', at: at('2025-12-31T12:00'), active: 'true', status: 'open', owner: 'u1' }
	] as never[]);
	mongo = new SpreadBase({ id: 'filtros', columns, source: mongoSource({ db, collection: COLLECTION }) });
	// En memoria, las mismas filas tal como las lee Mongo (mismo formato de cada tipo).
	const rows = (await mongo.list(query([], { limit: 100 }))).rows.map(({ rowVersion: _, ...r }) => r);
	mem = new SpreadBase({ id: 'filtros-mem', columns, source: memorySource({ rows }) });
});

afterAll(async () => {
	await db?.collection(COLLECTION).drop().catch(() => undefined);
	await client?.close();
});

const ids = async (s: SpreadBase, where: ColumnFilter[], q: Partial<ListQuery> = {}) =>
	(await s.list(query(where, q))).rows.map((r) => String(r.id)).sort();

/** Corre el filtro en las dos fuentes: deben coincidir entre sí y con lo esperado. */
async function expectBoth(where: ColumnFilter[], expected: string[]) {
	const [a, b] = await Promise.all([ids(mongo, where), ids(mem, where)]);
	expect(a, `mongo ${JSON.stringify(where)}`).toEqual(expected);
	expect(b, `memoria ${JSON.stringify(where)}`).toEqual(expected);
}

describe.skipIf(!client)('mongoSource · lectura en el formato del cliente', () => {
	it('números, fechas, fecha-hora y booleanos, se guarden como se guarden', async () => {
		const { rows } = await mongo.list(query());
		const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
		expect(byId.b).toMatchObject({ amount: 200, due: '2026-06-15', at: '2026-06-15 23:10', active: false });
		expect(byId.a).toMatchObject({ amount: 1500.5, at: '2026-06-01 09:15', active: true });
		expect(byId.d).toMatchObject({ due: null, at: null, active: null, status: null });
		expect(byId.e).toMatchObject({ amount: null, name: '' });
		expect(byId.f).toMatchObject({ amount: 1500.5, active: true });
	});
});

describe.skipIf(!client)('mongoSource · filtros por columna · texto', () => {
	it('contiene, empieza y termina: sin acentos ni mayúsculas', async () => {
		await expectBoth([{ field: 'name', op: 'contains', value: 'GRUAS' }], ['a', 'b']);
		await expectBoth([{ field: 'name', op: 'starts', value: 'grú' }], ['a', 'b']);
		await expectBoth([{ field: 'name', op: 'ends', value: 'norte' }], ['a', 'b']);
		await expectBoth([{ field: 'name', op: 'eq', value: 'GRUAS NORTE' }], ['b']);
	});

	it('%, _ y los signos de expresiones regulares son letras, no comodines', async () => {
		await expectBoth([{ field: 'name', op: 'contains', value: '%' }], ['c']);
		await expectBoth([{ field: 'name', op: 'contains', value: '_' }], ['d']);
		await expectBoth([{ field: 'name', op: 'starts', value: '100%' }], ['c']);
		await expectBoth([{ field: 'name', op: 'starts', value: '.*' }], []);
	});

	it('«no contiene» y «no es igual» incluyen las vacías (como Excel); texto vacío, null y ausente son lo mismo', async () => {
		await expectBoth([{ field: 'name', op: 'not_contains', value: 'norte' }], ['c', 'd', 'e', 'f']);
		await expectBoth([{ field: 'name', op: 'ne', value: 'gruas norte' }], ['a', 'c', 'd', 'e', 'f']);
		await expectBoth([{ field: 'name', op: 'empty' }], ['e', 'f']);
		await expectBoth([{ field: 'name', op: 'not_empty' }], ['a', 'b', 'c', 'd']);
	});
});

describe.skipIf(!client)('mongoSource · filtros por columna · número y fecha', () => {
	it('comparaciones y «entre» (incluye los extremos); números guardados como texto también', async () => {
		await expectBoth([{ field: 'amount', op: 'gt', value: 0 }], ['a', 'b', 'f']);
		await expectBoth([{ field: 'amount', op: 'gte', value: 0 }], ['a', 'b', 'c', 'f']);
		await expectBoth([{ field: 'amount', op: 'lt', value: 0 }], ['d']);
		await expectBoth([{ field: 'amount', op: 'between', value: 0, value2: 200 }], ['b', 'c']);
		await expectBoth([{ field: 'amount', op: 'eq', value: '1500.5' }], ['a', 'f']);
		await expectBoth([{ field: 'amount', op: 'ne', value: 1500.5 }], ['b', 'c', 'd', 'e']);
	});

	it('fechas como texto o como Date: desde, hasta, entre; la fecha-hora se compara por su día', async () => {
		await expectBoth([{ field: 'due', op: 'gte', value: '2026-06-15' }], ['b', 'c', 'e']);
		await expectBoth([{ field: 'due', op: 'lt', value: '2026-06-01' }], ['f']);
		await expectBoth([{ field: 'due', op: 'between', value: '2026-06-01', value2: '2026-06-30' }], ['a', 'b', 'e']);
		await expectBoth([{ field: 'at', op: 'eq', value: '2026-06-15' }], ['b', 'e']);
		await expectBoth([{ field: 'at', op: 'empty' }], ['d']);
	});
});

describe.skipIf(!client)('mongoSource · filtros por columna · lista de valores', () => {
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
		for (const s of [mongo, mem]) {
			expect(await s.values('status', query())).toEqual({
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
			expect((await s.values('owner', query())).labels).toEqual({ u1: 'Ana', u2: 'Beto' });
			expect((await s.values('active', query())).values).toEqual([
				{ value: null, count: 1 },
				{ value: false, count: 2 },
				{ value: true, count: 3 }
			]);
		}
	});

	it('la posición de una fila respeta filtros y orden, también descendente', async () => {
		const where: ColumnFilter[] = [{ field: 'amount', op: 'gt', value: 0 }];
		expect(await mongo.position('b', query(where, { sort: { field: 'amount', dir: 'asc' } }))).toMatchObject({ position: 0, total: 3 });
		expect(await mongo.position('d', query(where))).toMatchObject({ position: null, total: 3 });
		// a y f empatan en 1500.5: por id.
		for (const dir of ['asc', 'desc'] as const) {
			const sort = { field: 'amount', dir };
			const order = (await mongo.list(query([], { sort }))).rows.map((r) => String(r.id));
			const positions = await Promise.all(order.map(async (id) => (await mongo.position(id, query([], { sort }))).position));
			expect(positions).toEqual(order.map((_, i) => i));
		}
	});
});
