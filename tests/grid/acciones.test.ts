/**
 * Lo que el cliente agrega a una hoja del servidor, en el ejemplo básico
 * (`/basic`): columnas (SB-23) —un «Abrir» por fila, un parche y una
 * función— y un botón propio en la barra (SB-24).
 */
import { describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { FRONT_URL } from '../support/env.ts';
import { GridPage } from '../support/grid.ts';

const { user } = browserHarness();

async function open() {
	const u = await user('A');
	const grid = await new GridPage(u.page).open(`${FRONT_URL}/basic`);
	return { ...u, grid };
}

describe('columnas del cliente (SB-23)', () => {
	it('AC-1 · la acción va primero, en cada fila, y abre esa fila', async () => {
		const { page, grid, shot } = await open();
		const headers = (await page.locator('.oc-grid__sheet thead td').allTextContents()).map((t) => t.trim());
		// Número de fila, la acción (sin título) y luego las columnas del servidor.
		expect(headers.slice(1, 3)).toEqual(['', 'ID']);

		// Con `frozenColumns: 1` la columna fija se pinta también en la capa fija:
		// dos botones por fila que hacen lo mismo.
		for (const n of [1, 3]) {
			const row = grid.row(n);
			const name = await grid.text(row, 'Nombre');
			await row.getByRole('button', { name: 'Abrir' }).first().click();
			await page.getByTestId('opened').getByText(name, { exact: true }).waitFor();
		}
		await shot('acciones');
	});

	it('AC-2 · pulsar la acción no ensucia la fila ni deja nada por guardar', async () => {
		const { page, grid } = await open();
		const row = grid.row(2);
		await row.getByRole('button', { name: 'Abrir' }).first().click();
		expect(await row.locator('td.oc-cell-dirty').count()).toBe(0);
		expect(await page.locator('button[aria-label="Guardar"]').first().isDisabled()).toBe(true);
	});

	it('AC-3 · un parche y una función ajustan columnas del servidor', async () => {
		const { page, grid } = await open();
		expect(grid.columns.has('Estado del contacto')).toBe(true);
		expect(grid.columns.has('Estado')).toBe(false);
		const width = await page.locator('.oc-grid__sheet thead td').nth(grid.columns.get('Nombre')!).evaluate((td) => td.getBoundingClientRect().width);
		expect(Math.round(width)).toBe(260);
	});

	it('AC-4 · la barra: edición solo icono, luego Guardar y el botón propio con texto, y los paneles', async () => {
		const { page, grid } = await open();
		const bar = page.getByRole('toolbar', { name: 'Acciones de la hoja' });
		const actions = bar.getByRole('group', { name: 'Acciones' });
		expect((await actions.innerText()).replace(/\s+/g, ' ').trim()).toBe('Guardar Cerrar contacto');

		// El botón propio sigue al estado de la página.
		const close = actions.getByRole('button', { name: 'Cerrar contacto' });
		expect(await close.isDisabled()).toBe(true);
		await grid.row(1).getByRole('button', { name: 'Abrir' }).first().click();
		expect(await close.isDisabled()).toBe(false);
		await close.click();
		await page.getByTestId('opened').getByText('Pulsa «Abrir» en una fila.').waitFor();

		// Edición: solo icono, a la izquierda de las acciones.
		const undo = bar.getByRole('button', { name: 'Deshacer' });
		expect((await undo.innerText()).trim()).toBe('');
		expect((await undo.boundingBox())!.x).toBeLessThan((await actions.boundingBox())!.x);
		// Paneles al extremo derecho.
		expect((await bar.getByRole('group', { name: 'Paneles' }).boundingBox())!.x).toBeGreaterThan((await actions.boundingBox())!.x);
	});

	it('AC-5 · la barra no desborda la página (sus filas de medición van recortadas)', async () => {
		const { page } = await open();
		// Aunque sea invisible, un elemento que sale de la barra sin un contenedor
		// que lo recorte da scroll horizontal a la página que contiene la hoja.
		const overflow = await page.evaluate(() => {
			const bar = document.querySelector('[role="toolbar"]')!;
			const right = bar.getBoundingClientRect().right;
			const clipped = (el: Element) => {
				for (let a = el.parentElement; a && a !== bar; a = a.parentElement) {
					if (getComputedStyle(a).overflowX !== 'visible') return true;
				}
				return false;
			};
			return [...bar.querySelectorAll('*')]
				.filter((el) => el.getBoundingClientRect().right > right + 1 && !clipped(el))
				.map((el) => el.className.toString());
		});
		expect(overflow).toEqual([]);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
	});
});
