/**
 * Básicas de la hoja en el navegador (tests/grid/README.md §1): cargar, editar,
 * insertar, eliminar, validar, deshacer y descartar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { FRONT_URL } from '../support/env.ts';
import { GridPage } from '../support/grid.ts';
import { getCase, reset } from '../protocol/support.ts';

const { user } = browserHarness();

beforeEach(async () => {
	await reset();
});

async function open(path = '/cases') {
	const u = await user('A');
	const grid = await new GridPage(u.page).open(`${FRONT_URL}${path}`);
	return { ...u, grid };
}

describe('básicas', () => {
	it('B-1 · carga: esquema del servidor, primer tramo y numeración global', async () => {
		const { grid, page } = await open();
		expect([...grid.columns.keys()]).toEqual(expect.arrayContaining(['ID', 'Cliente', 'RFC', 'Etapa', 'Atiende', 'Promesa']));
		await expect.poll(() => page.locator('.oc-grid__legend').innerText()).toMatch(/Filas 1–60 de 50,000/);
		const rows = await grid.visibleRows();
		expect(rows.length).toBeGreaterThan(0);
		for (const { n, id } of rows) expect(id).toBe(`case_${String(n).padStart(6, '0')}`);
	});

	it('B-2 · editar varias filas y guardar', async () => {
		const { grid } = await open();
		await grid.editText('case_000001', 'Cliente', 'Uno SA');
		await grid.editText('case_000002', 'Cliente', 'Dos SA');
		await grid.editText('case_000003', 'Cliente', 'Tres SA');
		await grid.setField(1, 'Etapa', 'judicial');
		for (const id of ['case_000001', 'case_000002', 'case_000003']) {
			expect(await grid.state(grid.rowById(id), 'Cliente')).toContain('oc-cell-dirty');
		}
		expect(await grid.summary()).toBe('Cambios 3');

		const text = await grid.save();
		expect(text).toContain('Cambios guardados');
		expect(text).toMatch(/Actualizadas\s*3/);
		expect(await getCase('case_000001')).toMatchObject({ customer_name: 'Uno SA', rowVersion: 2 });
		expect(await getCase('case_000002')).toMatchObject({ customer_name: 'Dos SA', stage_code: 'judicial', rowVersion: 2 });
		expect(await getCase('case_000003')).toMatchObject({ customer_name: 'Tres SA', rowVersion: 2 });
	});

	it('B-3 · insertar: arriba en verde con «+», y tras guardar su id real', async () => {
		const { grid, page } = await open();
		await grid.toolbar('Agregar fila');
		await expect.poll(() => grid.row('+').count()).toBe(1);
		expect(await grid.state(grid.row('+'), 'Cliente')).toContain('oc-cell-new');
		await grid.editText('+', 'Cliente', 'Nueva Prueba SA');
		await grid.editText('+', 'RFC', 'NPS900101AA');
		await grid.setField(0, 'Etapa', 'early');
		expect(await grid.summary()).toBe('Cambios 1');

		const text = await grid.save();
		expect(text).toMatch(/Filas creadas\s*1/);
		await grid.closeDialog();
		// Se queda arriba con «✓» y su id real.
		await expect.poll(() => page.locator('.oc-grid__sheet td.jss_row', { hasText: '✓' }).count()).toBe(1);
		expect(await grid.rowById('case_050001').count()).toBe(1);
		expect(await getCase('case_050001')).toMatchObject({ customer_name: 'Nueva Prueba SA', stage_code: 'early' });
	});

	it('B-4 · eliminar: tachada, no editable y, tras guardar, fuera', async () => {
		const { grid, page } = await open();
		await grid.deleteRow('case_000008');
		const row = grid.rowById('case_000008');
		expect(await grid.state(row, 'Cliente')).toContain('oc-row-deleted');
		expect(await grid.summary()).toBe('Cambios 1');

		// No se puede editar (G-7).
		await grid.cell(row, 'Cliente').dblclick();
		expect(await page.locator('.oc-grid__sheet td.editor input').count()).toBe(0);

		const text = await grid.save();
		expect(text).toMatch(/Eliminadas\s*1/);
		await grid.closeDialog();
		await expect.poll(() => grid.rowById('case_000008').count()).toBe(0);
		expect((await getCase('case_000008')).error.code).toBe('not_found');
	});

	it('B-5 · validación: un obligatorio vacío bloquea el guardado', async () => {
		const { grid } = await open();
		const before = (await getCase('case_000004')).customer_name;
		await grid.editText('case_000004', 'Cliente', '');
		expect(await grid.state(grid.rowById('case_000004'), 'Cliente')).toContain('oc-cell-invalid');

		expect(await grid.save()).toContain('El cambio no se envió');
		expect((await getCase('case_000004')).customer_name).toBe(before);
	});

	it('B-6 · deshacer y rehacer: edición, alta y baja', async () => {
		const { grid, page } = await open();
		const original = await grid.text(grid.rowById('case_000001'), 'Cliente');
		await grid.editText('case_000001', 'Cliente', 'U1');
		await grid.toolbar('Agregar fila');
		await expect.poll(() => grid.row('+').count()).toBe(1);
		await grid.deleteRow('case_000003');

		await grid.toolbar('Deshacer');
		await expect.poll(() => grid.state(grid.rowById('case_000003'), 'Cliente')).not.toContain('oc-row-deleted');
		await grid.toolbar('Deshacer');
		await expect.poll(() => grid.row('+').count()).toBe(0);
		// La última, con el teclado.
		await grid.select('case_000010', 'Cliente');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => grid.text(grid.rowById('case_000001'), 'Cliente')).toBe(original);
		expect(await grid.state(grid.rowById('case_000001'), 'Cliente')).not.toContain('oc-cell-dirty');

		await grid.toolbar('Rehacer');
		await expect.poll(() => grid.text(grid.rowById('case_000001'), 'Cliente')).toBe('U1');
		await grid.toolbar('Rehacer');
		await expect.poll(() => grid.row('+').count()).toBe(1);
		await grid.toolbar('Rehacer');
		await expect.poll(() => grid.state(grid.rowById('case_000003'), 'Cliente')).toContain('oc-row-deleted');
	});

	it('B-7 · descartar: todo vuelve y el borrador se borra', async () => {
		const { grid, page } = await open();
		const original = await grid.text(grid.rowById('case_000001'), 'Cliente');
		await grid.editText('case_000001', 'Cliente', 'Descartable');
		await grid.toolbar('Agregar fila');
		await grid.deleteRow('case_000003');

		await grid.toolbar('Cancelar');
		await expect.poll(() => grid.text(grid.rowById('case_000001'), 'Cliente')).toBe(original);
		expect(await grid.row('+').count()).toBe(0);
		expect(await grid.state(grid.rowById('case_000003'), 'Cliente')).not.toContain('oc-row-deleted');

		await page.waitForTimeout(600);
		await page.reload();
		await grid.open(`${FRONT_URL}/cases`);
		await page.waitForTimeout(500);
		expect(await grid.restoreNotice().count()).toBe(0);
		expect(await grid.state(grid.rowById('case_000001'), 'Cliente')).not.toContain('oc-cell-dirty');
	});

	it('B-8 · sin servidor: editar, deshacer y guardar en la fuente local', async () => {
		const { grid } = await open('/local');
		const first = grid.rows().first();
		const original = await grid.text(first, 'Notas');
		await grid.editText(1, 'Notas', 'nota de prueba');
		expect(await grid.state(first, 'Notas')).toContain('oc-cell-dirty');
		await grid.toolbar('Deshacer');
		await expect.poll(() => grid.text(first, 'Notas')).toBe(original);

		await grid.editText(1, 'Notas', 'nota guardada');
		expect(await grid.save()).toContain('Cambios guardados');
		await grid.closeDialog();
		expect(await grid.state(grid.rows().first(), 'Notas')).not.toContain('oc-cell-dirty');
	});
});
