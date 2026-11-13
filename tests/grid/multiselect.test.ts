/**
 * Selección múltiple (SB-41) en el navegador, sobre «Agencias» del catálogo
 * (`/catalog?view=agencias`): etiquetas en la celda con «+N», editor con
 * casillas y teclado, pegar y copiar «BYD, Honda», validación y el filtro del
 * encabezado «contiene alguna de» con la cuenta de cada opción.
 */
import type { Locator, Page } from 'playwright';
import { beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { API_URL, FRONT_URL } from '../support/env.ts';
import { GridPage, uiButton } from '../support/grid.ts';

const { user } = browserHarness();
const BASE = `${API_URL}/api/catalog`;

async function open() {
	const u = await user('A');
	const grid = await new GridPage(u.page).open(`${FRONT_URL}/catalog?view=agencias`);
	return { ...u, grid };
}

const chips = (cell: Locator) => cell.locator('.oc-chip:not(.oc-chip--more):not([hidden]) .oc-chip__text').allInnerTexts();
const editor = (page: Page) => page.locator('.oc-cell-editor.oc-multi-editor');
const brandsOf = async (id: string) => (await (await fetch(`${BASE}/agencies/${id}`)).json()).brands;

async function pasteInto(cell: Locator, text: string) {
	await cell.click();
	await cell.evaluate((td, text) => {
		const data = new DataTransfer();
		data.setData('text/plain', text);
		td.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	}, text);
}

async function copyFrom(cell: Locator): Promise<string> {
	await cell.click();
	return cell.evaluate((td) => {
		const data = new DataTransfer();
		td.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
		return data.getData('text/plain');
	});
}

beforeEach(async () => {
	await fetch(`${BASE}/reset`, { method: 'POST' });
});

describe('selección múltiple (SB-41)', () => {
	it('MS-1 · la celda muestra cada marca como etiqueta, «+N» si no caben, y todas al pasar el cursor', async () => {
		const { grid, shot } = await open();
		const cell = (id: string) => grid.cell(grid.rowById(id), 'Marcas');
		await expect.poll(() => chips(cell('ag_1'))).toEqual(['BYD', 'Honda']);
		expect(await cell('ag_4').locator('.oc-chip').count()).toBe(0);
		// Seis marcas en 220 px: las que caben y el resto en «+N».
		const sur = cell('ag_3');
		await expect.poll(() => sur.locator('.oc-chip--more').count()).toBe(1);
		const shown = (await chips(sur)).length;
		expect(shown).toBeGreaterThan(0);
		expect(await sur.locator('.oc-chip--more').innerText()).toBe(`+${6 - shown}`);
		expect(await sur.locator('.oc-picker').getAttribute('title')).toBe('BYD, Chevrolet, Kia, Mazda, Nissan, Toyota');
		await shot('celdas');
	});

	it('MS-2 · el editor marca varias con clic y con teclado (flechas y espacio); Enter confirma en el orden del catálogo y se guarda', async () => {
		const { grid, page, shot } = await open();
		const row = grid.rowById('ag_2');
		const cell = grid.cell(row, 'Marcas');
		await cell.dblclick();
		await editor(page).waitFor();
		// Con más de ocho opciones, un buscador.
		const search = editor(page).locator('input.oc-cell-editor__input');
		expect(await search.count()).toBe(1);
		await editor(page).locator('.oc-multi-option', { hasText: 'Toyota' }).click();
		// Teclado: filtrar, bajar y marcar con espacio.
		await search.fill('ho');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowUp');
		await search.fill('');
		await page.keyboard.press('Space');
		expect(await editor(page).locator('.oc-multi-option[aria-selected="true"]').allInnerTexts()).toEqual(['BYD', 'Chevrolet', 'Toyota']);
		await shot('editor');
		await page.keyboard.press('Enter');
		await editor(page).waitFor({ state: 'detached' });
		await expect.poll(() => chips(cell)).toEqual(['BYD', 'Chevrolet', 'Toyota']);
		expect(await grid.state(row, 'Marcas')).toContain('oc-cell-dirty');
		expect(await grid.save()).toContain('Cambios guardados');
		expect(await brandsOf('ag_2')).toEqual(['byd', 'chevrolet', 'toyota']);
	});

	it('MS-3 · salir de la celda confirma lo marcado; Escape lo descarta; «Limpiar» la deja vacía', async () => {
		const { grid, page } = await open();
		const cell = grid.cell(grid.rowById('ag_5'), 'Marcas');
		await cell.dblclick();
		await editor(page).locator('.oc-multi-option', { hasText: 'Kia' }).click();
		// «Guardar» en vivo: lo marcado ya es un cambio.
		await expect.poll(() => uiButton(page, 'Guardar').first().isEnabled()).toBe(true);
		await page.locator('h1').first().click();
		await expect.poll(() => chips(cell)).toEqual(['Honda', 'Kia', 'Toyota']);

		await cell.dblclick();
		await editor(page).locator('.oc-multi-option', { hasText: 'BYD' }).click();
		await page.keyboard.press('Escape');
		expect(await chips(cell)).toEqual(['Honda', 'Kia', 'Toyota']);

		await cell.dblclick();
		await editor(page).getByRole('button', { name: 'Limpiar' }).click();
		await editor(page).getByRole('button', { name: 'Aceptar' }).click();
		expect(await cell.locator('.oc-chip').count()).toBe(0);
	});

	it('MS-4 · pegar «BYD, Honda» elige esas marcas; copiar da «BYD, Honda»; lo que no es del catálogo se marca inválido', async () => {
		const { grid } = await open();
		const poniente = grid.cell(grid.rowById('ag_4'), 'Marcas');
		await pasteInto(poniente, 'honda; BYD');
		await expect.poll(() => chips(poniente)).toEqual(['BYD', 'Honda']);
		expect(await copyFrom(grid.cell(grid.rowById('ag_1'), 'Marcas'))).toBe('BYD, Honda');

		const norte = grid.cell(grid.rowById('ag_2'), 'Marcas');
		await pasteInto(norte, 'Chevrolet, Ferrari');
		await expect.poll(() => chips(norte)).toEqual(['Chevrolet', 'Ferrari']);
		expect(await grid.state(grid.rowById('ag_2'), 'Marcas')).toContain('oc-cell-invalid');
	});

	it('MS-5 · el filtro del encabezado: cada marca con cuántas agencias la tienen; elegir una deja las que la contienen', async () => {
		const { grid, page } = await open();
		await page.locator('.oc-grid__sheet thead td').filter({ hasText: /^Marcas$/ }).first().hover();
		await page.getByRole('button', { name: /^Ordenar y filtrar «Marcas»/ }).first().click();
		const dialog = page.getByRole('dialog', { name: 'Ordenar y filtrar «Marcas»' });
		const list = dialog.getByRole('region', { name: 'Valores' });
		await list.getByText('Honda', { exact: true }).waitFor();
		const items = await list.locator('li').evaluateAll((lis) =>
			lis.map((li) => [li.querySelector('span.truncate')?.textContent?.trim(), li.querySelector('span.tabular-nums')?.textContent?.trim()]).filter(([l]) => l)
		);
		expect(items).toContainEqual(['Honda', '2']);
		expect(items).toContainEqual(['Kia', '1']);
		expect(items).toContainEqual(['(Vacías)', '1']);

		await list.getByRole('checkbox', { name: 'Seleccionar todo' }).uncheck();
		await list.locator('li').filter({ has: page.getByText('Honda', { exact: true }) }).getByRole('checkbox').check();
		await dialog.getByRole('button', { name: 'Aplicar' }).click();
		const visibleIds = () => page.locator('.oc-grid__sheet tbody tr').evaluateAll((trs) => trs.map((tr) => tr.children[1]?.textContent?.trim() ?? '').filter((t) => t.startsWith('ag_')).sort());
		await expect.poll(visibleIds).toEqual(['ag_1', 'ag_5']);
	});
});
