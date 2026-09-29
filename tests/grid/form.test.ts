/**
 * Formularios con las columnas de la hoja (SB-25): `<Field>` y `FormState`, en
 * la página `/form` del ejemplo, sobre la hoja de productos de Postgres.
 *
 * Lo que se prueba es que el campo usa **el mismo editor y las mismas reglas
 * que la celda**: la mini tabla de «Responsable», el calendario, la lista de
 * «Estado» y los mensajes de validación.
 *
 * Necesita el ejemplo de Postgres encendido; si no responde, se omite. Cada
 * prueba borra (borrado lógico) los productos que crea.
 */
import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { API_URL, FRONT_URL } from '../support/env.ts';

const SHEET_API = `${API_URL}/api/postgres/products/sheet`;
const available = await fetch(`${SHEET_API}/schema`)
	.then((r) => r.ok)
	.catch(() => false);

const { user } = browserHarness();

type Json = Record<string, any>;
const api = async (path: string, init?: RequestInit): Promise<Json> => {
	const res = await fetch(`${SHEET_API}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
	return res.json();
};

const created: string[] = [];
afterEach(async () => {
	for (const id of created.splice(0)) {
		const row = await api(`/${id}`);
		await api('/batch', { method: 'POST', body: JSON.stringify({ deletes: [{ id, rowVersion: row.rowVersion }] }) });
	}
});

async function open() {
	const u = await user('A');
	await u.page.goto(`${FRONT_URL}/form`);
	await u.page.getByRole('button', { name: 'Crear producto' }).waitFor({ timeout: 20_000 });
	return u;
}

/** El campo por su etiqueta: el control con editor de celda es un botón con esa etiqueta. */
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const popover = (page: Page) => page.locator('.oc-cell-editor');
const message = (page: Page, label: string) => page.locator('fieldset', { has: page.locator('legend', { hasText: new RegExp(`^${label}$`) }) }).locator('p.label');

/** Elige en la mini tabla de «Responsable» el primer resultado de `q`. */
async function chooseOwner(page: Page, q: string) {
	await field(page, 'Responsable').click();
	await popover(page).locator('.oc-lookup').waitFor();
	await page.keyboard.type(q);
	await expect.poll(() => popover(page).locator('tbody tr').count()).toBeGreaterThan(0);
	await expect.poll(() => popover(page).locator('.oc-lookup__foot').innerText()).not.toContain('Buscando');
	const name = (await popover(page).locator('tbody tr.is-active td').nth(1).innerText()).trim();
	await page.keyboard.press('Enter');
	await popover(page).waitFor({ state: 'detached' });
	return name;
}

describe.skipIf(!available)('formulario (SB-25) · ejemplo Postgres', () => {
	it('F-1 · los campos salen del esquema; «Crear» sin datos muestra las reglas de cada tipo', async () => {
		const { page, shot } = await open();
		expect(await page.locator('fieldset legend').allInnerTexts()).toEqual([
			'Nombre',
			'SKU',
			'Estado',
			'Responsable',
			'Precio',
			'Existencias',
			'Lanzamiento',
			'Último surtido'
		]);
		await page.getByRole('button', { name: 'Crear producto' }).click();
		await expect.poll(() => message(page, 'Nombre').innerText()).toBe('"Nombre" es obligatorio');
		expect(await message(page, 'Responsable').innerText()).toBe('"Responsable" es obligatorio');
		// Obligatorio solo en este formulario (`columns` de FormState).
		expect(await message(page, 'Lanzamiento').innerText()).toBe('"Lanzamiento" es obligatorio');
		await shot('reglas');
	});

	it('F-2 · «Responsable» abre la misma mini tabla que la celda y el campo muestra el nombre elegido', async () => {
		const { page, shot } = await open();
		await field(page, 'Responsable').click();
		await popover(page).locator('.oc-lookup').waitFor();
		// Las columnas de la mini tabla son las que declara el backend, como en la hoja.
		expect(await popover(page).locator('thead th').allInnerTexts()).toEqual(['', 'Nombre', 'Correo', 'ID']);
		await shot('mini-tabla');
		await page.keyboard.press('Escape');

		const name = await chooseOwner(page, 'ana');
		expect(await field(page, 'Responsable').innerText()).toBe(name);
		expect(await message(page, 'Responsable').count()).toBe(0);
	});

	it('F-3 · un texto sin coincidencias: «Sin resultados», y el campo sigue vacío y obligatorio', async () => {
		const { page } = await open();
		// Teclear con el campo cerrado abre la búsqueda con esa letra.
		await field(page, 'Responsable').focus();
		await page.keyboard.type('zzzzqqq');
		await expect.poll(() => popover(page).locator('.oc-lookup__foot').innerText()).toBe('Sin resultados');
		expect(await popover(page).locator('input').inputValue()).toBe('zzzzqqq');
		await page.keyboard.press('Escape');
		await expect.poll(() => message(page, 'Responsable').innerText()).toBe('"Responsable" es obligatorio');
	});

	it('F-4 · «Lanzamiento» abre el calendario de la celda; se puede teclear la fecha', async () => {
		const { page, shot } = await open();
		await field(page, 'Lanzamiento').click();
		await page.locator('.oc-cal').waitFor();
		expect(await page.locator('.oc-cal__dow span').allInnerTexts()).toEqual(['L', 'M', 'M', 'J', 'V', 'S', 'D']);
		await shot('calendario');
		await page.locator('.oc-cal__typed').fill('15/10/2026');
		await page.keyboard.press('Enter');
		await expect.poll(() => field(page, 'Lanzamiento').innerText()).toBe('15/10/2026');
		expect(await page.locator('pre').textContent()).toContain('"launch_date": "2026-10-15"');
	});

	it('F-5 · alta completa: lista de «Estado», número y la regla del servidor; luego crea', async () => {
		const { page, shot } = await open();
		await field(page, 'Nombre').fill('Caja seca de prueba');
		await field(page, 'SKU').fill('prueba-1');
		await field(page, 'SKU').blur();
		// La regla del tipo (patrón) llega al campo igual que a la celda.
		await expect.poll(() => message(page, 'SKU').innerText()).toBe('Mayúsculas, números y guiones (4 a 20)');
		await field(page, 'SKU').fill(`PRB-${Date.now().toString().slice(-8)}`);
		await chooseOwner(page, 'ana');
		await field(page, 'Precio').fill('1250.5');
		await field(page, 'Lanzamiento').click();
		await page.locator('.oc-cal__typed').fill('01/11/2026');
		await page.keyboard.press('Enter');

		// «Estado» es la lista de la celda.
		await field(page, 'Estado').click();
		await popover(page).locator('.oc-cell-editor__option', { hasText: 'Activo' }).click();
		expect(await field(page, 'Estado').innerText()).toBe('Activo');

		// Sin existencias no se puede activar: la regla es del servidor y el formulario la muestra.
		await page.getByRole('button', { name: 'Crear producto' }).click();
		await page.getByRole('alert').filter({ hasText: /existencias/i }).waitFor({ timeout: 15_000 });

		await field(page, 'Existencias').fill('3');
		await page.getByRole('button', { name: 'Crear producto' }).click();
		const ok = page.getByRole('status');
		await ok.waitFor({ timeout: 15_000 });
		await shot('creado');
		const id = (await ok.locator('code').innerText()).trim();
		created.push(id);
		expect(await api(`/${id}`)).toMatchObject({ name: 'Caja seca de prueba', status: 'active', price: 1250.5, stock: 3, launch_date: '2026-11-01' });
	});
});
