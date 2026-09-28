/**
 * El borrador local en IndexedDB (tests/grid/README.md §3): sobrevive a recargar
 * y a cerrar la pestaña, conserva el historial y se limpia al guardar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright';
import { browserHarness } from '../support/browser.ts';
import { FRONT_URL } from '../support/env.ts';
import { GridPage } from '../support/grid.ts';
import { reset } from '../protocol/support.ts';

const { user } = browserHarness();

beforeEach(async () => {
	await reset();
});

async function open() {
	const u = await user('A');
	const grid = await new GridPage(u.page).open(`${FRONT_URL}/`);
	return { ...u, grid };
}

/** Deja que el borrador llegue a IndexedDB (se escribe agrupado cada ~300 ms). */
const flushDraft = (grid: GridPage) => grid.page.waitForTimeout(700);

/** Edita la 5, elimina la 8 y agrega una fila con nombre. */
async function makeChanges(grid: GridPage) {
	await grid.editText('case_000005', 'Cliente', 'Borrador SA');
	await grid.deleteRow('case_000008');
	await grid.toolbar('Agregar fila');
	await expect.poll(() => grid.row('+').count()).toBe(1);
	await grid.editText('+', 'Cliente', 'Nueva del borrador');
}

async function expectChanges(grid: GridPage) {
	await expect.poll(() => grid.text(grid.rowById('case_000005'), 'Cliente')).toBe('Borrador SA');
	expect(await grid.state(grid.rowById('case_000005'), 'Cliente')).toContain('oc-cell-dirty');
	expect(await grid.state(grid.rowById('case_000008'), 'Cliente')).toContain('oc-row-deleted');
	expect(await grid.text(grid.row('+'), 'Cliente')).toBe('Nueva del borrador');
	// 3 filas pendientes; 2 celdas con error: la nueva aún no tiene RFC ni Etapa, que son obligatorios.
	expect(await grid.summary()).toBe('Cambios 3 2');
}

describe('borrador', () => {
	it('D-1 · recargar recupera edición, baja y alta, con aviso', async () => {
		const { grid, page } = await open();
		await makeChanges(grid);
		await flushDraft(grid);
		await page.reload();
		await grid.open(`${FRONT_URL}/`);
		await expect.poll(() => grid.restoreNotice().count()).toBe(1);
		await expectChanges(grid);
	});

	it('D-2 · deshacer y rehacer funcionan tras recargar', async () => {
		const { grid, page } = await open();
		await makeChanges(grid);
		await flushDraft(grid);
		await page.reload();
		await grid.open(`${FRONT_URL}/`);
		await expectChanges(grid);

		await grid.toolbar('Deshacer');
		await expect.poll(() => grid.text(grid.row('+'), 'Cliente')).toBe('');
		await grid.toolbar('Deshacer');
		await expect.poll(() => grid.row('+').count()).toBe(0);
		await grid.toolbar('Rehacer');
		await grid.toolbar('Rehacer');
		await expect.poll(() => grid.text(grid.row('+'), 'Cliente')).toBe('Nueva del borrador');
	});

	it('D-3 · sobrevive a cerrar la pestaña (G-9)', async () => {
		const A = await open();
		await makeChanges(A.grid);
		await flushDraft(A.grid);
		const context = (A as unknown as { context: BrowserContext }).context;
		const page = await context.newPage();
		await A.page.close();
		const grid = await new GridPage(page).open(`${FRONT_URL}/`);
		await expectChanges(grid);
	});

	it('D-4 · guardar limpia el borrador', async () => {
		const { grid, page } = await open();
		await grid.editText('case_000005', 'Cliente', 'Guardado SA');
		expect(await grid.save()).toContain('Cambios guardados');
		await grid.closeDialog();
		await flushDraft(grid);
		await page.reload();
		await grid.open(`${FRONT_URL}/`);
		await page.waitForTimeout(500);
		expect(await grid.restoreNotice().count()).toBe(0);
		expect(await grid.summary()).toBe('Cambios 0');
		expect(await grid.text(grid.rowById('case_000005'), 'Cliente')).toBe('Guardado SA');
	});
});
