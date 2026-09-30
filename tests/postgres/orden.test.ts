/**
 * Orden por defecto (`defaultSort`) y collation de `postgresSource`, contra una
 * base real. Nombres con acentos a propósito: con la collation de una imagen
 * alpine, «Óscar» quedaría después de «Zoe».
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SpreadBase, postgresSource, types } from '@spreadbase/server';
import { createPool } from '../support/postgres.ts';

const pool = createPool();

afterAll(async () => {
	await pool.end();
});

beforeEach(async () => {
	await pool.query(`
		DROP TABLE IF EXISTS sb_test_orden;
		CREATE TABLE sb_test_orden (id text PRIMARY KEY, name text NOT NULL);
		INSERT INTO sb_test_orden VALUES ('a', 'Zoe'), ('b', 'Óscar'), ('c', 'ana'), ('d', 'Ángel'), ('e', 'Andrés'), ('f', 'Beto');
	`);
});

const columns = { id: { type: types.TEXT, label: 'ID' }, name: { type: types.TEXT, label: 'Nombre' } };
const query = (q: Record<string, unknown> = {}) => ({ offset: 0, limit: 100, sort: null, filters: {}, search: '', ...q });
const names = async (s: SpreadBase, q = query()) => (await s.list(q)).rows.map((r) => r.name);

function sheet(opts: { defaultSort?: { field: string; dir: 'asc' | 'desc' }; collation?: string } = {}) {
	return new SpreadBase({
		id: 'orden',
		columns,
		defaultSort: opts.defaultSort,
		source: postgresSource({ pool, table: 'sb_test_orden', collation: opts.collation })
	});
}

describe('orden', () => {
	it('sin defaultSort, por id', async () => {
		expect(await names(sheet())).toEqual(['Zoe', 'Óscar', 'ana', 'Ángel', 'Andrés', 'Beto']);
	});

	it('defaultSort + collation es-x-icu: alfabético en español, sin importar acentos ni mayúsculas', async () => {
		const s = sheet({ defaultSort: { field: 'name', dir: 'asc' }, collation: 'es-x-icu' });
		expect(await names(s)).toEqual(['ana', 'Andrés', 'Ángel', 'Beto', 'Óscar', 'Zoe']);
		// La posición usa el mismo orden: «ir a la fila» llega al lugar correcto.
		expect(await s.position('b', query())).toMatchObject({ position: 4, total: 6 });
		// Paginar en ese orden no repite ni salta filas.
		const [p1, p2] = await Promise.all([names(s, query({ limit: 3 })), names(s, query({ offset: 3, limit: 3 }))]);
		expect([...p1, ...p2]).toEqual(['ana', 'Andrés', 'Ángel', 'Beto', 'Óscar', 'Zoe']);
	});

	it('un orden pedido gana al de la hoja', async () => {
		const s = sheet({ defaultSort: { field: 'name', dir: 'asc' }, collation: 'es-x-icu' });
		expect(await names(s, query({ sort: { field: 'name', dir: 'desc' } }))).toEqual(['Zoe', 'Óscar', 'Beto', 'Ángel', 'Andrés', 'ana']);
	});

	it('un defaultSort sobre una columna que no existe falla al arrancar', () => {
		expect(() => sheet({ defaultSort: { field: 'apellido', dir: 'asc' } })).toThrow(/apellido/);
	});

	it('una fecha-hora ordena por el instante, no por el texto a minuto que se muestra (dos del mismo minuto no empatan)', async () => {
		await pool.query(`
			DROP TABLE IF EXISTS sb_test_orden_dt;
			CREATE TABLE sb_test_orden_dt (id text PRIMARY KEY, at timestamptz NOT NULL);
			INSERT INTO sb_test_orden_dt VALUES ('b', '2026-09-30 11:44:05'), ('a', '2026-09-30 11:44:50'), ('c', '2026-09-30 11:44:20');
		`);
		const s = new SpreadBase({
			id: 'orden-dt',
			columns: { id: { type: types.TEXT, label: 'ID' }, at: { type: types.DATETIME, label: 'Cuándo' } },
			defaultSort: { field: 'at', dir: 'desc' },
			source: postgresSource({ pool, table: 'sb_test_orden_dt' })
		});
		// Se muestran igual («11:44»), pero el orden es el del instante: a (50 s), c (20 s), b (5 s).
		const rows = (await s.list(query())).rows;
		expect(rows.map((r) => r.id)).toEqual(['a', 'c', 'b']);
		expect(new Set(rows.map((r) => r.at)).size).toBe(1);
		// Y la posición, el mismo orden.
		expect(await s.position('b', query())).toMatchObject({ position: 2, total: 3 });
		await pool.query('DROP TABLE sb_test_orden_dt');
	});
});
