/**
 * Contraseña (SB-22) y casilla en el navegador, sobre la hoja de usuarios del
 * ejemplo de Postgres (`/postgres?sheet=users`). Necesita ese ejemplo
 * encendido; si no responde, se omite. Cada prueba deja los usuarios como
 * estaban (la contraseña de la semilla es «demo-12345»).
 */
import type { Locator, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { API_URL, FRONT_URL } from '../support/env.ts';
import { GridPage } from '../support/grid.ts';

const SHEET_API = `${API_URL}/api/postgres/users/sheet`;
const available = await fetch(`${SHEET_API}/schema`)
	.then((r) => r.ok)
	.catch(() => false);

const SEED_PASSWORD = 'demo-12345';
const { user } = browserHarness();

type Json = Record<string, any>;
const getUser = async (id: string): Promise<Json> => (await fetch(`${SHEET_API}/${id}`)).json();
async function update(id: string, field: string, to: unknown) {
	const row = await getUser(id);
	const res = await fetch(`${SHEET_API}/batch`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ updates: [{ id, rowVersion: row.rowVersion, changes: { [field]: { from: row[field], to } } }] })
	});
	expect(res.status).toBe(200);
}

/** Lo que se tocó, para dejarlo como estaba. */
const restore: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of restore.splice(0)) await fn();
});

async function open() {
	const u = await user('A');
	const grid = await new GridPage(u.page).open(`${FRONT_URL}/postgres?sheet=users`);
	return { ...u, grid };
}

const cellOf = (grid: GridPage, id: string, label: string): Locator => grid.cell(grid.rowById(id), label);
const passwordInput = (page: Page) => page.locator('.oc-cell-editor input[type="password"]');

/** Todo lo que guarda el borrador en IndexedDB, como texto. */
function draftDump(page: Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const req = indexedDB.open('oc-datagrid');
				req.onerror = () => reject(req.error);
				req.onsuccess = () => {
					const db = req.result;
					const names = [...db.objectStoreNames];
					if (names.length === 0) return resolve('');
					const tx = db.transaction(names, 'readonly');
					const out: unknown[] = [];
					let pending = names.length;
					for (const name of names) {
						const all = tx.objectStore(name).getAll();
						all.onsuccess = () => {
							out.push(all.result);
							if (--pending === 0) resolve(JSON.stringify(out));
						};
					}
				};
			})
	);
}

describe.skipIf(!available)('tipos · contraseña y casilla (ejemplo Postgres, usuarios)', () => {
	it('T-1 · carga: la contraseña se ve como puntos y la casilla marcada según el valor', async () => {
		const { grid, page } = await open();
		const u1 = await getUser('usr_0001');
		expect(u1.password_hash).toMatch(/^pwd:/);
		expect(await grid.text(grid.rowById('usr_0001'), 'Contraseña')).toBe('••••••••');
		const box = cellOf(grid, 'usr_0001', 'Activo').locator('input.oc-bool');
		expect(await box.isChecked()).toBe(u1.active);
		expect(await page.locator('.oc-grid__sheet td.oc-cell-invalid').count()).toBe(0);
		// Lo guardado no llegó al navegador: ni el hash ni nada que se le parezca.
		expect(await page.content()).not.toContain('scrypt$');
	});

	it('T-2 · cambiar la contraseña: el editor empieza vacío, vacío no la cambia, y nunca queda en el borrador', async () => {
		restore.push(() => update('usr_0011', 'password_hash', SEED_PASSWORD));
		const { grid, page } = await open();
		const before = (await getUser('usr_0011')).password_hash;
		const cell = cellOf(grid, 'usr_0011', 'Contraseña');

		// Abrir y confirmar vacío: no cambia nada.
		await cell.dblclick();
		await expect.poll(() => passwordInput(page).count()).toBe(1);
		expect(await passwordInput(page).inputValue()).toBe('');
		expect(await page.locator('.oc-cell-editor').innerText()).toContain('Déjala vacía para no cambiarla');
		await page.keyboard.press('Enter');
		await expect.poll(() => passwordInput(page).count()).toBe(0);
		expect(await cell.getAttribute('class')).not.toContain('oc-cell-dirty');

		// Una nueva.
		await cell.dblclick();
		await passwordInput(page).fill('clave-de-prueba-777');
		await page.keyboard.press('Enter');
		await expect.poll(() => cell.getAttribute('class')).toContain('oc-cell-dirty');
		expect(await cell.innerText()).toBe('•'.repeat(12));
		expect(await grid.summary()).toBe('Cambios 1');

		// El borrador se escribe (agrupado a 300 ms) sin la contraseña.
		await expect.poll(() => draftDump(page), { timeout: 5_000 }).toContain('usr_0011');
		expect(await draftDump(page)).not.toContain('clave-de-prueba-777');

		expect(await grid.save()).toContain('Cambios guardados');
		const after = (await getUser('usr_0011')).password_hash;
		expect(after).toMatch(/^pwd:/);
		expect(after).not.toBe(before);
	});

	it('T-3 · una contraseña corta queda marcada y no se envía', async () => {
		const { grid, page } = await open();
		const cell = cellOf(grid, 'usr_0012', 'Contraseña');
		await cell.dblclick();
		await passwordInput(page).fill('corta');
		await page.keyboard.press('Enter');
		await expect.poll(() => cell.getAttribute('class')).toContain('oc-cell-invalid');
		expect(await cell.getAttribute('title')).toBe('Mínimo 10 caracteres');
		expect(await grid.save()).toContain('El cambio no se envió');
	});

	it('T-4 · la casilla: un clic la alterna, se puede deshacer, y se guarda', async () => {
		const original = (await getUser('usr_0013')).active;
		restore.push(() => update('usr_0013', 'active', original));
		const { grid } = await open();
		const cell = cellOf(grid, 'usr_0013', 'Activo');
		const box = cell.locator('input.oc-bool');

		await box.click();
		await expect.poll(() => cell.getAttribute('class')).toContain('oc-cell-dirty');
		expect(await box.isChecked()).toBe(!original);

		await grid.toolbar('Deshacer');
		await expect.poll(() => box.isChecked()).toBe(original);
		expect(await cell.getAttribute('class')).not.toContain('oc-cell-dirty');

		await grid.toolbar('Rehacer');
		await expect.poll(() => box.isChecked()).toBe(!original);
		expect(await grid.save()).toContain('Cambios guardados');
		expect((await getUser('usr_0013')).active).toBe(!original);
	});

	it('T-5 · copiar una contraseña no copia nada', async () => {
		const { grid } = await open();
		const cell = cellOf(grid, 'usr_0001', 'Contraseña');
		await cell.click();
		const copied = await cell.evaluate((td) => {
			const data = new DataTransfer();
			td.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
			return data.getData('text/plain');
		});
		expect(copied).toBe('');
	});
});
