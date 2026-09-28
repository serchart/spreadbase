/**
 * Columnas `lookup` (SB-21, docs/03-lookup.md) contra una base real: el
 * recurso externo es una tabla de usuarios, y las funciones del lookup son
 * SQL de la app, como en el ejemplo de Postgres.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SpreadBase, postgresSource, types } from '@spreadbase/server';
import type { LookupSpec, Row } from '@spreadbase/server';
import { createPool } from '../support/postgres.ts';

const pool = createPool();

afterAll(async () => {
	await pool.end();
});

beforeEach(async () => {
	await pool.query(`
		DROP TABLE IF EXISTS sb_test_lk_tasks, sb_test_lk_users;
		CREATE TABLE sb_test_lk_users (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL);
		INSERT INTO sb_test_lk_users (id, name, email)
			SELECT 'u' || lpad(n::text, 3, '0'), 'Usuario ' || lpad(n::text, 3, '0'), 'u' || n || '@x.mx' FROM generate_series(1, 120) n;
		INSERT INTO sb_test_lk_users (id, name, email) VALUES
			('ana1', 'Ana López', 'ana1@x.mx'),
			('ana2', 'Ana López', 'ana2@x.mx'),
			('oscar', 'Óscar Núñez', 'oscar@x.mx');
		CREATE TABLE sb_test_lk_tasks (
			id       text PRIMARY KEY,
			title    text NOT NULL,
			owner_id text REFERENCES sb_test_lk_users (id),
			due_at   timestamp
		);
		INSERT INTO sb_test_lk_tasks VALUES
			('t1', 'Uno',  'u001',  '2026-09-28 09:15:42'),
			('t2', 'Dos',  'u002',  NULL),
			('t3', 'Tres', 'u001',  NULL),
			('t4', 'Cuatro', NULL,  NULL);
	`);
});

const FOLD = (e: string) => `translate(lower(${e}), 'áéíóúüñ', 'aeiouun')`;
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Llamadas que recibe el recurso, para comprobar que no se consulta de más. */
let calls: { fn: string; arg: unknown; ctx: unknown }[] = [];

const users: LookupSpec = {
	value: 'id',
	display: 'name',
	columns: {
		name: { type: types.TEXT, label: 'Nombre' },
		email: { type: types.TEXT, label: 'Correo' }
	},
	async search(q, { offset, limit }, ctx) {
		calls.push({ fn: 'search', arg: q, ctx });
		const where = q ? `WHERE ${FOLD('name')} LIKE $1` : '';
		const params = q ? [`%${fold(q)}%`] : [];
		const n = params.length;
		const [rows, count] = await Promise.all([
			pool.query(`SELECT id, name, email FROM sb_test_lk_users ${where} ORDER BY name, id LIMIT $${n + 1} OFFSET $${n + 2}`, [...params, limit, offset]),
			pool.query(`SELECT count(*)::int AS total FROM sb_test_lk_users ${where}`, params)
		]);
		return { rows: rows.rows, total: count.rows[0].total };
	},
	async byIds(ids, ctx) {
		calls.push({ fn: 'byIds', arg: ids, ctx });
		return (await pool.query(`SELECT id, name, email FROM sb_test_lk_users WHERE id = ANY($1)`, [ids])).rows;
	},
	async resolve(texts, ctx) {
		calls.push({ fn: 'resolve', arg: texts, ctx });
		return (
			await pool.query(`SELECT id, name, email FROM sb_test_lk_users WHERE ${FOLD('name')} = ANY($1) OR id = ANY($2)`, [
				texts.map(fold),
				texts
			])
		).rows;
	}
};

function sheet(lookup: LookupSpec = users) {
	calls = [];
	return new SpreadBase({
		id: 'tasks',
		allowInsert: true,
		columns: {
			id: { type: types.TEXT, label: 'ID' },
			title: { type: types.TEXT, label: 'Tarea', required: true },
			owner_id: { type: types.LOOKUP, label: 'Responsable', lookup },
			due_at: { type: types.DATETIME, label: 'Vence' }
		},
		source: postgresSource({ pool, table: 'sb_test_lk_tasks', createId: () => `t${Date.now()}` })
	});
}

const query = { offset: 0, limit: 100, sort: null, filters: {}, search: '' };

describe('esquema', () => {
	it('viaja sin funciones, con las columnas de la mini tabla y si sabe resolver', () => {
		const lookup = sheet().schema().columns.owner_id!.lookup!;
		expect(lookup).toEqual({
			value: 'id',
			display: 'name',
			columns: users.columns,
			minLength: 0,
			resolvable: true
		});
		expect(JSON.stringify(sheet().schema())).not.toContain('search');
	});

	it('sin columnas declaradas, la mini tabla es solo `display`', () => {
		const { columns: _c, ...bare } = users;
		expect(sheet(bare).schema().columns.owner_id!.lookup!.columns).toEqual({ name: { type: 'text', label: 'Responsable' } });
	});

	it('un lookup a medias falla al arrancar, con el nombre del campo', () => {
		expect(() => sheet({ ...users, byIds: undefined as never })).toThrow(/owner_id/);
	});
});

describe('lista', () => {
	it('cada tramo trae el nombre de sus ids, con una sola consulta por columna', async () => {
		const page = await sheet().list(query, { user: 'yo' });
		expect(page.labels).toEqual({ owner_id: { u001: 'Usuario 001', u002: 'Usuario 002' } });
		const byIds = calls.filter((c) => c.fn === 'byIds');
		expect(byIds).toHaveLength(1);
		expect((byIds[0]!.arg as string[]).sort()).toEqual(['u001', 'u002']);
		expect(byIds[0]!.ctx).toEqual({ user: 'yo' });
	});

	it('fecha-hora en el formato del cliente: AAAA-MM-DD HH:mm', async () => {
		const row = await sheet().get('t1');
		expect(row.due_at).toBe('2026-09-28 09:15');
	});
});

describe('búsqueda', () => {
	it('paginada: tramos sin repetir y el total de la consulta', async () => {
		const s = sheet();
		const first = await s.lookup('owner_id', { q: 'usuario', offset: 0, limit: 50 });
		const second = await s.lookup('owner_id', { q: 'usuario', offset: 50, limit: 50 });
		const third = await s.lookup('owner_id', { q: 'usuario', offset: 100, limit: 50 });
		expect([first.total, first.rows.length, second.rows.length, third.rows.length]).toEqual([120, 50, 50, 20]);
		const ids = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
		expect(new Set(ids).size).toBe(120);
		expect(third).toMatchObject({ offset: 100, limit: 50 });
	});

	it('sin acentos ni mayúsculas', async () => {
		const found = await sheet().lookup('owner_id', { q: 'OSCAR nu', offset: 0, limit: 10 });
		expect(found.rows.map((r) => r.id)).toEqual(['oscar']);
	});

	it('un campo que no es lookup: 404', async () => {
		await expect(sheet().lookup('title', { q: '', offset: 0, limit: 10 })).rejects.toMatchObject({ status: 404 });
	});
});

describe('pegar: resolve', () => {
	it('una coincidencia, varias, ninguna, y por id', async () => {
		const { matches } = await sheet().resolve('owner_id', ['oscar nuñez', 'Ana López', 'Nadie', 'u007', 'Usuario 010']);
		expect(Object.fromEntries(Object.entries(matches).map(([t, rows]) => [t, rows.map((r) => r.id)]))).toEqual({
			'oscar nuñez': ['oscar'],
			'Ana López': ['ana1', 'ana2'],
			Nadie: [],
			u007: ['u007'],
			'Usuario 010': ['u010']
		});
	});

	it('textos repetidos: una sola consulta con los únicos', async () => {
		const s = sheet();
		await s.resolve('owner_id', ['Ana López', 'Ana López', ' Ana López ', 'u001']);
		const resolve = calls.filter((c) => c.fn === 'resolve');
		expect(resolve).toHaveLength(1);
		expect(resolve[0]!.arg).toEqual(['Ana López', 'u001']);
	});

	it('sin `resolve` en el servidor: el esquema lo dice y la ruta responde 400', async () => {
		const s = sheet({ ...users, resolve: undefined });
		expect(s.schema().columns.owner_id!.lookup!.resolvable).toBe(false);
		await expect(s.resolve('owner_id', ['Ana'])).rejects.toMatchObject({ status: 400, code: 'lookup_not_resolvable' });
	});
});

describe('guardar', () => {
	const change = (row: Row, field: string, to: unknown) => ({
		id: String(row.id),
		rowVersion: row.rowVersion,
		changes: { [field]: { from: row[field] as never, to: to as never } }
	});

	it('un id que no existe rechaza el lote con 400 y la ruta exacta; no se escribe nada', async () => {
		const s = sheet();
		const t1 = await s.get('t1');
		const t2 = await s.get('t2');
		const err = await s
			.batch({
				creates: [{ key: 'k1', values: { title: 'Nueva', owner_id: 'fantasma' } }],
				updates: [change(t1, 'owner_id', 'u050'), change(t2, 'owner_id', 'nadie')],
				deletes: []
			})
			.catch((e) => e);
		expect(err).toMatchObject({ status: 400 });
		expect(err.details).toEqual([
			{ path: 'updates[1].changes.owner_id', message: 'No corresponde a ningún registro' },
			{ path: 'creates[0].values.owner_id', message: 'No corresponde a ningún registro' }
		]);
		expect((await s.get('t1')).owner_id).toBe('u001');
	});

	it('ids válidos: una sola consulta de validación para todo el lote', async () => {
		const s = sheet();
		const [t1, t2, t3] = await Promise.all(['t1', 't2', 't3'].map((id) => s.get(id)));
		calls = [];
		const { result } = await s.batch(
			{ creates: [], updates: [change(t1, 'owner_id', 'ana1'), change(t2, 'owner_id', 'ana1'), change(t3, 'owner_id', 'oscar')], deletes: [] },
			{ context: { user: 'yo' } }
		);
		expect(result.updated.map((r) => r.owner_id)).toEqual(['ana1', 'ana1', 'oscar']);
		const byIds = calls.filter((c) => c.fn === 'byIds');
		expect(byIds).toHaveLength(1);
		expect((byIds[0]!.arg as string[]).sort()).toEqual(['ana1', 'oscar']);
		expect(byIds[0]!.ctx).toMatchObject({ user: 'yo' });
	});

	it('vaciar la celda no consulta al recurso', async () => {
		const s = sheet();
		const t1 = await s.get('t1');
		calls = [];
		await s.batch({ creates: [], updates: [change(t1, 'owner_id', null)], deletes: [] });
		expect(calls.filter((c) => c.fn === 'byIds')).toHaveLength(0);
		expect((await s.get('t1')).owner_id).toBeNull();
	});

	it('fecha-hora: lo que leyó el cliente coincide con lo guardado (sin conflicto ni aviso falso)', async () => {
		const s = sheet();
		const t1 = await s.get('t1');
		// Otro cambia el título: la huella cambia, y el motor compara campo por campo.
		await pool.query(`UPDATE sb_test_lk_tasks SET title = 'Uno bis' WHERE id = 't1'`);
		const { result } = await s.batch({
			creates: [],
			updates: [{ ...change(t1, 'owner_id', 'u003'), base: { title: t1.title as string, due_at: t1.due_at as string } }],
			deletes: []
		});
		expect(result.conflicts).toEqual([]);
		expect(result.notices).toEqual([{ id: 't1', fields: ['title'] }]);
	});
});
