/**
 * Ordenar y filtrar desde el encabezado de una columna (SB-33), sobre la hoja
 * de casos (`/cases`, 50 000 filas en el servidor): por valores con casillas,
 * por condición, el orden, el panel «Filtros» y lo que se recuerda.
 */
import type { Page } from 'playwright';
import { beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { api } from '../support/api.ts';
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

/** Total de filas del pie: «Filas 1–60 de 12,345». */
async function total(page: Page): Promise<number> {
	const text = await page.locator('.oc-grid__legend').innerText();
	const m = text.match(/de ([\d,]+)/);
	return m ? Number(m[1]!.replace(/,/g, '')) : NaN;
}

/** Cuántas filas da la API con estos filtros de columna. */
async function apiTotal(where: unknown[]): Promise<number> {
	return (await api(`/api/cases?limit=1&where=${encodeURIComponent(JSON.stringify(where))}`)).body.total;
}

/** Abre el menú del encabezado de una columna. */
async function menu(page: Page, label: string) {
	await page.locator('.oc-grid__sheet thead td').filter({ hasText: new RegExp(`^${label}$`) }).first().hover();
	await page.getByRole('button', { name: new RegExp(`^Ordenar y filtrar «${label}»`) }).first().click();
	const dialog = page.getByRole('dialog', { name: `Ordenar y filtrar «${label}»` });
	await dialog.waitFor();
	return dialog;
}

const column = (page: Page, grid: GridPage, label: string) =>
	page.locator('.oc-grid__sheet tbody tr').evaluateAll(
		(trs, x) => trs.map((tr) => tr.children[x]?.textContent?.trim() ?? '').filter((t) => t !== ''),
		grid.columns.get(label)!
	);

describe('filtros por columna (SB-33)', () => {
	it('FC-1 · por valores: la lista trae cada etapa con su cuenta; dejar una sola filtra la hoja y lo marca', async () => {
		const { page, grid, shot } = await open();
		const all = await total(page);
		const dialog = await menu(page, 'Etapa');
		const list = dialog.getByRole('region', { name: 'Valores' });
		await list.getByText('Judicial', { exact: true }).waitFor();
		// Las etiquetas del catálogo, en orden alfabético, y las cuentas suman el total.
		const labels = await list.locator('li span.truncate').allTextContents();
		expect(labels).toEqual(['Extrajudicial', 'Judicial', 'Mora tardía', 'Mora temprana', 'Preventiva']);
		const counts = (await list.locator('li span.tabular-nums').allTextContents()).map(Number);
		expect(counts.reduce((a, b) => a + b, 0)).toBe(all);
		await shot('valores');

		await list.getByRole('checkbox', { name: 'Seleccionar todo' }).uncheck();
		await list.locator('li').filter({ has: page.getByText('Judicial', { exact: true }) }).getByRole('checkbox').check();
		await dialog.getByRole('button', { name: 'Aplicar' }).click();

		const judicial = await apiTotal([{ field: 'stage_code', op: 'in', values: ['judicial'] }]);
		await expect.poll(() => total(page)).toBe(judicial);
		expect(new Set(await column(page, grid, 'Etapa'))).toEqual(new Set(['Judicial']));
		// El encabezado lo marca y la barra cuenta un filtro.
		expect(await page.getByRole('button', { name: 'Ordenar y filtrar «Etapa» (filtrada)' }).count()).toBeGreaterThan(0);
		expect(await page.getByRole('button', { name: /Filtros/ }).first().innerText()).toContain('1');
		await shot('filtrada');
	});

	it('FC-2 · por condición: número mayor que, y texto «contiene» sin acentos; se combinan con Y', async () => {
		const { page, grid } = await open();
		let dialog = await menu(page, 'DPD');
		await dialog.getByLabel('Filtrar por condición').selectOption({ label: 'Mayor que' });
		await dialog.getByLabel('Valor', { exact: true }).fill('150');
		await dialog.getByLabel('Valor', { exact: true }).press('Enter');
		const dpd = [{ field: 'dpd', op: 'gt', value: 150 }];
		await expect.poll(() => total(page)).toBe(await apiTotal(dpd));
		expect((await column(page, grid, 'DPD')).every((t) => Number(t.replace(/,/g, '')) > 150)).toBe(true);

		dialog = await menu(page, 'Cliente');
		await dialog.getByLabel('Filtrar por condición').selectOption({ label: 'Contiene' });
		await dialog.getByLabel('Valor', { exact: true }).fill('GRUAS');
		await dialog.getByRole('button', { name: 'Aplicar' }).click();
		const both = [...dpd, { field: 'customer_name', op: 'contains', value: 'GRUAS' }];
		const expected = await apiTotal(both);
		expect(expected).toBeGreaterThan(0);
		await expect.poll(() => total(page)).toBe(expected);
		expect((await column(page, grid, 'Cliente')).every((t) => /gr[uú]as/i.test(t))).toBe(true);
	});

	it('FC-3 · ordenar desde el encabezado: de mayor a menor, y quitar el orden', async () => {
		const { page, grid } = await open();
		const dialog = await menu(page, 'Vencido');
		await dialog.getByRole('button', { name: 'De mayor a menor' }).click();
		await expect
			.poll(async () => {
				const values = (await column(page, grid, 'Vencido')).map((t) => Number(t.replace(/[$,]/g, '')));
				return values.length > 10 && values.every((v, i) => i === 0 || values[i - 1]! >= v);
			})
			.toBe(true);
		expect(await page.getByRole('button', { name: 'Ordenar y filtrar «Vencido» (orden descendente)' }).count()).toBeGreaterThan(0);
		const top = (await api('/api/cases?limit=1&sort=overdue_amount:desc')).body.rows[0].id;
		expect((await grid.visibleRows())[0]!.id).toBe(top);
	});

	it('FC-4 · el panel «Filtros» los dice en palabras y los quita; la pestaña los recuerda al volver', async () => {
		const { page } = await open();
		const all = await total(page);
		const dialog = await menu(page, 'DPD');
		await dialog.getByLabel('Filtrar por condición').selectOption({ label: 'Entre' });
		await dialog.getByLabel('Valor', { exact: true }).fill('10');
		await dialog.getByLabel('Hasta', { exact: true }).fill('20');
		await dialog.getByRole('button', { name: 'Aplicar' }).click();
		const expected = await apiTotal([{ field: 'dpd', op: 'between', value: 10, value2: 20 }]);
		await expect.poll(() => total(page)).toBe(expected);

		// Recargar la página: el filtro sigue (sessionStorage de la pestaña).
		await page.reload();
		await new GridPage(page).open(page.url());
		await expect.poll(() => total(page)).toBe(expected);

		await page.getByRole('button', { name: /Filtros/ }).first().click();
		const panel = page.getByRole('complementary', { name: 'Filtros' });
		await panel.getByText('DPD entre 10 y 20').waitFor();
		await panel.getByRole('button', { name: 'Quitar filtro: DPD entre 10 y 20' }).click();
		await expect.poll(() => total(page)).toBe(all);
		await panel.getByText('Sin filtros', { exact: true }).waitFor();
	});

	it('FC-6 · con una celda activa, lo que se teclea en el menú va al menú, no a la hoja; Enter aplica y Esc cierra', async () => {
		const { page, grid } = await open();
		const first = (await grid.visibleRows())[0]!.id;
		// Una celda seleccionada: jspreadsheet toma el teclado de todo el documento.
		await grid.cell(grid.rowById(first), 'Cliente').click();

		let dialog = await menu(page, 'Etapa');
		const search = dialog.getByRole('searchbox', { name: 'Buscar valores' });
		await search.click();
		await search.pressSequentially('mora');
		expect(await search.inputValue()).toBe('mora');
		await expect.poll(() => dialog.locator('li span.truncate').allTextContents()).toEqual(['Mora tardía', 'Mora temprana']);
		await page.keyboard.press('Escape');
		await dialog.waitFor({ state: 'detached' });

		dialog = await menu(page, 'Cliente');
		await dialog.getByLabel('Filtrar por condición').selectOption({ label: 'Contiene' });
		const value = dialog.getByLabel('Valor', { exact: true });
		await value.click();
		await value.pressSequentially('grúas');
		expect(await value.inputValue()).toBe('grúas');
		await page.keyboard.press('Enter');
		await dialog.waitFor({ state: 'detached' });
		await expect.poll(() => total(page)).toBe(await apiTotal([{ field: 'customer_name', op: 'contains', value: 'grúas' }]));
		// Nada se escribió en la hoja.
		expect(await grid.summary()).toBe('Cambios 0');
	});

	it('FC-5 · un cambio sin guardar sobrevive a filtrar y a quitar el filtro', async () => {
		const { page, grid } = await open();
		const first = (await grid.visibleRows())[0]!.id;
		await grid.editText(first, 'Cliente', 'Cliente editado FC-5');
		expect(await grid.summary()).toContain('1');

		const dialog = await menu(page, 'Cliente');
		await dialog.getByLabel('Filtrar por condición').selectOption({ label: 'Empieza con' });
		await dialog.getByLabel('Valor', { exact: true }).fill('zzz-nadie');
		await dialog.getByRole('button', { name: 'Aplicar' }).click();
		await expect.poll(() => total(page)).toBe(0);
		expect(await grid.summary()).toContain('1');

		const again = await menu(page, 'Cliente');
		await again.getByRole('button', { name: 'Quitar filtro' }).click();
		await expect.poll(async () => grid.text(grid.rowById(first), 'Cliente')).toBe('Cliente editado FC-5');
	});
});
