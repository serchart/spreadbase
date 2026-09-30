/**
 * Lo que el cliente agrega a una hoja del servidor, en el ejemplo básico
 * (`/basic`): columnas (SB-23) —un «Abrir» por fila, un parche y una
 * función—, botones propios en la barra (SB-24) y escribir celdas desde
 * fuera de la hoja (SB-27).
 */
import { describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { API_URL, FRONT_URL } from '../support/env.ts';
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
		expect((await actions.innerText()).replace(/\s+/g, ' ').trim()).toBe('Guardar Cerrar contacto Límite en cero');

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

	it('AC-6 · escribir desde fuera (commands.setValues): la celda se repinta, queda por guardar y ⌘Z lo deshace', async () => {
		const { page, grid, shot } = await open();
		const row = grid.row(1);
		const before = await grid.text(row, 'Límite de crédito');
		expect(before).not.toBe('$0.00');
		await row.getByRole('button', { name: 'Abrir' }).first().click();

		const bar = page.getByRole('toolbar', { name: 'Acciones de la hoja' });
		await bar.getByRole('button', { name: 'Límite en cero' }).click();
		await expect.poll(() => grid.text(row, 'Límite de crédito')).toBe('$0.00');
		expect(await grid.cell(row, 'Límite de crédito').getAttribute('class')).toContain('oc-cell-dirty');
		expect(await page.locator('button[aria-label="Guardar"]').first().isDisabled()).toBe(false);
		await shot('escrito');

		await bar.getByRole('button', { name: 'Deshacer' }).click();
		await expect.poll(() => grid.text(row, 'Límite de crédito')).toBe(before);
		expect((await grid.cell(row, 'Límite de crédito').getAttribute('class')) ?? '').not.toContain('oc-cell-dirty');
	});

	it('AC-7 · filtros fijos (SB-28): la hoja muestra solo esa parte del recurso, también al desplazarse', async () => {
		const u = await user('A');
		const grid = await new GridPage(u.page).open(`${FRONT_URL}/basic?status=inactive`);
		const res = await fetch(`${API_URL}/api/basic/contacts?status=inactive&limit=1`);
		const { total } = await res.json();
		expect(total).toBeGreaterThan(0);
		// El contador de la hoja es el total filtrado del servidor, no el de todo el recurso.
		await expect.poll(() => u.page.locator('text=/Filas \\d+–\\d+ de/').first().innerText()).toContain(`de ${total.toLocaleString('es-MX')}`);
		// Todas dirían «Inactivo»: con el filtro fijo la columna sobra y se oculta (`hidden`).
		expect(grid.columns.has('Estado del contacto')).toBe(false);
		await u.shot('filtrada');
	});

	it('AC-8 · una alta en la hoja filtrada nace dentro del filtro, aunque su columna esté oculta', async () => {
		const u = await user('A');
		const grid = await new GridPage(u.page).open(`${FRONT_URL}/basic?status=inactive`);
		const email = `alta.${Date.now()}@ejemplo.mx`;
		await grid.toolbar('Agregar fila');
		await grid.editText('+', 'Nombre', 'Alta filtrada');
		await grid.editText('+', 'Correo', email);
		expect(await grid.save()).toMatch(/Filas creadas\s*1/);
		const res = await fetch(`${API_URL}/api/basic/contacts?search=${encodeURIComponent(email)}&limit=5`);
		const { rows } = await res.json();
		expect(rows).toEqual([expect.objectContaining({ name: 'Alta filtrada', email, status: 'inactive' })]);
	});
});
