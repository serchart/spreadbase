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
});
