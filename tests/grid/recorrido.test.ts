/**
 * Recorrido básico de la hoja en el navegador, con las dos formas de usarla:
 * contra el servidor (`new Sheet(url)`) y sin servidor (`new Sheet({ … })`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { FRONT_URL } from '../support/env.ts';
import { GridPage, uiButton } from '../support/grid.ts';
import { getCase, reset } from '../protocol/support.ts';

const { user } = browserHarness();

beforeEach(async () => {
	await reset();
});

describe('hoja contra el servidor', () => {
	it('pide el esquema, edita, sobrevive a salir de la ventana y a recargar, y guarda', async () => {
		const { page, shot } = await user('A');
		const grid = await new GridPage(page).open(`${FRONT_URL}/`);

		// Las columnas llegaron del servidor: la página no define ninguna.
		expect([...grid.columns.keys()]).toEqual(expect.arrayContaining(['ID', 'Cliente', 'RFC', 'Etapa', 'Atiende']));
		await expect.poll(() => page.locator('.oc-grid__legend').innerText()).toMatch(/de 50,000/);

		await grid.editText('case_000001', 'Cliente', 'SB PRUEBA SA');
		const row1 = grid.rowById('case_000001');
		expect(await grid.state(row1, 'Cliente')).toContain('oc-cell-dirty');

		// Bajar hasta que la fila salga de la ventana: el cambio queda retenido.
		const content = page.locator('.oc-grid__sheet .jss_content');
		await expect
			.poll(
				async () => {
					await content.evaluate((el) => (el.scrollTop = el.scrollHeight));
					return row1.count();
				},
				{ timeout: 20_000, intervals: [400] }
			)
			.toBe(0);

		// Recargar: el borrador vuelve de IndexedDB.
		await page.waitForTimeout(600);
		await page.reload();
		await grid.open(`${FRONT_URL}/`);
		await expect.poll(() => grid.cell(grid.rowById('case_000001'), 'Cliente').innerText()).toBe('SB PRUEBA SA');
		expect(await grid.state(grid.rowById('case_000001'), 'Cliente')).toContain('oc-cell-dirty');
		await shot('restaurado');

		await uiButton(page, 'Guardar').first().click();
		await expect.poll(() => grid.dialog().first().innerText().catch(() => '')).toContain('Cambios guardados');
		await shot('guardado');

		const saved = await getCase('case_000001');
		expect(saved.customer_name).toBe('SB PRUEBA SA');
		expect(saved.rowVersion).toBe(2);
	});
});

describe('hoja sin servidor', () => {
	it('carga la definición y los datos locales', async () => {
		const { page } = await user('A');
		const grid = await new GridPage(page).open(`${FRONT_URL}/local`);
		expect([...grid.columns.keys()]).toEqual(expect.arrayContaining(['ID', 'Cliente', 'Naturaleza', 'Importe']));
		expect(await grid.rows().count()).toBeGreaterThan(0);
	});
});
