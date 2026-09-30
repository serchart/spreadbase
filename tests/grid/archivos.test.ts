/**
 * Columnas de archivo e imagen con subida, en el navegador (SB-30): «Contrato»
 * en `/cases` (`file`) y «Foto» en `/postgres` (`image`, se omite si el
 * ejemplo de Postgres no responde).
 */
import type { Locator, Page } from 'playwright';
import { beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { API_URL, FRONT_URL } from '../support/env.ts';
import { GridPage } from '../support/grid.ts';
import { getCase, reset } from '../protocol/support.ts';

const { user } = browserHarness();

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDGgAQIGAMp1AgK3vUJ2AAAAAElFTkSuQmCC',
	'base64'
);

async function open(path: string) {
	const u = await user('A');
	const grid = await new GridPage(u.page).open(`${FRONT_URL}${path}`);
	return { ...u, grid };
}

const panel = (page: Page) => page.locator('.oc-cell-editor.oc-media-editor');

async function openEditor(cell: Locator) {
	await cell.scrollIntoViewIfNeeded();
	await cell.dblclick();
	await panel(cell.page()).waitFor();
}

describe('columna de archivo', () => {
	beforeEach(async () => {
		await reset();
	});

	it('AR-1 · subir desde el panel: la celda muestra el nombre, queda editada y se guarda la URL', async () => {
		const { grid, page } = await open('/cases');
		const cell = grid.cell(grid.rowById('case_000001'), 'Contrato');
		expect((await cell.innerText()).trim()).toBe('—');

		await openEditor(cell);
		await page.locator('.oc-cell-editor__file').setInputFiles({ name: 'Contrato Núñez.pdf', mimeType: 'application/pdf', buffer: PDF });
		await panel(page).waitFor({ state: 'detached' });

		expect(await cell.locator('.oc-file__name').innerText()).toBe('Contrato-Nunez.pdf');
		expect(await grid.state(grid.rowById('case_000001'), 'Contrato')).toContain('oc-cell-dirty');
		const href = await cell.locator('a.oc-file__open').getAttribute('href');
		expect(href).toMatch(new RegExp(`^${API_URL}/uploads/cases/[^/]+/Contrato-Nunez\\.pdf$`));

		expect(await grid.save()).toContain('Cambios guardados');
		expect((await getCase('case_000001')).contract_file).toBe(href);
	});

	it('AR-2 · ↗ abre el archivo en otra pestaña', async () => {
		const { grid, page } = await open('/cases');
		const cell = grid.cell(grid.rowById('case_000002'), 'Contrato');
		await openEditor(cell);
		await page.locator('.oc-cell-editor__file').setInputFiles({ name: 'acta.pdf', mimeType: 'application/pdf', buffer: PDF });
		await panel(page).waitFor({ state: 'detached' });

		// Sin ventana, Chromium descarga el PDF en vez de mostrarlo: basta con que la pestaña nueva lo pida.
		const [popup, request] = await Promise.all([
			page.context().waitForEvent('page'),
			page.context().waitForEvent('request', (r) => /\/uploads\/cases\/[^/]+\/acta\.pdf$/.test(r.url())),
			cell.locator('a.oc-file__open').click()
		]);
		expect(request.frame().page()).toBe(popup);
		await popup.close();
	});

	it('AR-3 · un tipo no permitido no se envía; el que el servidor rechaza, avisa; la celda no cambia', async () => {
		const { grid, page } = await open('/cases');
		const cell = grid.cell(grid.rowById('case_000003'), 'Contrato');
		await openEditor(cell);
		const uploads: string[] = [];
		page.on('request', (r) => r.url().includes('/upload/') && uploads.push(r.url()));

		// El navegador dice que es texto: se rechaza sin enviarlo.
		await page.locator('.oc-cell-editor__file').setInputFiles({ name: 'notas.txt', mimeType: 'text/plain', buffer: Buffer.from('hola') });
		await expect.poll(() => page.locator('.oc-cell-editor__status.is-error').innerText()).toMatch(/Tipo no permitido. Se aceptan: PDF, PNG, JPEG/);
		expect(uploads).toHaveLength(0);

		// Dice ser PDF pero es HTML: el servidor lo revisa por el contenido.
		await page
			.locator('.oc-cell-editor__file')
			.setInputFiles({ name: 'falso.pdf', mimeType: 'application/pdf', buffer: Buffer.from('<html><script>alert(1)</script></html>') });
		await expect.poll(() => page.locator('.oc-cell-editor__status.is-error').innerText()).toMatch(/Tipo de archivo no permitido/);
		expect(uploads).toHaveLength(1);

		await page.keyboard.press('Escape');
		expect((await cell.innerText()).trim()).toBe('—');
		expect(await grid.state(grid.rowById('case_000003'), 'Contrato')).not.toContain('oc-cell-dirty');
	});

	it('AR-4 · pegar una URL en el panel; copiar la celda da la URL, no el nombre', async () => {
		const { grid, page } = await open('/cases');
		const cell = grid.cell(grid.rowById('case_000004'), 'Contrato');
		await openEditor(cell);
		await page.locator('.oc-media-editor .oc-cell-editor__input').fill('https://ejemplo.mx/docs/poliza%20seguro.pdf');
		await page.keyboard.press('Enter');
		expect(await cell.locator('.oc-file__name').innerText()).toBe('poliza seguro.pdf');

		await cell.click();
		const copied = await cell.evaluate((td) => {
			const data = new DataTransfer();
			td.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
			return data.getData('text/plain');
		});
		expect(copied).toBe('https://ejemplo.mx/docs/poliza%20seguro.pdf');
	});
});

// -- imagen con subida: ejemplo de Postgres ------------------------------------------

const PRODUCTS = `${API_URL}/api/postgres/products/sheet`;
const available = await fetch(`${PRODUCTS}/schema`)
	.then((r) => r.ok)
	.catch(() => false);

describe.skipIf(!available)('columna de imagen con subida', () => {
	it('AR-5 · subir una foto: la miniatura es la subida y se guarda', async () => {
		const before = await (await fetch(`${PRODUCTS}/prd_0005`)).json();
		const { grid, page } = await open('/postgres');
		const cell = grid.cell(grid.rowById('prd_0005'), 'Foto');
		try {
			await openEditor(cell);
			expect(await page.locator('.oc-cell-editor__upload').innerText()).toBe('Subir');
			await page.locator('.oc-cell-editor__file').setInputFiles({ name: 'grúa.png', mimeType: 'image/png', buffer: PNG });
			await panel(page).waitFor({ state: 'detached' });
			const src = await cell.locator('img.oc-image-thumb').getAttribute('src');
			expect(src).toMatch(new RegExp(`^${API_URL}/uploads/products/[^/]+/grua\\.png$`));
			await expect.poll(() => cell.locator('img.oc-image-thumb').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(2);
			expect(await grid.save()).toContain('Cambios guardados');
			expect((await (await fetch(`${PRODUCTS}/prd_0005`)).json()).image_url).toBe(src);
		} finally {
			const now = await (await fetch(`${PRODUCTS}/prd_0005`)).json();
			if (now.image_url !== before.image_url) {
				await fetch(`${PRODUCTS}/batch`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						updates: [{ id: 'prd_0005', rowVersion: now.rowVersion, changes: { image_url: { from: now.image_url, to: before.image_url } } }]
					})
				});
			}
		}
	});
});
