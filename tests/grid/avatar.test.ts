/**
 * Miniaturas en celdas (SB-29): iniciales en una columna de texto (la hoja de
 * casos, «Cliente») y la foto del registro elegido en una `lookup` (el
 * ejemplo de Postgres, «Responsable»), con su respaldo si la foto no carga.
 *
 * Lo de Postgres se omite si el ejemplo no responde (como `lookup.test.ts`).
 */
import type { Locator } from 'playwright';
import { beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { API_URL, FRONT_URL } from '../support/env.ts';
import { GridPage } from '../support/grid.ts';
import { getCase, reset } from '../protocol/support.ts';

const { user } = browserHarness();

async function open(path: string) {
	const u = await user('A');
	const grid = await new GridPage(u.page).open(`${FRONT_URL}${path}`);
	return { ...u, grid };
}

const avatarOf = (cell: Locator) => cell.locator('.oc-avatar');

describe('iniciales en una columna de texto', () => {
	beforeEach(async () => {
		await reset();
	});

	it('AV-1 · la celda lleva las iniciales de la empresa, cuadradas; su texto sigue siendo solo el valor', async () => {
		const { grid } = await open('/cases');
		const cell = grid.cell(grid.rowById('case_000001'), 'Cliente');
		const avatar = avatarOf(cell);
		// «Constructora Peninsular SAPI de CV»: SAPI y de CV no cuentan.
		await expect.poll(() => avatar.getAttribute('data-initials')).toBe('CP');
		expect(await avatar.getAttribute('class')).toMatch(/\bis-square\b.*\btone-[1-8]\b/);
		expect(await cell.textContent()).toBe('Constructora Peninsular SAPI de CV');
	});

	it('AV-2 · el mismo nombre da el mismo color en otra fila', async () => {
		const { grid } = await open('/cases');
		await grid.editText('case_000002', 'Cliente', 'Constructora Peninsular SAPI de CV');
		const tone = (id: string) =>
			avatarOf(grid.cell(grid.rowById(id), 'Cliente'))
				.getAttribute('class')
				.then((c) => c?.match(/tone-\d/)?.[0]);
		expect(await tone('case_000002')).toBe(await tone('case_000001'));
	});

	it('AV-3 · editar dentro de la celda, como texto nativo, y la miniatura se actualiza', async () => {
		const { grid, page } = await open('/cases');
		await grid.editText('case_000003', 'Cliente', 'Transportes del Norte SA de CV');
		const cell = grid.cell(grid.rowById('case_000003'), 'Cliente');
		expect(await avatarOf(cell).getAttribute('data-initials')).toBe('TN');
		expect(await grid.state(grid.rowById('case_000003'), 'Cliente')).toContain('oc-cell-dirty');

		// Esc descarta lo tecleado.
		await cell.dblclick();
		await page.locator('.oc-grid__sheet td.editor input').fill('Otra Cosa');
		await page.keyboard.press('Escape');
		expect(await cell.textContent()).toBe('Transportes del Norte SA de CV');

		const text = await grid.save();
		expect(text).toContain('Cambios guardados');
		expect(await getCase('case_000003')).toMatchObject({ customer_name: 'Transportes del Norte SA de CV' });
	});

	it('AV-4 · copiar da el texto, sin iniciales', async () => {
		const { grid } = await open('/cases');
		const cell = grid.cell(grid.rowById('case_000001'), 'Cliente');
		await cell.click();
		const copied = await cell.evaluate((td) => {
			const data = new DataTransfer();
			td.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
			return data.getData('text/plain');
		});
		expect(copied).toBe('Constructora Peninsular SAPI de CV');
	});
});

// -- foto del registro elegido: lookup ------------------------------------------------

const PRODUCTS = `${API_URL}/api/postgres/products/sheet`;
const USERS = `${API_URL}/api/postgres/users/sheet`;
const available = await fetch(`${PRODUCTS}/schema`)
	.then((r) => r.ok)
	.catch(() => false);

type Json = Record<string, any>;
const call = async (url: string, init?: RequestInit): Promise<Json> =>
	(await fetch(url, { ...init, headers: { 'content-type': 'application/json' } })).json();

/** Cambia un campo por la API de la hoja, como otro usuario. */
async function setField(sheet: string, id: string, field: string, to: unknown) {
	const row = await call(`${sheet}/${id}`);
	if (row[field] === to) return;
	await call(`${sheet}/batch`, {
		method: 'POST',
		body: JSON.stringify({ updates: [{ id, rowVersion: row.rowVersion, changes: { [field]: { from: row[field], to } } }] })
	});
}

describe.skipIf(!available)('foto en una columna lookup', () => {
	it('AV-5 · «Responsable» lleva la foto de la persona elegida, redonda', async () => {
		const product = await call(`${PRODUCTS}/prd_0001`);
		const owner = await call(`${USERS}/${product.owner_id}`);
		const { grid } = await open('/postgres');
		const cell = grid.cell(grid.rowById('prd_0001'), 'Responsable');
		const img = avatarOf(cell).locator('img');
		await expect.poll(() => img.getAttribute('src')).toBe(owner.avatar);
		expect(await avatarOf(cell).getAttribute('class')).toMatch(/\bis-round\b/);
		expect((await cell.innerText()).trim()).toBe(owner.name);
	});

	it('AV-6 · al elegir otra persona, la celda toma su foto', async () => {
		const product = await call(`${PRODUCTS}/prd_0002`);
		try {
			const { grid, page } = await open('/postgres');
			const cell = grid.cell(grid.rowById('prd_0002'), 'Responsable');
			await cell.locator('.oc-picker__chevron').click();
			const popover = page.locator('.oc-cell-editor.oc-lookup-editor');
			const found = await call(`${PRODUCTS}/lookup/owner_id?q=valeria%20rojas&offset=0&limit=50`);
			const chosen = found.rows[0];
			await page.keyboard.type('valeria rojas');
			await expect.poll(() => popover.locator('.oc-lookup__foot').innerText()).toBe(`${found.total} de ${found.total}`);
			await page.keyboard.press('Enter');
			await expect.poll(() => cell.innerText().then((t) => t.trim())).toBe(chosen.name);
			expect(await avatarOf(cell).locator('img').getAttribute('src')).toBe(chosen.avatar);
		} finally {
			await setField(PRODUCTS, 'prd_0002', 'owner_id', product.owner_id);
		}
	});

	it('AV-7 · sin foto o con el enlace roto: sus iniciales', async () => {
		const product = await call(`${PRODUCTS}/prd_0003`);
		const owner = await call(`${USERS}/${product.owner_id}`);
		try {
			await setField(USERS, owner.id, 'avatar', `${API_URL}/no-existe/${owner.id}.png`);
			const { grid } = await open('/postgres');
			const avatar = avatarOf(grid.cell(grid.rowById('prd_0003'), 'Responsable'));
			const initials = owner.name
				.split(' ')
				.slice(0, 2)
				.map((w: string) => w[0])
				.join('')
				.toUpperCase();
			await expect.poll(() => avatar.getAttribute('data-initials')).toBe(initials);
			expect(await avatar.locator('img').count()).toBe(0);
		} finally {
			await setField(USERS, owner.id, 'avatar', owner.avatar);
		}
	});
});
