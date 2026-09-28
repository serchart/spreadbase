/**
 * Columnas del cliente sobre el esquema del servidor (SB-23): parches,
 * funciones, columnas solo del cliente y el atajo `actions`.
 */
import { describe, expect, it } from 'vitest';
import { actionField, applyColumnOverrides } from './columns';
import type { ColumnAction, ColumnDef } from './types';

const server: ColumnDef[] = [
	{ field: 'name', label: 'Nombre', type: 'text', width: 200 },
	{ field: 'status', label: 'Estado', type: 'select', readOnly: true }
];
const open: ColumnAction = { label: 'Abrir', onclick: () => {} };

describe('columnas del cliente (SB-23)', () => {
	it('sin ajustes, el esquema del servidor tal cual', () => {
		expect(applyColumnOverrides(server)).toEqual(server);
	});

	it('un parche se mezcla sobre la columna del servidor', () => {
		const [name] = applyColumnOverrides(server, { name: { width: 320 } });
		expect(name).toEqual({ field: 'name', label: 'Nombre', type: 'text', width: 320 });
	});

	it('una función recibe la columna del servidor y devuelve la final', () => {
		const [, status] = applyColumnOverrides(server, { status: (col) => ({ ...col, label: `${col!.label} actual` }) });
		expect(status).toMatchObject({ field: 'status', label: 'Estado actual', type: 'select', readOnly: true });
	});

	it('el campo no se renombra: es la llave con la que la fila viaja al servidor', () => {
		const [name] = applyColumnOverrides(server, { name: { field: 'otro' } });
		expect(name!.field).toBe('name');
	});

	it('una columna que no está en el esquema es solo del cliente: al final por defecto, o al principio, y de solo lectura', () => {
		const columns = applyColumnOverrides(server, {
			nota: { type: 'text', label: 'Nota', readOnly: false },
			ver: { type: 'action', action: open, at: 'start' }
		});
		expect(columns.map((c) => c.field)).toEqual(['ver', 'name', 'status', 'nota']);
		expect(columns[0]).toMatchObject({ type: 'action', label: '', readOnly: true, action: open });
		expect(columns[3]!.readOnly).toBe(true);
	});

	it('una columna nueva sin tipo es un error explícito', () => {
		expect(() => applyColumnOverrides(server, { nada: { label: 'Nada' } })).toThrow(/«nada».*type/);
	});

	it('`actions` es un atajo: columnas `action` al principio, en su orden, antes que otras del principio', () => {
		const edit: ColumnAction = { label: 'Editar', showLabel: false, onclick: () => {} };
		const columns = applyColumnOverrides(server, { extra: { type: 'action', action: open, at: 'start' } }, [open, edit]);
		expect(columns.map((c) => c.field)).toEqual([actionField(0), actionField(1), 'extra', 'name', 'status']);
		expect(columns[0]).toMatchObject({ type: 'action', action: open, width: 100, readOnly: true });
		expect(columns[1]).toMatchObject({ action: edit, width: 50 });
	});

	it('un ajuste explícito de una acción gana sobre el atajo (es la misma columna)', () => {
		const [first] = applyColumnOverrides(server, { [actionField(0)]: (col) => ({ ...col, width: 70 }) }, [open]);
		expect(first).toMatchObject({ field: actionField(0), type: 'action', width: 70, action: open });
	});
});
