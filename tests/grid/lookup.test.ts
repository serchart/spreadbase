/**
 * Columna `lookup` en el navegador (SB-21, docs/03-lookup.md), sobre la hoja
 * de productos del ejemplo de Postgres: «Responsable» elige un usuario de una
 * tabla de 2 000.
 *
 * Necesita el ejemplo de Postgres encendido (`DATABASE_URL` y
 * `npm run postgres:setup`); si no responde, se omite. Cada prueba deja los
 * productos que toca como estaban.
 */
import type { Locator, Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { API_URL, FRONT_URL } from '../support/env.ts';
import { GridPage } from '../support/grid.ts';

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
const getProduct = (id: string) => api(`/${id}`);
const lookup = (q: string, offset = 0, limit = 50) => api(`/lookup/owner_id?${new URLSearchParams({ q, offset: String(offset), limit: String(limit) })}`);
const resolve = async (texts: string[]) => (await api('/lookup/owner_id/resolve', { method: 'POST', body: JSON.stringify({ texts }) })).matches as Record<string, Json[]>;

/** Cambia el responsable por la API, como otro usuario. */
async function setOwner(id: string, owner: string) {
	const row = await getProduct(id);
	if (row.owner_id === owner) return;
	await api('/batch', {
		method: 'POST',
		body: JSON.stringify({ updates: [{ id, rowVersion: row.rowVersion, changes: { owner_id: { from: row.owner_id, to: owner } } }] })
	});
}

const IDS = ['prd_0001', 'prd_0002', 'prd_0003', 'prd_0004', 'prd_0005'];
let original: Record<string, string> = {};

beforeEach(async () => {
	if (!available) return;
	original = Object.fromEntries(await Promise.all(IDS.map(async (id) => [id, (await getProduct(id)).owner_id])));
});

afterEach(async () => {
	if (!available) return;
	for (const [id, owner] of Object.entries(original)) await setOwner(id, owner);
});

async function open() {
	const u = await user('A');
	const grid = await new GridPage(u.page).open(`${FRONT_URL}/postgres`);
	return { ...u, grid };
}

const ownerCell = (grid: GridPage, id: string): Locator => grid.cell(grid.rowById(id), 'Responsable');
const popover = (page: Page) => page.locator('.oc-cell-editor.oc-lookup-editor');
const foot = (page: Page) => popover(page).locator('.oc-lookup__foot');

async function openPopover(grid: GridPage, id: string) {
	const cell = ownerCell(grid, id);
	await cell.scrollIntoViewIfNeeded();
	await cell.locator('.oc-picker__chevron').click();
	await popover(grid.page).waitFor();
}

/** Pega texto sobre una celda, como ⌘V con ese contenido en el portapapeles. */
async function pasteInto(cell: Locator, text: string) {
	await cell.click();
	await cell.evaluate((td, text) => {
		const data = new DataTransfer();
		data.setData('text/plain', text);
		td.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
	}, text);
}

/** Copia una celda como ⌘C y devuelve lo que fue al portapapeles. */
async function copyFrom(cell: Locator): Promise<string> {
	await cell.click();
	return cell.evaluate((td) => {
		const data = new DataTransfer();
		td.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
		return data.getData('text/plain');
	});
}

/** Cuenta las peticiones de `resolve` que hace la página. */
function countResolves(page: Page) {
	const seen: string[] = [];
	page.on('request', (r) => {
		if (r.url().includes('/lookup/owner_id/resolve')) seen.push(r.postData() ?? '');
	});
	return seen;
}

describe.skipIf(!available)('lookup (SB-21) · ejemplo Postgres', () => {
	it('L-1 · la celda muestra el nombre, no el id; y cada tipo se pinta con su formato', async () => {
		const { grid } = await open();
		const row = await getProduct('prd_0001');
		const names = await resolve([row.owner_id]);
		expect(await grid.text(grid.rowById('prd_0001'), 'Responsable')).toBe(names[row.owner_id]![0]!.name);

		const r = grid.rowById('prd_0001');
		if (row.image_url) expect(await grid.cell(r, 'Foto').locator('img.oc-image-thumb').count()).toBe(1);
		expect(await grid.text(r, 'Lanzamiento')).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
		expect(await grid.text(r, 'Último surtido')).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
		expect(await grid.text(r, 'Precio')).toMatch(/^\$[\d,]+\.\d{2}$/);
		expect(await grid.text(r, 'Estado')).toMatch(/^(Borrador|Activo|Pausado)$/);
		// Ninguna celda cargada del servidor queda marcada como inválida.
		expect(await grid.page.locator('.oc-grid__sheet td.oc-cell-invalid').count()).toBe(0);
	});

	it('L-2 · el popover es una mini tabla con encabezado fijo que carga por tramos', async () => {
		const { grid, page, shot } = await open();
		const all = await lookup('');
		await openPopover(grid, 'prd_0001');

		await expect.poll(() => popover(page).locator('tbody tr').count()).toBe(50);
		expect(await popover(page).locator('thead th').allInnerTexts()).toEqual(['', 'Nombre', 'Correo', 'ID']);
		expect(await popover(page).locator('tbody tr').first().locator('img.oc-lookup__img.is-round').count()).toBe(1);
		expect(await foot(page).innerText()).toBe(`50 de ${all.total.toLocaleString('es-MX')}`);
		expect(await popover(page).locator('tbody tr.is-active').count()).toBe(1);
		await shot('popover');

		// Al llegar al fondo, el tramo siguiente.
		await popover(page)
			.locator('.oc-lookup__scroll')
			.evaluate((el) => (el.scrollTop = el.scrollHeight));
		await expect.poll(() => popover(page).locator('tbody tr').count()).toBe(100);
		expect(await foot(page).innerText()).toBe(`100 de ${all.total.toLocaleString('es-MX')}`);

		// El encabezado sigue arriba tras desplazarse.
		const [head, box] = await Promise.all([
			popover(page).locator('thead th').first().boundingBox(),
			popover(page).locator('.oc-lookup__scroll').boundingBox()
		]);
		expect(Math.abs(head!.y - box!.y)).toBeLessThan(3);

		await page.keyboard.press('Escape');
		await expect.poll(() => popover(page).count()).toBe(0);
	});

	it('L-3 · buscar, elegir con el teclado y guardar', async () => {
		const found = await lookup('oscar vargas');
		expect(found.total).toBeGreaterThan(1);
		// Parte de un responsable fuera de los resultados: el resaltado empieza en la primera fila.
		const outside = (await lookup('ana lopez')).rows[0]!;
		await setOwner('prd_0001', outside.id);
		const { grid, page } = await open();
		const chosen = found.rows[1]!;

		await openPopover(grid, 'prd_0001');
		await page.keyboard.type('oscar vargas');
		await expect.poll(() => foot(page).innerText()).toBe(`${found.total} de ${found.total}`);
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');

		const cell = ownerCell(grid, 'prd_0001');
		await expect.poll(() => cell.innerText()).toBe(chosen.name);
		expect(await cell.getAttribute('class')).toContain('oc-cell-dirty');
		expect(await cell.getAttribute('class')).not.toContain('oc-cell-invalid');

		expect(await grid.save()).toContain('Cambios guardados');
		expect((await getProduct('prd_0001')).owner_id).toBe(chosen.id);
	});

	it('L-4 · pegar texto: una sola consulta con los textos únicos; único, ambiguo, sin coincidencia y por id', async () => {
		const { grid, page } = await open();
		// Un nombre que corresponde a un solo usuario (la semilla tiene muchos homónimos).
		const names = new Set<string>();
		for (let offset = 0; ; offset += 100) {
			const page = await lookup('', offset, 100);
			page.rows.forEach((r) => names.add(r.name as string));
			if (offset + 100 >= page.total) break;
		}
		const all = [...names];
		let unique = '';
		for (let i = 0; i < all.length && !unique; i += 500) {
			const matches = await resolve(all.slice(i, i + 500));
			unique = Object.keys(matches).find((n) => matches[n]!.length === 1) ?? '';
		}
		expect(unique, 'un nombre sin homónimos en la semilla').not.toBe('');
		const ambiguous = (await resolve(['Ana López']))['Ana López']!;
		expect(ambiguous.length).toBeGreaterThan(1);
		const byId = (await lookup('', 0, 1)).rows[0]!;

		const requests = countResolves(page);
		// Cinco filas, con un texto repetido: viaja una vez.
		await pasteInto(ownerCell(grid, 'prd_0001'), ['ana lopez', unique, 'Nadie Existe', byId.id, unique].join('\n'));

		const text = (id: string) => ownerCell(grid, id).innerText();
		const title = (id: string) => ownerCell(grid, id).getAttribute('title');
		const cls = (id: string) => ownerCell(grid, id).getAttribute('class');

		await expect.poll(() => text('prd_0002')).toBe(unique);
		expect(await cls('prd_0002')).not.toContain('oc-cell-invalid');
		expect(await text('prd_0005')).toBe(unique);
		expect(await text('prd_0004')).toBe(byId.name);
		expect(await cls('prd_0004')).not.toContain('oc-cell-invalid');

		expect(await cls('prd_0001')).toContain('oc-cell-invalid');
		expect(await title('prd_0001')).toBe(`Ambiguo: ${ambiguous.length} coincidencias, elige una`);
		expect(await text('prd_0003')).toBe('Nadie Existe');
		expect(await title('prd_0003')).toBe('No corresponde a ningún registro');

		expect(requests).toHaveLength(1);
		// El id también viaja: la hoja solo conoce los de las páginas que cargó.
		expect(JSON.parse(requests[0]!).texts.sort()).toEqual(['Nadie Existe', 'ana lopez', unique, byId.id].sort());

		// El ambiguo abre el buscador ya filtrado con su texto.
		await openPopover(grid, 'prd_0001');
		expect(await popover(page).locator('input').inputValue()).toBe('ana lopez');
		await expect.poll(() => popover(page).locator('tbody tr').count()).toBe(ambiguous.length);
		await page.keyboard.press('Enter');
		await expect.poll(() => cls('prd_0001')).not.toContain('oc-cell-invalid');

		// Un pegado es un solo paso del historial.
		await grid.toolbar('Deshacer');
		await grid.toolbar('Deshacer');
		await expect.poll(() => cls('prd_0002')).not.toContain('oc-cell-dirty');
		expect(await cls('prd_0003')).not.toContain('oc-cell-invalid');
	});

	it('L-5 · copiar y pegar dentro de la hoja lleva el id: sin consultas y sin ambigüedad', async () => {
		// El origen tiene un responsable con homónimos: por nombre sería ambiguo.
		const ana = (await resolve(['Ana López']))['Ana López']!;
		await setOwner('prd_0001', ana[1]!.id);
		const { grid, page } = await open();
		const requests = countResolves(page);

		const copied = await copyFrom(ownerCell(grid, 'prd_0001'));
		expect(copied).toBe('Ana López');
		await pasteInto(ownerCell(grid, 'prd_0002'), copied);

		await expect.poll(() => ownerCell(grid, 'prd_0002').innerText()).toBe('Ana López');
		expect(await ownerCell(grid, 'prd_0002').getAttribute('class')).not.toContain('oc-cell-invalid');
		expect(requests).toHaveLength(0);

		expect(await grid.save()).toContain('Cambios guardados');
		expect((await getProduct('prd_0002')).owner_id).toBe(ana[1]!.id);
	});
});
