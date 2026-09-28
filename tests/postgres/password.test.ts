/**
 * Columnas `password` (SB-22) y `boolean` contra una base real.
 *
 * Lo que se comprueba es lo que promete la librería: el hash lo pone el motor
 * con la función de la columna; lo guardado nunca sale (ni en lista, ni en
 * fila, ni en la respuesta del lote, ni en un conflicto); y la concurrencia
 * por campo sigue funcionando sobre la marca.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD_MARK, SpreadBase, postgresSource, types } from '@spreadbase/server';
import type { Row, SheetHandlers } from '@spreadbase/server';
import { createPool } from '../support/postgres.ts';

const pool = createPool();
const IDEMPOTENCY = 'sb_test_pw_idempotency';

afterAll(async () => {
	await pool.end();
});

beforeEach(async () => {
	await pool.query(`
		DROP TABLE IF EXISTS sb_test_pw_users, ${IDEMPOTENCY};
		CREATE TABLE sb_test_pw_users (
			id            text PRIMARY KEY,
			name          text NOT NULL,
			password_hash text NOT NULL,
			active        boolean NOT NULL DEFAULT true
		);
		INSERT INTO sb_test_pw_users VALUES
			('u1', 'Uno',  'hash:secreto-uno', true),
			('u2', 'Dos',  'hash:secreto-uno', false),
			('u3', 'Tres', 'hash:otro', true);
	`);
});

/** Hash de mentira, pero reconocible: lo que importa es quién lo llama y con qué. */
let hashed: { plain: string; ctx: Record<string, unknown> }[] = [];
const hash = (plain: string, ctx: Record<string, unknown>) => {
	hashed.push({ plain, ctx });
	return `hash:${plain}`;
};

let seq = 10;
function sheet(opts: { handlers?: SheetHandlers; policy?: 'merge' | 'strict' } = {}) {
	hashed = [];
	return new SpreadBase({
		id: 'users',
		allowInsert: true,
		policy: opts.policy,
		columns: {
			id: { type: types.TEXT, label: 'ID' },
			name: { type: types.TEXT, label: 'Nombre', required: true },
			password_hash: { type: types.PASSWORD, label: 'Contraseña', required: true, minLength: 10, hash },
			active: { type: types.BOOLEAN, label: 'Activo' }
		},
		source: postgresSource({ pool, table: 'sb_test_pw_users', idempotencyTable: IDEMPOTENCY, createId: () => `u${++seq}` }),
		handlers: opts.handlers
	});
}

const query = (q: Record<string, unknown> = {}) => ({ offset: 0, limit: 100, sort: null, filters: {}, search: '', ...q });
const stored = async (id: string) =>
	(await pool.query(`SELECT password_hash, active FROM sb_test_pw_users WHERE id = $1`, [id])).rows[0] as { password_hash: string; active: boolean };
const change = (row: Row, field: string, to: unknown, base: Record<string, unknown> = {}) => ({
	id: String(row.id),
	rowVersion: row.rowVersion,
	changes: { [field]: { from: row[field] as never, to: to as never } },
	base: base as never
});
/** ¿Aparece el hash guardado en alguna parte de este valor? */
const leaks = (value: unknown) => /hash:/.test(JSON.stringify(value));

describe('contraseña · lo guardado nunca sale', () => {
	it('lista y fila: una marca opaca, distinta por fila aunque el hash sea el mismo', async () => {
		const s = sheet();
		const page = await s.list(query());
		expect(leaks(page)).toBe(false);
		const marks = page.rows.map((r) => r.password_hash as string);
		marks.forEach((m) => expect(m.startsWith(PASSWORD_MARK)).toBe(true));
		// u1 y u2 guardan lo mismo: la marca no lo delata.
		expect(marks[0]).not.toBe(marks[1]);
		expect((await s.get('u1')).password_hash).toBe(marks[0]);
	});

	it('el esquema no lleva la función hash', () => {
		const schema = sheet().schema();
		expect(schema.columns.password_hash).toEqual({ type: 'password', label: 'Contraseña', required: true, minLength: 10 });
	});

	it('filtrar por la columna se ignora y ordenar por ella es un error', async () => {
		const s = sheet();
		expect((await s.list(query({ filters: { password_hash: ['hash:otro'] } }))).total).toBe(3);
		await expect(s.list(query({ sort: { field: 'password_hash', dir: 'asc' } }))).rejects.toMatchObject({ status: 400 });
	});

	it('sin `hash`, la hoja no arranca', () => {
		expect(
			() =>
				new SpreadBase({
					id: 'x',
					columns: { id: { type: types.TEXT, label: 'ID' }, pw: { type: types.PASSWORD, label: 'Clave' } },
					source: postgresSource({ pool, table: 'sb_test_pw_users' })
				})
		).toThrow(/pw.*hash/);
	});
});

describe('contraseña · guardar', () => {
	it('el motor aplica el hash con el contexto; el handler recibe solo el hash; la respuesta, la marca', async () => {
		const seen: unknown[] = [];
		const s = sheet({
			handlers: {
				updateMany: async (items, { tx }) => {
					seen.push(items.map((i) => ({ values: i.values, row: i.row })));
					const out = [];
					for (const i of items) out.push(await tx!.update(i.id, i.values));
					return out;
				}
			}
		});
		const u1 = await s.get('u1');
		const { result } = await s.batch({ creates: [], updates: [change(u1, 'password_hash', 'clave-nueva-1')], deletes: [] }, { context: { user: 'admin' } });

		expect(hashed).toEqual([{ plain: 'clave-nueva-1', ctx: expect.objectContaining({ user: 'admin' }) }]);
		expect((await stored('u1')).password_hash).toBe('hash:clave-nueva-1');
		// El handler vio el hash nuevo y la fila actual enmascarada; nunca el texto en claro.
		expect(JSON.stringify(seen)).not.toContain('"clave-nueva-1"');
		expect(JSON.stringify(seen)).toContain('hash:clave-nueva-1');
		expect(leaks((seen[0] as { row: unknown }[])[0]!.row)).toBe(false);
		// La respuesta trae la marca nueva, distinta de la anterior.
		expect(leaks(result)).toBe(false);
		expect(result.updated[0]!.password_hash).not.toBe(u1.password_hash);
		expect(result.updated[0]!.password_hash).toBe((await s.get('u1')).password_hash);
	});

	it('alta: obligatoria, con su hash, y la fila creada sale enmascarada', async () => {
		const s = sheet();
		await expect(s.batch({ creates: [{ key: 'k', values: { name: 'Sin clave' } }], updates: [], deletes: [] })).rejects.toMatchObject({
			status: 400,
			details: [{ path: 'creates[0].values.password_hash', message: 'Obligatorio' }]
		});
		const { result } = await s.batch({ creates: [{ key: 'k', values: { name: 'Nuevo', password_hash: 'clave-del-nuevo', active: true } }], updates: [], deletes: [] });
		const id = String(result.created[0]!.row.id);
		expect((await stored(id)).password_hash).toBe('hash:clave-del-nuevo');
		expect(leaks(result)).toBe(false);
	});

	it('reglas: longitud mínima, no vaciarla, y la marca no es una contraseña', async () => {
		const s = sheet();
		const u1 = await s.get('u1');
		const reject = (to: unknown) => s.batch({ creates: [], updates: [change(u1, 'password_hash', to)], deletes: [] }).catch((e) => e.details?.[0]?.message);
		expect(await reject('corta')).toBe('Mínimo 10 caracteres');
		expect(await reject(null)).toBe('No admite vacío');
		expect(await reject(u1.password_hash)).toBe('Escribe la contraseña nueva');
		expect(hashed).toEqual([]);
		expect((await stored('u1')).password_hash).toBe('hash:secreto-uno');
	});
});

describe('contraseña · concurrencia sobre la marca', () => {
	it('otro cambió la contraseña: si yo también la cambio, es conflicto del campo; el remoto va enmascarado', async () => {
		const s = sheet();
		const u1 = await s.get('u1');
		await pool.query(`UPDATE sb_test_pw_users SET password_hash = 'hash:la-de-otro' WHERE id = 'u1'`);
		const { result } = await s.batch({ creates: [], updates: [change(u1, 'password_hash', 'la-mia-nueva-1')], deletes: [] });
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toMatchObject({ reason: 'field_conflict', fields: [{ field: 'password_hash' }] });
		expect(leaks(result.conflicts)).toBe(false);
		expect((await stored('u1')).password_hash).toBe('hash:la-de-otro');
	});

	it('otro cambió la contraseña y yo el nombre: con merge se aplica y avisa del campo', async () => {
		const s = sheet();
		const u1 = await s.get('u1');
		await pool.query(`UPDATE sb_test_pw_users SET password_hash = 'hash:la-de-otro' WHERE id = 'u1'`);
		const { result } = await s.batch({
			creates: [],
			updates: [change(u1, 'name', 'Uno bis', { password_hash: u1.password_hash, active: u1.active })],
			deletes: []
		});
		expect(result.conflicts).toEqual([]);
		expect(result.notices).toEqual([{ id: 'u1', fields: ['password_hash'] }]);
	});
});

describe('booleano', () => {
	it('viaja como booleano, se guarda y valida el tipo', async () => {
		const s = sheet();
		const u2 = await s.get('u2');
		expect(u2.active).toBe(false);
		await s.batch({ creates: [], updates: [change(u2, 'active', true)], deletes: [] });
		expect((await stored('u2')).active).toBe(true);

		const fresh = await s.get('u2');
		await expect(s.batch({ creates: [], updates: [change(fresh, 'active', 'sí')], deletes: [] })).rejects.toMatchObject({
			details: [{ path: 'updates[0].changes.active', message: 'Debe ser verdadero o falso' }]
		});
	});

	it('filtrar por booleano: `?active=false`', async () => {
		const page = await sheet().list(query({ filters: { active: ['false'] } }));
		expect(page.rows.map((r) => r.id)).toEqual(['u2']);
	});
});
