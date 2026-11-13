/**
 * Salir de la celda confirma lo escrito (tests/grid/README.md §1, B-9…B-16),
 * como en Google Sheets: perder el foco equivale a Enter, Escape descarta.
 *
 * Se escribe tecla por tecla (no `fill`) y no se pulsa Enter: el gesto exacto
 * de quien teclea «SAD» y hace clic en otro lado.
 */
import type { Page } from 'playwright';
import { beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { FRONT_URL } from '../support/env.ts';
import { GridPage, uiButton } from '../support/grid.ts';
import { getCase, reset } from '../protocol/support.ts';

const { user } = browserHarness();

beforeEach(async () => {
	await reset();
});

async function open() {
	const u = await user('A');
	const grid = await new GridPage(u.page).open(`${FRONT_URL}/cases`);
	return { ...u, grid };
}

const EDITOR = '.oc-grid__sheet td.editor input';

/** Doble clic en la celda y teclea, sin confirmar. */
async function typeInto(grid: GridPage, idOrPlus: string | '+', field: string, text: string) {
	const row = idOrPlus === '+' ? grid.row('+') : grid.rowById(idOrPlus);
	await grid.cell(row, field).scrollIntoViewIfNeeded();
	await grid.cell(row, field).dblclick();
	await grid.page.locator(EDITOR).waitFor();
	// El editor nativo abre con el valor y el cursor al final: se reemplaza todo.
	await grid.page.keyboard.press('ControlOrMeta+a');
	await grid.page.keyboard.type(text);
}

describe('salir de la celda confirma', () => {
	it('B-9 · clic en otra celda: fila nueva y fila existente, texto, número y texto con avatar', async () => {
		const { grid, page } = await open();
		await grid.toolbar('Agregar fila');
		await expect.poll(() => grid.row('+').count()).toBe(1);

		// Cliente lleva avatar (editor propio); RFC usa el editor nativo.
		await typeInto(grid, '+', 'Cliente', 'SAD');
		await grid.cell(grid.row('+'), 'RFC').click();
		expect(await page.locator(EDITOR).count()).toBe(0);
		expect(await grid.text(grid.row('+'), 'Cliente')).toBe('SAD');
		expect(await grid.state(grid.row('+'), 'Cliente')).not.toContain('oc-cell-invalid');

		await typeInto(grid, '+', 'RFC', 'SAD900101AA');
		await grid.cell(grid.row('+'), 'Cliente').click();
		expect(await grid.text(grid.row('+'), 'RFC')).toBe('SAD900101AA');
		expect(await grid.state(grid.row('+'), 'RFC')).not.toContain('oc-cell-invalid');

		const existing = grid.rowById('case_000002');
		await typeInto(grid, 'case_000002', 'Cliente', 'Dos Clic SA');
		await grid.cell(grid.rowById('case_000003'), 'Cliente').click();
		expect(await grid.text(existing, 'Cliente')).toBe('Dos Clic SA');
		expect(await grid.state(existing, 'Cliente')).toContain('oc-cell-dirty');

		await typeInto(grid, 'case_000002', 'Promesa', '1234');
		await grid.cell(grid.rowById('case_000003'), 'Cliente').click();
		expect(await grid.state(existing, 'Promesa')).toContain('oc-cell-dirty');
		expect(await grid.text(existing, 'Promesa')).toBe('$1,234.00');
		expect(await grid.summary()).toMatch(/^Cambios 2\b/);
	});

	it('B-10 · clic fuera de la hoja', async () => {
		const { grid, page } = await open();
		await typeInto(grid, 'case_000002', 'Cliente', 'Fuera SA');
		await page.locator('h1').first().click();
		expect(await page.locator(EDITOR).count()).toBe(0);
		expect(await grid.text(grid.rowById('case_000002'), 'Cliente')).toBe('Fuera SA');
		expect(await grid.summary()).toBe('Cambios 1');
	});

	it('B-11 · Guardar con la celda en edición: el valor entra al lote', async () => {
		const { grid } = await open();
		// Con un cambio previo Guardar ya está activo (como con una fila nueva).
		await grid.editText('case_000003', 'Cliente', 'Tres Enter SA');
		await typeInto(grid, 'case_000002', 'Cliente', 'Guardado Directo SA');
		const text = await grid.save();
		expect(text).toMatch(/Actualizadas\s*2/);
		expect(await getCase('case_000002')).toMatchObject({ customer_name: 'Guardado Directo SA', rowVersion: 2 });
		expect(await getCase('case_000003')).toMatchObject({ customer_name: 'Tres Enter SA', rowVersion: 2 });
	});

	it('B-12 · Escape descarta, y un clic después no lo resucita', async () => {
		const { grid, page } = await open();
		const row = grid.rowById('case_000002');
		const before = await grid.text(row, 'Cliente');
		await typeInto(grid, 'case_000002', 'Cliente', 'No Va');
		await page.keyboard.press('Escape');
		expect(await page.locator(EDITOR).count()).toBe(0);
		expect(await grid.text(row, 'Cliente')).toBe(before);
		await grid.cell(grid.rowById('case_000003'), 'Cliente').click();
		expect(await grid.text(row, 'Cliente')).toBe(before);
		expect(await uiButton(page, 'Guardar').first().isDisabled()).toBe(true);
	});

	it('B-13 · editores con panel: fecha tecleada confirma al salir; elegir en la lista o el calendario no cancela ni duplica', async () => {
		const { grid, page } = await open();
		const row = grid.rowById('case_000002');
		// Una celda vecina: clicar lejos desplazaría la hoja, y desplazarla ya cierra el editor.
		const other = grid.cell(grid.rowById('case_000003'), 'Fecha promesa');

		// Fecha tecleada y clic en otra celda.
		await grid.cell(row, 'Fecha promesa').scrollIntoViewIfNeeded();
		await grid.cell(row, 'Fecha promesa').dblclick();
		await page.locator('.oc-cal__typed').fill('20/11/2026');
		await other.click();
		expect(await page.locator('.oc-cal').count()).toBe(0);
		expect(await grid.text(row, 'Fecha promesa')).toBe('20/11/2026');

		// Un día del calendario: confirma una vez.
		await grid.cell(row, 'Últ. contacto').scrollIntoViewIfNeeded();
		await grid.cell(row, 'Últ. contacto').dblclick();
		await page.locator('.oc-cal__typed').fill('05/11/2026');
		await page.locator('.oc-cal__day[data-date="2026-11-12"]').click();
		expect(await page.locator('.oc-cal').count()).toBe(0);
		expect(await grid.text(row, 'Últ. contacto')).toBe('12/11/2026');

		// Una opción de la lista de Etapa: confirma una vez.
		const stage = grid.cell(row, 'Etapa');
		await stage.scrollIntoViewIfNeeded();
		const stageBefore = (await stage.innerText()).trim();
		const choice = stageBefore === 'Judicial' ? 'Preventiva' : 'Judicial';
		await stage.locator('.oc-picker__chevron').click();
		await page
			.locator('.oc-cell-editor .oc-cell-editor__option')
			.filter({ has: page.getByText(choice, { exact: true }) })
			.click();
		expect(await page.locator('.oc-cell-editor').count()).toBe(0);
		await expect.poll(() => stage.innerText().then((t) => t.trim())).toBe(choice);
		expect(await grid.summary()).toBe('Cambios 1');

		// Tres cambios, tres pasos de deshacer: ninguno quedó duplicado.
		await grid.toolbar('Deshacer');
		await expect.poll(() => stage.innerText().then((t) => t.trim())).toBe(stageBefore);
		expect(await grid.text(row, 'Últ. contacto')).toBe('12/11/2026');
		await grid.toolbar('Deshacer');
		await grid.toolbar('Deshacer');
		await expect.poll(() => uiButton(page, 'Guardar').first().isDisabled()).toBe(true);
	});
});

/**
 * «Guardar» en vivo (decisión de Sergio, 13-nov): se enciende solo con cambios
 * reales respecto del valor de referencia, contando lo escrito en la celda
 * abierta; regresarla a su valor previo lo apaga aunque siga abierta. Un clic
 * confirma y guarda; lo guardado es la nueva referencia.
 */
describe('«Guardar» en vivo', () => {
	const saveOn = (page: Page) => uiButton(page, 'Guardar').first().isEnabled();

	/** Reemplaza lo escrito en el editor abierto (nativo o propio). */
	async function retype(page: Page, text: string) {
		await page.keyboard.press('ControlOrMeta+a');
		if (text) await page.keyboard.type(text);
		else await page.keyboard.press('Backspace');
	}

	it('B-14 · fila existente: cambiar enciende, regresar apaga, un clic guarda y lo guardado es la referencia', async () => {
		const { grid, page } = await open();
		const row = grid.rowById('case_000002');
		const before = await grid.text(row, 'Cliente');
		expect(await saveOn(page)).toBe(false);

		await typeInto(grid, 'case_000002', 'Cliente', 'Nuevo Vivo SA');
		await expect.poll(() => saveOn(page)).toBe(true);
		await retype(page, before);
		await expect.poll(() => saveOn(page)).toBe(false);
		expect(await page.locator(EDITOR).count()).toBe(1);
		await retype(page, 'Nuevo Vivo SA');
		await expect.poll(() => saveOn(page)).toBe(true);

		// Un solo clic: confirma la celda y guarda; el valor entra una vez.
		const text = await grid.save();
		expect(text).toMatch(/Actualizadas\s*1/);
		await grid.closeDialog();
		expect(await getCase('case_000002')).toMatchObject({ customer_name: 'Nuevo Vivo SA', rowVersion: 2 });
		await expect.poll(() => saveOn(page)).toBe(false);

		// La referencia es ahora lo guardado.
		await typeInto(grid, 'case_000002', 'Cliente', 'Otro');
		await expect.poll(() => saveOn(page)).toBe(true);
		await retype(page, 'Nuevo Vivo SA');
		await expect.poll(() => saveOn(page)).toBe(false);
		await page.keyboard.press('Enter');
		expect(await saveOn(page)).toBe(false);
	});

	it('B-15 · lo mismo con el editor nativo (texto y número) y con la fecha tecleada', async () => {
		const { grid, page } = await open();
		const row = grid.rowById('case_000002');

		const rfc = await grid.text(row, 'RFC');
		await typeInto(grid, 'case_000002', 'RFC', 'XXX000101AA');
		await expect.poll(() => saveOn(page)).toBe(true);
		await retype(page, rfc);
		await expect.poll(() => saveOn(page)).toBe(false);
		await page.keyboard.press('Escape');

		// El número se compara por su valor: «183397» es lo mismo que «$183,397.00».
		await typeInto(grid, 'case_000002', 'Promesa', '1');
		await expect.poll(() => saveOn(page)).toBe(true);
		const amount = (await getCase('case_000002')).promise_amount;
		await retype(page, String(amount));
		await expect.poll(() => saveOn(page)).toBe(false);
		await page.keyboard.press('Escape');

		const date = grid.cell(row, 'Fecha promesa');
		const shown = await grid.text(row, 'Fecha promesa');
		await date.scrollIntoViewIfNeeded();
		await date.dblclick();
		const typed = page.locator('.oc-cal__typed');
		await typed.waitFor();
		await typed.fill('01/01/2027');
		await expect.poll(() => saveOn(page)).toBe(true);
		await typed.fill(shown);
		await expect.poll(() => saveOn(page)).toBe(false);
		await page.keyboard.press('Escape');
		expect(await saveOn(page)).toBe(false);
	});

	it('B-16 · fila nueva: agregarla ya es un cambio; tras guardarla, su valor guardado es la referencia', async () => {
		const { grid, page } = await open();
		await grid.toolbar('Agregar fila');
		await expect.poll(() => grid.row('+').count()).toBe(1);
		// Crear la fila es un cambio real: encendido aunque no tenga nada escrito.
		expect(await saveOn(page)).toBe(true);
		await grid.editText('+', 'Cliente', 'Vivo Nueva SA');
		await grid.editText('+', 'RFC', 'VNS900101AA');
		await grid.setField(0, 'Etapa', 'early');
		// Con la RFC abierta y cambiada, un clic confirma y guarda la fila completa.
		await typeInto(grid, '+', 'RFC', 'VNS900101BB');
		const text = await grid.save();
		expect(text).toMatch(/Filas creadas\s*1/);
		await grid.closeDialog();
		expect(await getCase('case_050001')).toMatchObject({ customer_name: 'Vivo Nueva SA', customer_rfc: 'VNS900101BB' });
		await expect.poll(() => saveOn(page)).toBe(false);

		await typeInto(grid, 'case_050001', 'Cliente', 'Cambio');
		await expect.poll(() => saveOn(page)).toBe(true);
		await retype(page, 'Vivo Nueva SA');
		await expect.poll(() => saveOn(page)).toBe(false);
		await page.keyboard.press('Escape');
	});
});
