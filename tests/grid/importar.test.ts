/**
 * Importar en el navegador (SB-34), sobre `/imports`: el formato «Contactos»
 * del ejemplo, que escribe en la hoja del ejemplo básico. Elegir o soltar un
 * archivo, pegar o escribir en la vista previa, revisar (lo del servidor se
 * marca en la celda), corregir y aplicar.
 */
import ExcelJS from 'exceljs';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { api } from '../support/api.ts';
import { FRONT_URL } from '../support/env.ts';
import { GridPage } from '../support/grid.ts';

const { user } = browserHarness();

async function open() {
	const u = await user('A');
	await u.page.goto(`${FRONT_URL}/imports`);
	await u.page.getByRole('region', { name: 'Vista previa' }).locator('.oc-grid__sheet tbody tr').first().waitFor({ timeout: 20_000 });
	return u;
}

/** Un Excel como los de la vida real: título, fila vacía, encabezado con alias y una columna de más. */
async function excel(rows: unknown[][], header = ['Notas', 'Nombre completo', 'Email', 'Estatus', 'Límite', 'Alta']): Promise<Buffer> {
	const wb = new ExcelJS.Workbook();
	const ws = wb.addWorksheet('Contactos');
	ws.addRow(['Lista de contactos']);
	ws.addRow([]);
	ws.addRow(header);
	for (const r of rows) ws.addRow(r);
	return Buffer.from(await wb.xlsx.writeBuffer());
}

const stamp = () => Date.now().toString(36);
const day = (iso: string) => {
	const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d));
};

async function choose(page: Page, name: string, buffer: Buffer) {
	await page.getByLabel('Archivo a importar').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
	await page.getByRole('region', { name: 'Archivo leído' }).waitFor({ timeout: 20_000 });
}

/** La hoja de la vista previa, leída por la interfaz. */
async function preview(page: Page) {
	const grid = new GridPage(page);
	const labels = await page.locator('.oc-grid__sheet thead td').allTextContents();
	labels.forEach((label, x) => grid.columns.set(label.trim(), x));
	return grid;
}

const aside = (page: Page) => page.getByRole('complementary', { name: 'Datos de la importación' });

describe('importar (SB-34)', () => {
	it('IMP-1 · elegir un Excel: encabezado en la fila 3, alias y columnas de más; cada valor con el tipo de su columna', async () => {
		const { page, shot } = await open();
		const email = `ana-${stamp()}@ejemplo.mx`;
		await choose(page, 'contactos.xlsx', await excel([['nota', 'Ana Pérez', email, 'Activo', 1500.5, day('2026-01-02')]]));
		const info = await page.getByRole('region', { name: 'Archivo leído' }).innerText();
		expect(info).toContain('1 filas · encabezado en la fila 3');
		expect(info).toContain('Se ignoran: Notas');
		// El archivo trae «Estado»: no se pide a la izquierda.
		expect(await aside(page).getByText('Estado', { exact: true }).count()).toBe(0);

		const grid = await preview(page);
		const row = grid.row(1);
		expect(await grid.text(row, 'Correo')).toBe(email);
		expect(await grid.text(row, 'Estado')).toBe('Activo');
		expect(await grid.text(row, 'Cliente desde')).toBe('02/01/2026');
		expect(await grid.text(row, 'Límite de crédito')).toMatch(/1,?500\.50/);
		await shot('leido');
	});

	it('IMP-2 · sin columna «Estado» se elige a la izquierda; revisar marca lo del servidor; corregir y aplicar', async () => {
		const { page, shot } = await open();
		const id = stamp();
		const a = `uno-${id}@ejemplo.mx`;
		const b = `dos-${id}@ejemplo.mx`;
		// El segundo repite el correo del primero: eso solo lo sabe el servidor (la llave).
		const file = await excel(
			[
				['Uno', a, 10],
				['Dos', a, 20]
			],
			['Nombre', 'Correo', 'Límite']
		);
		await choose(page, 'sin-estado.xlsx', file);
		await aside(page).getByText('Estado', { exact: true }).waitFor();

		await aside(page).getByRole('button', { name: 'Revisar' }).click();
		await aside(page).getByText(/1 celda marcada en la hoja/).waitFor({ timeout: 20_000 });
		const grid = await preview(page);
		const second = grid.cell(grid.row(2), 'Correo');
		expect(await second.getAttribute('class')).toContain('oc-cell-invalid');
		expect(await second.getAttribute('title')).toBe('Repetido: igual que la fila 1');
		await shot('marcado');

		await grid.editText(2, 'Correo', b);
		// Corregida: la marca del servidor se va y hay que revisar otra vez.
		expect(await second.getAttribute('class')).not.toContain('oc-cell-invalid');
		await aside(page).getByRole('button', { name: 'Revisar' }).click();
		await aside(page).getByText('Listo para aplicar.').waitFor({ timeout: 20_000 });
		await aside(page).getByRole('button', { name: 'Aplicar' }).click();
		await page.getByText(/Importado: 2 creados y 0 actualizados/).waitFor({ timeout: 20_000 });
		await shot('aplicado');

		const found = (await api(`/api/basic/contacts?search=${id}`)).body.rows as { email: string; status: string }[];
		expect(found.map((r) => [r.email, r.status]).sort()).toEqual([
			[b, 'lead'],
			[a, 'lead']
		].sort());
	});

	it('IMP-3 · sin archivo: pegar desde una hoja de cálculo en la vista previa, y soltar un CSV encima', async () => {
		const { page } = await open();
		const grid = await preview(page);
		const id = stamp();
		const tsv = [`Pegada Uno\tpega1-${id}@ejemplo.mx\t100\t05/02/2026\tProspecto`, `Pegada Dos\tpega2-${id}@ejemplo.mx\t200\t06/02/2026\tInactivo`].join('\n');
		await grid.cell(grid.row(1), 'Nombre').click();
		await grid.cell(grid.row(1), 'Nombre').evaluate((td, text) => {
			const data = new DataTransfer();
			data.setData('text/plain', text);
			td.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
		}, tsv);
		await expect.poll(() => grid.text(grid.row(2), 'Estado')).toBe('Inactivo');
		expect(await grid.text(grid.row(1), 'Cliente desde')).toBe('05/02/2026');
		await aside(page).getByRole('button', { name: 'Revisar' }).click();
		await aside(page).getByText('Listo para aplicar.').waitFor({ timeout: 20_000 });

		// Soltar un CSV sobre la vista previa lo lee (reemplaza lo que había).
		const csv = `Nombre,Correo,Estado\nDe CSV,csv-${id}@ejemplo.mx,Activo\n`;
		await page.getByRole('region', { name: 'Vista previa' }).evaluate((section, text) => {
			const data = new DataTransfer();
			data.items.add(new File([text], 'lista.csv', { type: 'text/csv' }));
			section.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
		}, csv);
		await page.getByRole('region', { name: 'Archivo leído' }).getByText('lista.csv').waitFor({ timeout: 20_000 });
		const fresh = await preview(page);
		expect(await fresh.text(fresh.row(1), 'Correo')).toBe(`csv-${id}@ejemplo.mx`);
		expect(await fresh.text(fresh.row(1), 'Estado')).toBe('Activo');
	});

	it('IMP-4 · un archivo sin los encabezados del formato no se lee: lo dice', async () => {
		const { page } = await open();
		await page.getByLabel('Archivo a importar').setInputFiles({ name: 'otra.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') });
		await aside(page).getByText(/No se encontró la tabla/).waitFor({ timeout: 20_000 });
	});
});
