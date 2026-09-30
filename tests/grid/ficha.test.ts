/**
 * Un registro como formulario guardable (`RecordForm`, SB-32), en `/ficha`:
 * un contacto de la hoja del ejemplo básico. Cada prueba usa su propio
 * contacto; la hoja vive en memoria del servidor de ejemplos.
 */
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { API_URL, FRONT_URL } from '../support/env.ts';

const { user } = browserHarness();
const BASE = `${API_URL}/api/basic/contacts`;

type Json = Record<string, any>;
const getContact = async (id: string): Promise<Json> => (await fetch(`${BASE}/${id}`)).json();
/** Otro usuario cambia un campo por la API. */
async function change(id: string, field: string, to: unknown) {
	const row = await getContact(id);
	await fetch(`${BASE}/batch`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ updates: [{ id, rowVersion: row.rowVersion, changes: { [field]: { from: row[field], to } } }] })
	});
}

async function open(id: string) {
	const u = await user('A');
	await u.page.goto(`${FRONT_URL}/ficha?id=${id}`);
	await u.page.getByRole('button', { name: 'Guardar' }).waitFor({ timeout: 20_000 });
	return u;
}

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });
const save = (page: Page) => page.getByRole('button', { name: 'Guardar', exact: true });
/** La hoja vive en memoria entre corridas: valores distintos cada vez. */
const run = Date.now().toString(36);

describe('ficha de un registro (SB-32)', () => {
	it('FR-1 · los campos son las columnas editables de la hoja, con lo guardado; «Guardar» espera un cambio', async () => {
		const row = await getContact('c_00101');
		const { page, shot } = await open('c_00101');
		expect(await page.locator('fieldset legend').allInnerTexts()).toEqual(['Nombre', 'Correo', 'Estado', 'Límite de crédito', 'Cliente desde']);
		expect(await field(page, 'Nombre').inputValue()).toBe(row.name);
		expect(await field(page, 'Correo').inputValue()).toBe(row.email);
		expect(await save(page).isDisabled()).toBe(true);
		await shot('ficha');
	});

	it('FR-2 · cambiar texto y lista y guardar: solo lo cambiado, y queda «Guardado»', async () => {
		const { page } = await open('c_00102');
		const status = (await getContact('c_00102')).status === 'inactive' ? ['Activo', 'active'] : ['Inactivo', 'inactive'];
		await field(page, 'Nombre').fill(`Ficha ${run}`);
		await field(page, 'Estado').click();
		await page.locator('.oc-cell-editor .oc-cell-editor__option').filter({ has: page.getByText(status[0]!, { exact: true }) }).click();
		expect(await save(page).isDisabled()).toBe(false);
		await save(page).click();
		await page.getByRole('status').filter({ hasText: 'Guardado' }).waitFor();
		expect(await getContact('c_00102')).toMatchObject({ name: `Ficha ${run}`, status: status[1] });
		expect(await save(page).isDisabled()).toBe(true);
	});

	it('FR-3 · las reglas de la hoja: un correo inválido se marca y no se envía', async () => {
		const { page } = await open('c_00103');
		const sent: string[] = [];
		page.on('request', (r) => r.url().includes('/batch') && sent.push(r.url()));
		await field(page, 'Correo').fill('no-es-correo');
		await save(page).click();
		await page.getByText('Debe ser un correo válido').waitFor();
		expect(sent).toHaveLength(0);
	});

	it('FR-4 · otro cambió el mismo campo: conflicto; «Guardar lo mío» lo pisa con lo tuyo', async () => {
		const { page } = await open('c_00104');
		await field(page, 'Nombre').fill(`Mío ${run}`);
		await change('c_00104', 'name', `Del otro ${run}`);
		await save(page).click();
		await page.getByRole('alert').filter({ hasText: 'Otra persona cambió Nombre' }).waitFor();
		expect((await getContact('c_00104')).name).toBe(`Del otro ${run}`);
		await page.getByRole('button', { name: 'Guardar lo mío' }).click();
		await page.getByRole('status').filter({ hasText: 'Guardado' }).waitFor();
		expect((await getContact('c_00104')).name).toBe(`Mío ${run}`);
	});

	it('FR-5 · otro cambió otro campo: se combina sin conflicto', async () => {
		const { page } = await open('c_00105');
		await field(page, 'Nombre').fill(`Nombre ${run}`);
		await change('c_00105', 'email', `otro.${run}@ejemplo.mx`);
		await save(page).click();
		await page.getByRole('status').filter({ hasText: 'Guardado' }).waitFor();
		expect(await getContact('c_00105')).toMatchObject({ name: `Nombre ${run}`, email: `otro.${run}@ejemplo.mx` });
		// El formulario queda con lo vigente, incluido lo del otro.
		expect(await field(page, 'Correo').inputValue()).toBe(`otro.${run}@ejemplo.mx`);
	});
});
