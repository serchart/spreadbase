/**
 * La ventana sobre 50 000 filas (tests/grid/README.md §2): desplazarse, salir y
 * volver, deshacer fuera de la vista, ir a una fila lejana y agregar lejos.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
	const grid = await new GridPage(u.page).open(`${FRONT_URL}/cases`);
	return { ...u, grid };
}

/** Numeración global = id, y nunca más filas en el DOM que la ventana (180). */
async function expectCoherent(grid: GridPage) {
	const rows = await grid.visibleRows();
	expect(rows.length).toBeLessThanOrEqual(180);
	for (const { n, id } of rows) expect(id).toBe(`case_${String(n).padStart(6, '0')}`);
}

describe('ventana', () => {
	it('V-1 · desplazarse lejos y volver sin incoherencias', async () => {
		const { grid } = await open();
		await grid.scrollUntil('down', async () => {
			await expectCoherent(grid);
			return (await grid.windowStart()) >= 1_000;
		});
		await grid.scrollUntil('up', async () => {
			await expectCoherent(grid);
			return (await grid.windowStart()) === 1;
		});
	});

	it('V-2 · una fila editada sale de la ventana y vuelve con su cambio', async () => {
		const { grid } = await open();
		await grid.editText('case_000005', 'Cliente', 'Retenida SA');
		await grid.scrollUntil('down', async () => (await grid.windowStart()) >= 1_400);
		expect(await grid.rowById('case_000005').count()).toBe(0);
		expect(await grid.summary()).toBe('Cambios 1');

		await grid.scrollUntil('up', async () => (await grid.rowById('case_000005').count()) === 1);
		const row = grid.rowById('case_000005');
		expect(await grid.text(row, 'Cliente')).toBe('Retenida SA');
		expect(await grid.state(row, 'Cliente')).toContain('oc-cell-dirty');
	});

	it('V-3 · deshacer y rehacer fuera de la vista no mueven el scroll (G-1)', async () => {
		const { grid } = await open();
		await grid.editText('case_000005', 'Cliente', 'Fuera de vista SA');
		await grid.scrollUntil('down', async () => (await grid.windowStart()) >= 600);
		const scroll = await grid.scrollTop();

		await grid.toolbar('Deshacer');
		await expect.poll(() => grid.summary()).toBe('Cambios 0');
		expect(await grid.scrollTop()).toBe(scroll);

		await grid.toolbar('Rehacer');
		await expect.poll(() => grid.summary()).toBe('Cambios 1');
		expect(await grid.scrollTop()).toBe(scroll);
	});

	it('V-4 · ir a la fila desde el panel, lejos y de vuelta', async () => {
		const { grid, page } = await open();
		await grid.editText('case_000005', 'Cliente', 'Cerca SA');
		await grid.scrollUntil('down', async () => (await grid.rowById('case_002344').count()) === 1, 90_000);
		await grid.editText('case_002344', 'Cliente', 'Lejos SA');

		await grid.toolbar('Cambios');
		const jump = (id: string) => grid.panelRow(id).locator('button[title^="Ir a la fila"]').click();

		await jump('case_000005');
		await expect.poll(() => grid.inView('case_000005'), { timeout: 15_000 }).toBe(true);
		expect(await grid.text(grid.rowById('case_000005'), 'Cliente')).toBe('Cerca SA');

		await jump('case_002344');
		await expect.poll(() => grid.inView('case_002344'), { timeout: 15_000 }).toBe(true);
		expect(await grid.text(grid.rowById('case_002344'), 'Cliente')).toBe('Lejos SA');
		await page.waitForTimeout(300);
		await expectCoherent(grid);
	});

	it('V-5 · agregar lejos del inicio lleva arriba (G-2)', async () => {
		const { grid } = await open();
		await grid.scrollUntil('down', async () => (await grid.windowStart()) >= 600);
		await grid.toolbar('Agregar fila');
		await expect.poll(() => grid.row('+').count(), { timeout: 15_000 }).toBe(1);
		expect(await grid.windowStart()).toBe(1);
	});
});
