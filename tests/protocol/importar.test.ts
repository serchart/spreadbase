/**
 * Importar (SB-34), sin navegador: encontrar la tabla en un archivo
 * (`locateTable`, core) y lo que valida un formato antes de entregar las filas
 * a la app (`importFormat`, server). Las rutas, contra el ejemplo encendido.
 */
import { describe, expect, it } from 'vitest';
import { locateTable, type ImportSchema } from '@spreadbase/core';
import { importFormat, types } from '@spreadbase/server';
import { api } from '../support/api.ts';

const people = [
	{ id: 'u1', name: 'Karina Gloria', code: 'KARINA' },
	{ id: 'u2', name: 'Yadira López', code: 'YADI' }
];

const format = importFormat({
	id: 'clientes',
	label: 'Clientes',
	key: 'code',
	columns: {
		code: { type: types.TEXT, label: 'Código', required: true, pattern: '^CL\\d+$', aliases: ['# CLIENTE'] },
		name: { type: types.TEXT, label: 'Nombre fiscal', required: true, aliases: ['Razón Social'] },
		debt: { type: types.NUMBER, label: 'Pendiente', min: 0 },
		owner: {
			type: types.LOOKUP,
			label: 'Ejecutiva',
			aliases: ['EJECUTIVA'],
			lookup: {
				value: 'id',
				display: 'name',
				search: () => ({ rows: people, total: people.length }),
				byIds: (ids: string[]) => people.filter((p) => ids.includes(p.id)),
				resolve: (texts: string[]) => people.filter((p) => texts.some((t) => [p.code, p.name].includes(t)))
			}
		},
		issuer: { type: types.TEXT, label: 'Emisora', from: 'either', required: true },
		corte: { type: types.DATE, label: 'Fecha de corte', from: 'form', required: true }
	},
	footer: { checksum: ['debt'] },
	review: (rows, ctx) => ({ summary: { filas: rows.length, emisora: ctx.fields.issuer } }),
	apply: () => ({ summary: { ok: 1 } })
});

const schema = format.schema();

describe('importar · encontrar la tabla (core)', () => {
	it('IMP-A1 · encabezado donde esté, por etiqueta o alias sin acentos ni mayúsculas; columnas de más se ignoran; el pie es la suma de control', () => {
		const cells = [
			['Todos los documentos'],
			[],
			['Notas', '# cliente', 'RAZON SOCIAL', 'Pendiente', 'Ejecutiva'],
			['x', 'CL0001', 'Grúas SA', 100, 'KARINA'],
			[null, null, null, null, null],
			['y', 'CL0002', 'Ana', 50.5, 'YADI'],
			[null, null, null, 150.5, null]
		];
		const table = locateTable(cells, schema)!;
		expect(table.headerRow).toBe(3);
		expect(table.columns).toEqual({ code: 1, name: 2, debt: 3, owner: 4 });
		expect(table.ignored).toEqual(['Notas']);
		expect(table.missing).toEqual([]);
		expect(table.rows.map((r) => [r.sourceRow, r.values.code])).toEqual([
			[4, 'CL0001'],
			[6, 'CL0002']
		]);
		expect(table.footer).toMatchObject({ sourceRow: 7, values: { debt: 150.5 } });
	});

	it('IMP-A2 · si falta una columna obligatoria, la tabla se encuentra igual y dice cuál falta', () => {
		const table = locateTable([['Código', 'Pendiente'], ['CL1', 1]], schema)!;
		expect(table.missing).toEqual(['name']);
	});

	it('IMP-A3 · sin encabezados del formato, no hay tabla', () => {
		expect(locateTable([['a', 'b'], [1, 2]], schema as ImportSchema)).toBeNull();
	});
});

describe('importar · lo que valida el formato (server)', () => {
	const ok = { code: 'CL0001', name: 'Grúas SA', debt: 100, owner: 'u1', issuer: null };

	it('IMP-A4 · filas y formulario con las reglas de sus columnas; el lookup debe existir; la llave no se repite', async () => {
		const result = await format.review({
			rows: [ok, { code: 'X1', name: '', debt: -1, owner: 'nadie', issuer: 'HT' }, { ...ok }],
			fields: { corte: null, issuer: '3C' }
		});
		expect(result.ok).toBe(false);
		expect(result.issues).toEqual(
			expect.arrayContaining([
				{ row: null, field: 'corte', level: 'error', message: 'Fecha de corte: No admite vacío' },
				{ row: 1, field: 'code', level: 'error', message: 'Formato inválido' },
				{ row: 1, field: 'name', level: 'error', message: 'No admite vacío' },
				{ row: 1, field: 'debt', level: 'error', message: expect.stringMatching(/menor que 0/) },
				{ row: 1, field: 'owner', level: 'error', message: 'No corresponde a ningún registro' },
				{ row: 2, field: 'code', level: 'error', message: 'Repetido: igual que la fila 1' }
			])
		);
	});

	it('IMP-A5 · «either»: la fila manda; si no trae, el formulario; si ninguno, un solo error', async () => {
		const good = await format.review({ rows: [ok, { ...ok, code: 'CL0002', issuer: 'HT' }], fields: { corte: '2026-03-11', issuer: '3C' } });
		expect(good).toMatchObject({ ok: true, summary: { rows: 2, filas: 2, emisora: '3C' } });
		const none = await format.review({ rows: [ok], fields: { corte: '2026-03-11', issuer: null } });
		expect(none.issues).toEqual([{ row: null, field: 'issuer', level: 'error', message: 'Emisora: falta (ni en el archivo ni en el formulario)' }]);
	});

	it('IMP-A6 · la suma de control: lo que llega suma lo del pie del archivo', async () => {
		const wrong = await format.review({ rows: [ok], fields: { corte: '2026-03-11', issuer: '3C' }, checksum: { debt: 99 } });
		expect(wrong.issues).toEqual([{ row: null, field: 'debt', level: 'error', message: 'La suma de «Pendiente» (100.00) no cuadra con el total del archivo (99.00)' }]);
		expect((await format.review({ rows: [ok], fields: { corte: '2026-03-11', issuer: '3C' }, checksum: { debt: 100 } })).ok).toBe(true);
	});

	it('IMP-A7 · texto pegado → registro del lookup, por su valor o su nombre', async () => {
		expect((await format.resolve('owner', ['Karina Gloria', 'YADI', 'Nadie'])).matches).toEqual({
			'Karina Gloria': [people[0]],
			YADI: [],
			Nadie: []
		});
	});
});

describe('importar · rutas (ejemplo encendido)', () => {
	it('IMP-A8 · lista, esquema con alias y «from», revisar y aplicar; aplicar vuelve a validar', async () => {
		const list = await api('/api/imports');
		expect(list.body).toEqual([expect.objectContaining({ id: 'contactos', label: 'Contactos' })]);
		const s = (await api('/api/imports/contactos/schema')).body;
		expect(s).toMatchObject({ key: 'email', columns: { status: { from: 'either', aliases: ['Estatus'] }, email: { from: 'file' } } });

		const email = `imp-${Date.now()}@ejemplo.mx`;
		const rows = [{ name: 'Importada', email, credit_limit: 10, since: '2026-01-02', status: null }];
		const bad = await api('/api/imports/contactos/apply', { body: { rows: [{ ...rows[0], email: 'mal' }], fields: { status: 'active' } } });
		expect(bad.body).toMatchObject({ ok: false, applied: false });
		const review = await api('/api/imports/contactos/review', { body: { rows, fields: { status: 'active' } } });
		expect(review.body).toMatchObject({ ok: true, summary: { crear: 1, actualizar: 0 } });
		const applied = await api('/api/imports/contactos/apply', { body: { rows, fields: { status: 'active' } } });
		expect(applied.body).toMatchObject({ ok: true, applied: true, summary: { creados: 1 } });
		const again = await api('/api/imports/contactos/apply', { body: { rows: [{ ...rows[0], name: 'Otra vez' }], fields: { status: 'lead' } } });
		expect(again.body.summary).toMatchObject({ actualizados: 1 });
		const found = (await api(`/api/basic/contacts?search=${encodeURIComponent(email)}`)).body.rows;
		expect(found).toEqual([expect.objectContaining({ name: 'Otra vez', status: 'lead' })]);
		expect((await api('/api/imports/nope/schema')).status).toBe(404);
	});
});
