/**
 * El asistente de importación en el navegador (SB-36, rediseño v2 fase A),
 * sobre `/import-assistant` (el backend de ejemplo con su modelo de guion):
 * soltar archivos sobre la tabla (sin botón), el chat visible con su
 * bienvenida desde el momento 0 y sin el textarea de comentarios, la lista de
 * archivos como hoja (Destino e Instrucción editables), analizar, el
 * veredicto del agente en el chat, conversar, ir y volver con las flechas, el
 * detalle de un archivo como hoja de staging (errores en la celda, sin panel
 * encimado), importar y corregir lo rechazado.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { api } from '../support/api.ts';
import { browserHarness } from '../support/browser.ts';
import { FRONT_URL } from '../support/env.ts';
import { csvPlanes, FILAS_OK } from '../support/planes.ts';
import { zip } from '../support/zip.ts';

const { user } = browserHarness();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** Una fila que rompe la regla del formato (lista + descuento ≠ final). */
const MALA = ['ONIX 2026', 'A', 'LS', 'LEASING', 'RCC', 'LCCN', '$300,000', '($1,000)', '$300,000'];
/** Octubre contra los 3 planes «de septiembre»: AVEO contado igual y AVEO GMF con otro precio (a); AVEO LT nuevo (b). ONIX contado ya no viene. */
const OCT_A = [FILAS_OK[0]!, ['AVEO HB 2026', 'A', 'LS Manual', 'GMF TASA SUBSIDIADA CON SEGURO', 'RCC', 'HCAM', '$329,100', '($60,000)', '$269,100']];
const OCT_B = [FILAS_OK[2]!];
/** Capturas para revisar a mano (`SHOTS_DIR`); sin la variable, nada. */
const SHOTS = process.env.SHOTS_DIR;
const capture = async (page: Page, name: string) => {
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Importar archivos' });
const footer = (page: Page) => dialog(page).locator('footer');
const chat = (page: Page) => dialog(page).getByRole('complementary', { name: 'Chat con el asistente' });
const filesSheet = (page: Page) => dialog(page).getByTestId('files-sheet');
const fileRow = (page: Page, name: string) => filesSheet(page).locator('.oc-grid__sheet tbody tr', { hasText: name });

async function columns(sheet: Locator): Promise<Map<string, number>> {
	const labels = await sheet.locator('.oc-grid__sheet thead td').allTextContents();
	return new Map(labels.map((label, i) => [label.trim(), i]));
}

async function cell(page: Page, name: string, column: string): Promise<Locator> {
	const x = (await columns(filesSheet(page))).get(column);
	if (x === undefined) throw new Error(`la hoja de archivos no tiene la columna «${column}»`);
	return fileRow(page, name).locator('td').nth(x);
}

async function cellText(page: Page, name: string, column: string): Promise<string> {
	return (await (await cell(page, name, column)).innerText()).trim();
}

async function waitCell(page: Page, name: string, column: string, text: string | RegExp, timeout = 20_000) {
	await expect.poll(() => cellText(page, name, column), { timeout }).toMatch(text);
}

/** El destino de un archivo, como lo elige la persona en la celda (por la API de la hoja: abrir el desplegable no es estable). */
async function chooseDestination(page: Page, name: string, value: string) {
	const x = (await columns(filesSheet(page))).get('Destino')! - 1;
	const y = await fileRow(page, name).evaluate((tr) => [...tr.parentElement!.children].indexOf(tr));
	const done = await page.evaluate(
		([x, y, value]) => {
			const host = document.querySelector('[data-testid="files-sheet"]');
			const el = [...(host?.querySelectorAll('.oc-grid__sheet *') ?? [])].find((e) => (e as any).jspreadsheet) as any;
			const ws = Array.isArray(el?.jspreadsheet) ? el.jspreadsheet[0] : el?.jspreadsheet;
			if (!ws) return false;
			ws.setValueFromCoords(x, y, value);
			return true;
		},
		[x, y, value] as const
	);
	expect(done, 'hoja de archivos').toBe(true);
	await waitCell(page, name, 'Estado', /fijado por ti/);
}

/** Arrastra y suelta archivos sobre un elemento, como el sistema operativo: un `DataTransfer` con `File`s. */
async function dragFiles(page: Page, selector: string, files: { name: string; type: string; bytes: Buffer }[], events: string[]) {
	await page.evaluate(
		([selector, files, events]) => {
			const target = document.querySelector(selector)!;
			const data = new DataTransfer();
			for (const f of files) data.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
			for (const type of events) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
		},
		[selector, files.map((f) => ({ name: f.name, type: f.type, b64: f.bytes.toString('base64') })), events] as const
	);
}

/**
 * Cada prueba con su persona (`X-User`, que el ejemplo usa como dueño de la
 * corrida): al abrir, el asistente retoma la corrida no terminada de quien
 * abre, y las de otra prueba no deben aparecer.
 */
let who = '';

/** La corrida más reciente de la persona de la prueba. */
async function lastRun() {
	const { body } = await api('/api/import-assistant/runs', { headers: { 'X-User': who } });
	return body[0];
}

async function openPage() {
	const u = await user('A');
	who = `ai-${Math.random().toString(36).slice(2, 8)}`;
	await u.page.context().setExtraHTTPHeaders({ 'X-User': who });
	await u.page.goto(`${FRONT_URL}/import-assistant`);
	// La página hidratada: la hoja de origen ya cargó (aunque esté vacía).
	await u.page.locator('.oc-grid__legend', { hasText: 'Filas' }).waitFor({ timeout: 20_000 });
	return u;
}

/** Dentro de la tabla de origen (bajo la capa): ahí cae lo que se suelta. */
const TABLE = '#tabla-planes .oc-grid__sheet';

describe('asistente de importación (SB-36 · v2 fase A)', () => {
	it('AI-1 · soltar sobre la tabla → chat con bienvenida → hoja de archivos (destino e instrucción) → analizar → veredicto → staging (con el error en la celda) → corregir → importar', async () => {
		await api('/api/import-assistant/planes/dev/reset', { body: {} });
		const { page, shot } = await openPage();
		const files = [
			{ name: 'planes.csv', type: 'text/csv', bytes: csvPlanes([...FILAS_OK, MALA]) },
			{ name: 'paquete.zip', type: 'application/zip', bytes: zip([{ path: 'fotos/frente.png', bytes: PNG }, { path: 'notas.txt', bytes: 'Vigencia octubre' }]) }
		];
		// Al arrastrar, la capa cubre la tabla.
		await dragFiles(page, TABLE, files, ['dragenter', 'dragover']);
		const overlay = page.getByTestId('import-drop-overlay');
		await overlay.waitFor({ timeout: 5000 });
		expect(await overlay.innerText()).toBe('Suelta para importar a Planes GMF');
		const box = await overlay.boundingBox();
		const table = await page.locator('#tabla-planes').boundingBox();
		expect(Math.abs(box!.width - table!.width)).toBeLessThan(2);
		expect(Math.abs(box!.height - table!.height)).toBeLessThan(2);
		await shot('0-arrastrando');
		// Al soltar, se abre el asistente con los archivos subiendo.
		await dragFiles(page, TABLE, files, ['drop']);
		await dialog(page).waitFor({ timeout: 10_000 });
		await expect.poll(() => overlay.count()).toBe(0);
		const stepper = dialog(page).getByRole('list', { name: 'Pasos' });
		expect(await stepper.locator('[aria-current="step"]').innerText()).toBe('Archivos');

		// El chat, a la derecha desde el momento 0, con la bienvenida; sin el textarea de comentarios.
		expect(await chat(page).isVisible()).toBe(true);
		const welcome = chat(page).locator('[data-bienvenida]');
		await welcome.waitFor({ timeout: 10_000 });
		expect(await welcome.innerText()).toContain('Las instrucciones generales me las das aquí, en el chat');
		expect(await welcome.innerText()).toContain('• Adjuntar → Ficha técnica');
		expect(await dialog(page).getByLabel(/Comentarios o instrucciones/).count()).toBe(0);

		// Una carpeta con subcarpeta (input webkitdirectory).
		const dir = await mkdtemp(path.join(os.tmpdir(), 'sb-asistente-'));
		await mkdir(path.join(dir, 'septiembre', 'tablero'), { recursive: true });
		await writeFile(path.join(dir, 'septiembre', 'tablero', 'tablero.png'), PNG);
		await dialog(page).getByLabel('Carpeta a importar').setInputFiles(path.join(dir, 'septiembre'));

		// La lista de archivos es una hoja: carpeta de cada uno (la del zip, abierto en el navegador, y la elegida).
		for (const name of ['planes.csv', 'frente.png', 'notas.txt', 'tablero.png']) await fileRow(page, name).waitFor({ timeout: 15_000 });
		expect(await cellText(page, 'frente.png', 'Carpeta')).toBe('paquete/fotos');
		expect(await cellText(page, 'notas.txt', 'Carpeta')).toBe('paquete');
		expect(await cellText(page, 'tablero.png', 'Carpeta')).toBe('septiembre/tablero');
		expect(await cellText(page, 'planes.csv', 'Carpeta')).toBe('—');
		expect(await cellText(page, 'planes.csv', 'Análisis')).toBe('pendiente');
		expect(await cellText(page, 'planes.csv', 'Estado')).toBe('Pendiente');
		expect([...(await columns(filesSheet(page))).keys()].slice(1, 13)).toEqual(['Documento', 'Staging', 'Icono', 'Nombre', 'Tipo', 'Carpeta', 'Estado', 'Análisis', 'Destino', 'Instrucción', 'Filas', 'Errores']);
		// Solo Destino e Instrucción se editan.
		await (await cell(page, 'planes.csv', 'Análisis')).dblclick();
		expect(await filesSheet(page).locator('.oc-grid__sheet td.editor').count()).toBe(0);
		// La miniatura de una imagen.
		expect(await (await cell(page, 'frente.png', 'Icono')).locator('img').getAttribute('src')).toMatch(/frente\.png$/);

		// Destino e instrucción, en la hoja: se guardan en el servidor.
		await chooseDestination(page, 'planes.csv', 'filas:planes:upsert');
		await chooseDestination(page, 'frente.png', 'adjuntar:fichas');
		await chooseDestination(page, 'notas.txt', 'descartar');
		const instruction = await cell(page, 'planes.csv', 'Instrucción');
		await instruction.dblclick();
		await filesSheet(page).locator('.oc-grid__sheet td.editor input').fill('solo octubre');
		await page.keyboard.press('Enter');
		await expect.poll(async () => (await lastRun()).archivos.find((f: any) => f.nombre === 'planes.csv')?.instruccion, { timeout: 10_000 }).toBe('solo octubre');
		const fixed = (await lastRun()).archivos;
		expect(fixed.find((f: any) => f.nombre === 'planes.csv')).toMatchObject({ destino: { tipo: 'filas', formato: 'planes', modo: 'upsert' }, destinoFijadoPorUsuario: true });
		expect(fixed.find((f: any) => f.nombre === 'notas.txt')).toMatchObject({ destino: { tipo: 'descartar' }, destinoFijadoPorUsuario: true });
		await waitCell(page, 'planes.csv', 'Instrucción', 'solo octubre');

		// Las instrucciones generales, por el chat antes de analizar.
		await chat(page).getByLabel('Mensaje para el asistente').fill('Planes de octubre');
		await chat(page).getByRole('button', { name: 'Enviar' }).click();
		await expect.poll(() => chat(page).locator('[data-rol="agente"]').last().innerText(), { timeout: 15_000 }).toBe('Anotado: lo tomo en cuenta al analizar.');
		expect((await lastRun()).instrucciones).toBe('Planes de octubre');
		await expect.poll(() => footer(page).getByRole('status').innerText()).toMatch(/^4 archivos · .* se suben en cuanto los sueltas$/);
		await shot('1-archivos');

		// ② Análisis: la hoja se llena y el chat reporta un veredicto por archivo.
		await footer(page).getByRole('button', { name: 'Analizar' }).click();
		await waitCell(page, 'planes.csv', 'Análisis', '4 filas de 2 modelos, 1 problemas');
		await waitCell(page, 'planes.csv', 'Estado', 'Analizado · fijado por ti');
		expect(await stepper.locator('[aria-current="step"]').innerText()).toBe('Análisis');
		expect(await cellText(page, 'planes.csv', 'Filas')).toBe('4');
		expect(await cellText(page, 'planes.csv', 'Errores')).toBe('1');
		expect(await (await cell(page, 'planes.csv', 'Errores')).getAttribute('class')).toContain('oc-cell-invalid');
		expect(await cellText(page, 'planes.csv', 'Instrucción')).toBe('solo octubre');
		await waitCell(page, 'notas.txt', 'Análisis', /Descartado|No encontré tablas/);
		const agentSays = () => chat(page).locator('[data-rol="agente"]').allInnerTexts();
		await expect.poll(agentSays, { timeout: 15_000 }).toContain('planes.csv: 4 filas, 1 con error en Precio Final; ábrelo para verlos.');
		expect(await agentSays()).toContain('notas.txt: se descarta.');
		await expect.poll(() => footer(page).getByRole('status').innerText()).toMatch(/^Revisa a dónde va cada archivo/);

		// ← Archivos y de vuelta.
		await footer(page).getByRole('button', { name: 'Archivos' }).click();
		await dialog(page).getByRole('region', { name: 'Soltar archivos' }).waitFor();
		await footer(page).getByRole('button', { name: 'Analizar' }).click();
		await waitCell(page, 'planes.csv', 'Análisis', '4 filas de 2 modelos, 1 problemas');

		// Chat: «excluye contado».
		await chat(page).getByLabel('Mensaje para el asistente').fill('Excluye contado');
		await chat(page).getByRole('button', { name: 'Enviar' }).click();
		await expect.poll(() => chat(page).locator('[data-rol="agente"]').last().innerText(), { timeout: 15_000 }).toBe('Listo: quité 1 filas con «contado» en el tipo de pago.');
		expect(await chat(page).locator('[data-rol="usuario"]').last().innerText()).toBe('Excluye contado');
		await waitCell(page, 'planes.csv', 'Filas', '3');
		await expect.poll(() => footer(page).getByRole('button', { name: /^Importar todo/ }).isDisabled(), { timeout: 5000 }).toBe(false);
		await shot('2-analisis');

		// «Ver staging»: la hoja real de Planes GMF con lo que propone la corrida (upsert: nada se elimina).
		await (await cell(page, 'planes.csv', 'Staging')).locator('.oc-action').click();
		const region = dialog(page).getByRole('tabpanel', { name: 'Staging de Planes GMF' });
		const staging = region.getByTestId('staging');
		const badRow = staging.locator('.oc-grid__sheet tbody tr', { hasText: 'ONIX 2026' }).filter({ hasText: 'LEASING' });
		await badRow.waitFor({ timeout: 15_000 });
		// La pestaña de la tabla destino, a la vista; la hoja de archivos sigue en la suya (oculta).
		expect(await dialog(page).getByRole('tablist', { name: 'Vistas' }).getByRole('tab', { selected: true }).innerText()).toMatch(/^Planes GMF/);
		expect(await filesSheet(page).isVisible()).toBe(false);
		expect(await region.getByTestId('staging-summary').innerText()).toBe('Actualizar o agregar · 3 filas hoy · 2 nuevas · 0 con cambios · 1 con error');
		const stagingCols = await columns(staging);
		const price = badRow.locator('td').nth(stagingCols.get('Precio Final')!);
		// El problema del review, en su celda (con el motivo en el tooltip).
		await expect.poll(async () => (await price.getAttribute('class')) ?? '', { timeout: 10_000 }).toContain('oc-cell-invalid');
		expect(await price.getAttribute('title')).toBe('Debería ser 299000 (lista + descuento)');
		await shot('3-staging');
		// Con errores no se importa: se dice y la hoja sigue ahí.
		await footer(page).getByRole('button', { name: /^Importar todo/ }).click();
		await expect.poll(() => dialog(page).getByRole('alert').filter({ hasText: 'con error' }).innerText(), { timeout: 10_000 }).toBe(
			'El staging de Planes GMF tiene 1 celda con error: corrígelas (o quita esas filas) antes de importar'
		);
		// Escape cancela la edición de la celda sin cerrar la ventana.
		await staging.getByRole('button', { name: 'Cerrar panel' }).click();
		await price.scrollIntoViewIfNeeded();
		await price.dblclick();
		await staging.locator('.oc-grid__sheet td.editor input').waitFor();
		await page.keyboard.press('Escape');
		await expect.poll(() => staging.locator('.oc-grid__sheet td.editor').count()).toBe(0);
		expect(await dialog(page).isVisible()).toBe(true);
		await price.dblclick();
		await staging.locator('.oc-grid__sheet td.editor input').fill('299000');
		await page.keyboard.press('Enter');

		// ③ Importar → ④ Resultado: la hoja se guarda y la corrida procesa lo demás (adjuntar, descartar).
		await footer(page).getByRole('button', { name: /^Importar todo/ }).click();
		await expect.poll(() => stepper.locator('[aria-current="step"]').innerText(), { timeout: 20_000 }).toBe('Resultado');
		expect(await dialog(page).getByTestId('total-ok').innerText()).toBe('2 nuevas · 0 actualizadas · 0 eliminadas · 1 archivo adjunto');
		await waitCell(page, 'planes.csv', 'Estado', 'Guardado con el staging');
		expect(await cellText(page, 'frente.png', 'Estado')).toBe('Adjuntado');
		expect(await cellText(page, 'notas.txt', 'Estado')).toBe('Descartado');
		await expect.poll(() => chat(page).locator('[data-rol="agente"]').last().innerText(), { timeout: 10_000 }).toMatch(
			/^Importación terminada: 3 filas importadas, 1 adjunto\.\nPlanes GMF: 2 nuevas, 0 actualizadas, 0 eliminadas\.\n[\s\S]*• planes\.csv: 3 filas importadas\./
		);
		await shot('4-resultado');

		// ← Volver al análisis, y Escape cierra; la tabla de origen se recarga con lo importado.
		await footer(page).getByRole('button', { name: 'Volver al análisis' }).click();
		expect(await stepper.locator('[aria-current="step"]').innerText()).toBe('Análisis');
		await page.keyboard.press('Escape');
		await expect.poll(() => dialog(page).isVisible()).toBe(false);
		await expect.poll(async () => (await page.locator('#tabla-planes .oc-grid__sheet tbody tr').allInnerTexts()).join('\n'), { timeout: 15_000 }).toContain('ONIX 2026');
	});

	it('AI-2 · «o elige archivos» abre el asistente; un tipo no admitido no se sube y lo dice; «Analizar» espera a tener archivos', async () => {
		const { page } = await openPage();
		await page.getByRole('button', { name: 'o elige archivos' }).click();
		await dialog(page).waitFor();
		// Sin archivos, la zona de drop ocupa el panel izquierdo; el chat ya está ahí.
		const zone = await dialog(page).getByRole('region', { name: 'Soltar archivos' }).boundingBox();
		expect(zone!.height).toBeGreaterThan(400);
		await chat(page).locator('[data-bienvenida]').waitFor({ timeout: 10_000 });
		expect(await footer(page).getByRole('button', { name: 'Analizar' }).isDisabled()).toBe(true);
		await dialog(page).getByLabel('Archivos a importar').setInputFiles([{ name: 'programa.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') }]);
		await expect.poll(() => dialog(page).getByRole('alert').innerText(), { timeout: 10_000 }).toContain('«programa.exe» no se subió: tipo no admitido');
		expect(await footer(page).getByRole('button', { name: 'Analizar' }).isDisabled()).toBe(true);
		await dialog(page).getByRole('button', { name: 'Cerrar', exact: true }).first().click();
		await expect.poll(() => dialog(page).isVisible()).toBe(false);
	});

	it('AI-3 · en pantalla chica el chat es una pestaña', async () => {
		const { page } = await openPage();
		await page.setViewportSize({ width: 390, height: 844 });
		await page.getByRole('button', { name: 'o elige archivos' }).click();
		await dialog(page).waitFor();
		expect(await chat(page).isVisible()).toBe(false);
		await dialog(page).getByRole('tab', { name: /Chat/ }).click();
		await chat(page).locator('[data-bienvenida]').waitFor({ timeout: 10_000 });
		expect(await chat(page).isVisible()).toBe(true);
		expect(await dialog(page).getByRole('region', { name: 'Soltar archivos' }).isVisible()).toBe(false);
	});

	it('AI-4 · el botón «Importar archivos» de la barra; al volver, retoma la corrida (paso, archivos y chat); «Empezar de cero»; acciones a la izquierda y «Ver documento»', async () => {
		const { page, shot } = await openPage();
		// El botón vuelve, junto con el drop sobre la tabla.
		const button = page.locator('#tabla-planes').getByRole('button', { name: 'Importar archivos' });
		await button.click();
		await dialog(page).waitFor();
		await chat(page).locator('[data-bienvenida]').waitFor({ timeout: 10_000 });
		expect(await dialog(page).getByTestId('resumed').count()).toBe(0);
		await dialog(page).getByLabel('Archivos a importar').setInputFiles([
			{ name: 'planes.csv', mimeType: 'text/csv', buffer: csvPlanes(FILAS_OK) },
			{ name: 'frente.png', mimeType: 'image/png', buffer: PNG }
		]);
		await fileRow(page, 'frente.png').waitFor({ timeout: 15_000 });
		await chat(page).getByLabel('Mensaje para el asistente').fill('Solo octubre');
		await chat(page).getByRole('button', { name: 'Enviar' }).click();
		await expect.poll(() => chat(page).locator('[data-rol="agente"]').last().innerText(), { timeout: 15_000 }).toBe('Anotado: lo tomo en cuenta al analizar.');
		await footer(page).getByRole('button', { name: 'Analizar' }).click();
		await waitCell(page, 'planes.csv', 'Estado', /^Analizado/);
		const id = (await lastRun()).id;

		// Las acciones van al inicio, a la izquierda: «Ver documento» y «Ver en staging».
		const labels = [...(await columns(filesSheet(page))).keys()];
		expect(labels.slice(1, 5)).toEqual(['Documento', 'Staging', 'Icono', 'Nombre']);
		expect(await (await cell(page, 'frente.png', 'Documento')).locator('.oc-action').getAttribute('aria-label')).toBe('Ver documento');
		expect(await (await cell(page, 'frente.png', 'Staging')).locator('.oc-action').getAttribute('aria-label')).toBe('Ver en staging');
		await shot('acciones');
		await (await cell(page, 'frente.png', 'Documento')).locator('.oc-action').click();
		const doc = dialog(page).getByRole('region', { name: 'Documento frente.png' });
		await doc.waitFor();
		expect(await doc.getByTestId('doc-preview').locator('img').getAttribute('src')).toMatch(/frente\.png$/);
		await dialog(page).getByRole('navigation', { name: 'Migas' }).getByRole('button', { name: 'Archivos' }).click();
		await fileRow(page, 'planes.csv').waitFor();

		// Cerrar y volver (otra carga de la página): retoma la misma corrida, en el paso de Análisis.
		await dialog(page).getByRole('button', { name: 'Cerrar', exact: true }).first().click();
		await page.reload();
		await page.locator('.oc-grid__legend', { hasText: 'Filas' }).waitFor({ timeout: 20_000 });
		await page.locator('#tabla-planes').getByRole('button', { name: 'Importar archivos' }).click();
		await dialog(page).getByTestId('resumed').waitFor({ timeout: 10_000 });
		await fileRow(page, 'planes.csv').waitFor({ timeout: 10_000 });
		expect(await fileRow(page, 'frente.png').count()).toBe(1);
		expect(await dialog(page).getByRole('list', { name: 'Pasos' }).locator('[aria-current="step"]').innerText()).toBe('Análisis');
		expect(await chat(page).locator('[data-rol="usuario"]').allInnerTexts()).toEqual(['Solo octubre']);
		expect((await lastRun()).id).toBe(id);
		await shot('retomada');

		// «Empezar de cero»: otra corrida, vacía.
		await dialog(page).getByRole('button', { name: 'Empezar de cero' }).click();
		await dialog(page).getByRole('region', { name: 'Soltar archivos' }).waitFor({ timeout: 10_000 });
		expect(await dialog(page).getByTestId('resumed').count()).toBe(0);
		expect(await filesSheet(page).count()).toBe(0);
		expect(await chat(page).locator('[data-rol="usuario"]').count()).toBe(0);
		await expect.poll(async () => (await lastRun()).id).not.toBe(id);
	});

	it('AI-5 · «Ver staging» abre la hoja real de Planes GMF con los cambios de 2 archivos (amarillo solo lo que cambia, verde lo nuevo, tachado lo que se elimina) y el panel de cambios; se edita; «Importar» pide confirmar las eliminaciones, un error de guardado vuelve a la celda y al chat, y al corregir se guarda tal cual', async () => {
		await api('/api/import-assistant/planes/dev/reset', { body: {} });
		const { page, shot } = await openPage();
		await page.locator('#tabla-planes').getByRole('button', { name: 'Importar archivos' }).click();
		await dialog(page).waitFor();
		// Octubre: AVEO contado igual; AVEO GMF con otro precio (archivo a); AVEO LT nuevo (archivo b). ONIX contado ya no viene.
		await dialog(page).getByLabel('Archivos a importar').setInputFiles([
			{ name: 'octubre-a.csv', mimeType: 'text/csv', buffer: csvPlanes([FILAS_OK[0]!, ['AVEO HB 2026', 'A', 'LS Manual', 'GMF TASA SUBSIDIADA CON SEGURO', 'RCC', 'HCAM', '$329,100', '($60,000)', '$269,100']]) },
			{ name: 'octubre-b.csv', mimeType: 'text/csv', buffer: csvPlanes([FILAS_OK[2]!]) }
		]);
		await fileRow(page, 'octubre-b.csv').waitFor({ timeout: 15_000 });
		await footer(page).getByRole('button', { name: 'Analizar' }).click();
		await waitCell(page, 'octubre-b.csv', 'Estado', /^Analizado/);
		await waitCell(page, 'octubre-a.csv', 'Estado', /^Analizado/);

		// «Ver staging»: la hoja real de la tabla destino, con los cambios de los dos archivos.
		await (await cell(page, 'octubre-a.csv', 'Staging')).locator('.oc-action').click();
		const region = dialog(page).getByRole('tabpanel', { name: 'Staging de Planes GMF' });
		const staging = region.getByTestId('staging');
		const row = (text: string) => staging.locator('.oc-grid__sheet tbody tr', { hasText: text });
		await row('LEASING').waitFor({ timeout: 15_000 });
		expect(await region.getByTestId('staging-summary').innerText()).toBe('Reemplazar · 3 filas hoy · 1 nueva · 1 con cambios · 1 se elimina');
		const cols = await columns(staging);
		const td = (text: string, column: string) => row(text).locator('td').nth(cols.get(column)!);
		const cls = async (text: string, column: string) => (await td(text, column).getAttribute('class')) ?? '';
		// update: solo las celdas que cambian, en amarillo.
		await expect.poll(() => cls('GMF TASA', 'Precio de lista'), { timeout: 10_000 }).toContain('oc-cell-dirty');
		expect(await cls('GMF TASA', 'Precio Final')).toContain('oc-cell-dirty');
		expect(await cls('GMF TASA', 'Modelo')).not.toContain('oc-cell-dirty');
		expect(await cls('GMF TASA', 'Descuento')).not.toContain('oc-cell-dirty');
		// La fila idéntica, sin marca.
		const contado = row('AVEO HB 2026').filter({ hasText: 'CONTADO' });
		expect(await contado.locator('td.oc-cell-dirty, td.oc-cell-new, td.oc-row-deleted').count()).toBe(0);
		// insert en verde; delete tachada.
		expect(await cls('LEASING', 'Modelo')).toContain('oc-cell-new');
		expect(await cls('ONIX 2026', 'Modelo')).toContain('oc-row-deleted');
		// El panel de control de cambios, abierto con los tres.
		await expect.poll(() => staging.locator('li.list-row').count(), { timeout: 10_000 }).toBe(3);
		await shot('staging');

		/** Escribir en una celda del staging, como la persona: doble clic, escribir, Enter. */
		const edit = async (text: string, column: string, value: string) => {
			const target = td(text, column);
			await target.scrollIntoViewIfNeeded();
			await target.dblclick();
			await staging.locator('.oc-grid__sheet td.editor input').fill(value);
			await page.keyboard.press('Enter');
		};
		// La persona edita el staging (con el panel cerrado, la hoja ocupa todo): se guarda en la corrida.
		await staging.getByRole('button', { name: 'Cerrar panel' }).click();
		await edit('LEASING', 'Seguro Gratis', '1 año');
		await expect
			.poll(async () => (await lastRun()).staging?.planes?.cambios?.find((c: any) => c.op === 'insert')?.valores?.seguro, { timeout: 10_000 })
			.toBe('1 año');
		// Un valor que solo el servidor rechaza (lista + descuento ≠ final).
		await edit('LEASING', 'Precio Final', '999');

		// «Importar»: replace con eliminaciones pide confirmación, con conteo y lista.
		await footer(page).getByRole('button', { name: /^Importar todo/ }).click();
		const confirm = dialog(page).getByTestId('confirm-deletes');
		await confirm.waitFor({ timeout: 10_000 });
		expect(await confirm.locator('strong').innerText()).toBe('Se eliminará 1 fila de Planes GMF: no vienen en los archivos y el modo es reemplazar.');
		expect(await confirm.locator('li').allInnerTexts()).toEqual(['ONIX 2026 · A · LS · CONTADO CON SEGURO']);
		await shot('confirmacion');
		// Cancelar no guarda nada.
		await confirm.getByRole('button', { name: 'Cancelar' }).click();
		expect(await confirm.count()).toBe(0);
		expect((await api('/api/import-assistant/planes?limit=50')).body.total).toBe(3);

		// Confirmar: el servidor rechaza el lote; el motivo vuelve a la celda y al chat.
		await footer(page).getByRole('button', { name: /^Importar todo/ }).click();
		await confirm.getByRole('button', { name: 'Eliminar 1 e importar' }).click();
		await expect.poll(() => cls('LEASING', 'Precio Final'), { timeout: 10_000 }).toContain('oc-cell-invalid');
		expect(await td('LEASING', 'Precio Final').getAttribute('title')).toBe('Debería ser 270700 (lista + descuento)');
		await expect
			.poll(() => chat(page).locator('[data-rol="agente"]').last().innerText(), { timeout: 10_000 })
			.toMatch(/^No se pudo guardar Planes GMF: El lote tiene valores inválidos\. Corrige las celdas marcadas y vuelve a importar\.\n• AVEO HB 2026 · B · LT Manual · LEASING · Precio Final: Debería ser 270700/);
		expect((await api('/api/import-assistant/planes?limit=50')).body.total).toBe(3);

		// Corregir e importar: la hoja se guarda tal cual (con lo editado) y la corrida queda importada.
		await edit('LEASING', 'Precio Final', '270700');
		await footer(page).getByRole('button', { name: /^Importar todo/ }).click();
		await confirm.getByRole('button', { name: 'Eliminar 1 e importar' }).click();
		const stepper = dialog(page).getByRole('list', { name: 'Pasos' });
		await expect.poll(() => stepper.locator('[aria-current="step"]').innerText(), { timeout: 20_000 }).toBe('Resultado');
		expect(await dialog(page).getByTestId('total-ok').innerText()).toBe('1 nueva · 1 actualizada · 1 eliminada');
		await waitCell(page, 'octubre-a.csv', 'Estado', 'Guardado con el staging');
		const planes = (await api('/api/import-assistant/planes?limit=50')).body.rows;
		expect(planes.map((r: any) => [r.id, r.tipoPago, r.precioLista, r.precioFinal, r.seguro])).toEqual([
			['pl_00001', 'CONTADO CON SEGURO', 319100, 319100, null],
			['pl_00002', 'GMF TASA SUBSIDIADA CON SEGURO', 329100, 269100, null],
			['pl_00004', 'LEASING', 346500, 270700, '1 año']
		]);
		await expect.poll(() => chat(page).locator('[data-rol="agente"]').last().innerText(), { timeout: 10_000 }).toContain('Planes GMF: 1 nueva, 1 actualizada, 1 eliminada.');
		await shot('resultado');
	});

	it('AI-6 · emparejamiento en el staging: la foto de una unidad llena la Imagen de sus planes (amarillo, con miniatura); la que no empareja se avisa; importar guarda la columna', async () => {
		await api('/api/import-assistant/planes/dev/reset', { body: {} });
		const { page, shot } = await openPage();
		await page.locator('#tabla-planes').getByRole('button', { name: 'Importar archivos' }).click();
		await dialog(page).waitFor();
		await dialog(page).getByLabel('Archivos a importar').setInputFiles([
			{ name: 'AVEO HB 2026 LS Manual.png', mimeType: 'image/png', buffer: PNG },
			{ name: 'catalogo.png', mimeType: 'image/png', buffer: PNG }
		]);
		await fileRow(page, 'catalogo.png').waitFor({ timeout: 15_000 });
		await chooseDestination(page, 'AVEO HB 2026 LS Manual.png', 'adjuntar:imagen');
		await chooseDestination(page, 'catalogo.png', 'adjuntar:imagen');
		await footer(page).getByRole('button', { name: 'Analizar' }).click();
		await waitCell(page, 'catalogo.png', 'Estado', /^Analizado/);
		await waitCell(page, 'AVEO HB 2026 LS Manual.png', 'Estado', /^Analizado/);

		await (await cell(page, 'AVEO HB 2026 LS Manual.png', 'Staging')).locator('.oc-action').click();
		const region = dialog(page).getByRole('tabpanel', { name: 'Staging de Planes GMF' });
		const staging = region.getByTestId('staging');
		await expect.poll(() => staging.locator('li.list-row').count(), { timeout: 15_000 }).toBe(2);
		const cols = await columns(staging);
		for (const id of ['pl_00001', 'pl_00002']) {
			const td = staging.locator('.oc-grid__sheet tbody tr', { hasText: id }).locator('td').nth(cols.get('Imagen')!);
			await expect.poll(async () => (await td.getAttribute('class')) ?? '').toContain('oc-cell-dirty');
			expect(await td.locator('img').getAttribute('src')).toMatch(/AVEO-HB-2026-LS-Manual\.png$/);
		}
		expect(await region.getByTestId('sin-emparejar').innerText()).toBe('Sin emparejar: «catalogo.png»: su nombre no coincide con ninguna fila (Modelo, Versión, Paquete)');
		await shot('emparejado');

		await footer(page).getByRole('button', { name: /^Importar todo/ }).click();
		await expect.poll(() => dialog(page).getByRole('list', { name: 'Pasos' }).locator('[aria-current="step"]').innerText(), { timeout: 20_000 }).toBe('Resultado');
		expect(await dialog(page).getByTestId('total-ok').innerText()).toBe('0 nuevas · 2 actualizadas · 0 eliminadas · 1 archivo adjunto');
		await waitCell(page, 'AVEO HB 2026 LS Manual.png', 'Estado', 'En la columna «imagen»');
		// La que no emparejó no quedó en la tabla, y lo dice.
		expect(await cellText(page, 'catalogo.png', 'Estado')).toBe('Error: No se emparejó con ninguna fila: «catalogo.png»: su nombre no coincide con ninguna fila (Modelo, Versión, Paquete)');
		const planes = (await api('/api/import-assistant/planes?limit=50')).body.rows;
		expect(planes.map((r: any) => (r.imagen ? r.imagen.split('/').pop() : null))).toEqual(['AVEO-HB-2026-LS-Manual.png', 'AVEO-HB-2026-LS-Manual.png', null]);
	});

	it('AI-7 · en vivo: el asistente escucha la corrida (GET /events) y se actualiza sin sondear; «Detener» llama a POST /stop', async () => {
		const { page } = await openPage();
		const events = page.waitForRequest((r) => /\/runs\/[^/]+\/events$/.test(r.url()));
		await page.locator('#tabla-planes').getByRole('button', { name: 'Importar archivos' }).click();
		await chat(page).locator('[data-bienvenida]').waitFor({ timeout: 10_000 });
		expect((await events).headers()['x-user']).toBe(who);
		// Otro cliente (la app, un worker) escribe en la corrida: llega por el canal en vivo.
		const run = (await lastRun()).id;
		await api(`/api/import-assistant/runs/${run}/chat`, { body: { texto: 'Hola desde otro lado' }, headers: { 'X-User': who } });
		await expect.poll(() => chat(page).locator('[data-rol="usuario"]').allInnerTexts(), { timeout: 10_000 }).toEqual(['Hola desde otro lado']);

		// Mientras el asistente piensa, «Detener».
		await page.route('**/chat', async (route) => {
			await new Promise((r) => setTimeout(r, 1500));
			await route.continue();
		});
		await chat(page).getByLabel('Mensaje para el asistente').fill('Una pregunta lenta');
		await chat(page).getByRole('button', { name: 'Enviar' }).click();
		const stop = page.waitForResponse((r) => /\/runs\/[^/]+\/stop$/.test(r.url()));
		await chat(page).getByRole('button', { name: 'Detener' }).click();
		const res = await stop;
		expect(res.status()).toBe(200);
		expect(await res.json()).toHaveProperty('detenido');
	});

	it('AI-8 · a pantalla completa y sin leyenda; pestañas Archivos + una por destino; spinner y progreso en vivo en Estado; «Ver en staging» resalta las filas del archivo; importar solo esa tabla (la corrida sigue abierta); «Importar todo» con insignia y tooltip', async () => {
		await api('/api/import-assistant/planes/dev/reset', { body: {} });
		const { page, shot } = await openPage();
		await page.setViewportSize({ width: 1366, height: 900 });
		// La hoja de la página conserva su leyenda.
		expect(await page.locator('#tabla-planes .oc-grid__legend').innerText()).toContain('Celda editada sin guardar');
		await page.locator('#tabla-planes').getByRole('button', { name: 'Importar archivos' }).click();
		await dialog(page).waitFor();
		// A pantalla completa: 100vw × 100vh, sin márgenes.
		// (tras la animación de apertura del modal)
		await expect.poll(async () => {
			const box = (await dialog(page).getByTestId('import-assistant').boundingBox())!;
			return [box.x, box.y, box.width, box.height].map(Math.round);
		}).toEqual([0, 0, 1366, 900]);
		const tabs = dialog(page).getByRole('tablist', { name: 'Vistas' });
		const tabNames = async () => (await tabs.getByRole('tab').allInnerTexts()).map((t) => t.trim().split('\n')[0]!.trim()).filter((t) => !t.startsWith('Chat'));
		expect(await tabNames()).toEqual(['Archivos']);

		// «lento» en el nombre: el modelo del ejemplo lo analiza despacio, para ver el progreso.
		await dialog(page).getByLabel('Archivos a importar').setInputFiles([
			{ name: 'octubre-a lento.csv', mimeType: 'text/csv', buffer: csvPlanes(OCT_A) },
			{ name: 'octubre-b.csv', mimeType: 'text/csv', buffer: csvPlanes(OCT_B) },
			{ name: 'notas.txt', mimeType: 'text/plain', buffer: Buffer.from('Vigencia octubre') }
		]);
		await fileRow(page, 'notas.txt').waitFor({ timeout: 15_000 });
		await chooseDestination(page, 'notas.txt', 'descartar');
		// Sin leyenda dentro del asistente.
		expect(await filesSheet(page).locator('.oc-grid__sheet').count()).toBe(1);
		expect(await filesSheet(page).locator('.oc-grid__legend').count()).toBe(0);
		await footer(page).getByRole('button', { name: 'Analizar' }).click();

		// Mientras analiza: spinner en la celda Estado y el progreso que llega en vivo (SSE `progreso`).
		const icon = async (name: string) => {
			const img = (await cell(page, name, 'Estado')).locator('img');
			return (await img.count()) ? decodeURIComponent((await img.getAttribute('src')) ?? '') : '';
		};
		await expect.poll(() => icon('octubre-a lento.csv'), { timeout: 10_000 }).toContain('data-sb="trabajando"');
		await expect.poll(() => cellText(page, 'octubre-a lento.csv', 'Estado'), { timeout: 10_000 }).toMatch(/^Analizando… (leyendo|mapeando|proponiendo|revisando|cerrando|Revisando|empezando)/);
		expect(await tabs.getByRole('tab', { name: /Archivos/ }).getByTestId('tab-working').count()).toBe(1);
		// El otro archivo ya terminó: su destino tiene pestaña, con spinner mientras el análisis sigue.
		const planesTab = tabs.getByRole('tab', { name: /Planes GMF/ });
		await planesTab.waitFor({ timeout: 10_000 });
		expect(await planesTab.getByTestId('tab-working').count()).toBe(1);
		await shot('archivos-spinners');
		await capture(page, '1366-archivos-spinners');

		// Terminó: sin spinner; la pestaña del destino trae sus conteos (nuevas, actualizadas, eliminadas, errores).
		await waitCell(page, 'octubre-a lento.csv', 'Estado', /^Analizado/, 30_000);
		await expect.poll(() => icon('octubre-a lento.csv')).toContain('data-sb="listo"');
		await expect.poll(() => tabs.getByRole('tab', { name: /Archivos/ }).getByTestId('tab-working').count()).toBe(0);
		expect(await tabNames()).toEqual(['Archivos', 'Planes GMF']);
		await expect.poll(() => planesTab.getByTestId('tab-counts').innerText(), { timeout: 10_000 }).toMatch(/\+1\s*~1\s*−1/);
		expect(await planesTab.locator('.sr-only').innerText()).toBe('1 nueva · 1 actualizada · 1 eliminada · 0 errores');

		// «Importar todo»: insignia con el número de tablas y, al pasar el cursor, cuáles con sus conteos.
		const importAll = footer(page).getByRole('button', { name: /^Importar todo/ });
		expect(await importAll.getByTestId('import-all-count').innerText()).toBe('1');
		const tooltip = footer(page).getByTestId('import-all-tooltip');
		// (el cursor quedó sobre el botón al pulsar «Analizar»: se aparta)
		await page.mouse.move(5, 300);
		await expect.poll(() => tooltip.isVisible()).toBe(false);
		await importAll.hover();
		await expect.poll(() => tooltip.isVisible()).toBe(true);
		expect((await tooltip.innerText()).split('\n').filter(Boolean)).toEqual(['Importa 1 tabla:', 'Planes GMF: 1 nueva · 1 actualizada · 1 eliminada · 0 errores', 'Y los demás archivos (adjuntos y descartes).']);
		await shot('tooltip-global');
		await capture(page, '1366-tooltip-importar-todo');
		await page.mouse.move(0, 0);

		// «Ver en staging» de octubre-b: abre la pestaña de Planes GMF y resalta la fila que salió de él.
		await (await cell(page, 'octubre-b.csv', 'Staging')).locator('.oc-action').click();
		const panel = dialog(page).getByRole('tabpanel', { name: 'Staging de Planes GMF' });
		const staging = panel.getByTestId('staging');
		const lit = staging.locator('.oc-grid__sheet tbody tr').filter({ has: page.locator('td.oc-row-highlight') });
		await expect.poll(() => lit.count(), { timeout: 15_000 }).toBe(1);
		expect(await lit.innerText()).toContain('LEASING');
		expect(await planesTab.getAttribute('aria-selected')).toBe('true');
		expect(await panel.getByTestId('staging-highlight').innerText()).toContain('1 fila resaltada de «octubre-b.csv»');
		expect(await staging.locator('.oc-grid__legend').count()).toBe(0);
		expect(await panel.getByTestId('staging-files').innerText()).toBe('De octubre-a lento.csv, octubre-b.csv');
		await shot('ver-en-staging');
		await capture(page, '1366-ver-en-staging-resalta');
		// El chat sigue a la derecha en la pestaña del destino.
		expect(await chat(page).isVisible()).toBe(true);

		// Desde Archivos, el otro archivo: la misma pestaña (la hoja se conserva) y su fila (la que cambia de precio).
		await tabs.getByRole('tab', { name: /Archivos/ }).click();
		await (await cell(page, 'octubre-a lento.csv', 'Staging')).locator('.oc-action').click();
		await expect.poll(async () => (await lit.allInnerTexts()).join('|'), { timeout: 10_000 }).toContain('GMF TASA');
		expect(await lit.count()).toBe(1);
		await panel.getByRole('button', { name: 'Quitar resaltado' }).click();
		await expect.poll(() => lit.count()).toBe(0);
		await staging.getByRole('button', { name: 'Cerrar panel' }).click();
		await capture(page, '1366-pestana-destino');

		// Importar solo Planes GMF (botón de su pestaña): replace con una eliminación pide confirmar.
		await panel.getByRole('button', { name: 'Importar Planes GMF' }).click();
		const confirm = panel.getByTestId('confirm-deletes');
		await confirm.waitFor({ timeout: 10_000 });
		await confirm.getByRole('button', { name: 'Eliminar 1 e importar' }).click();
		await expect.poll(() => planesTab.getByTestId('tab-counts').innerText(), { timeout: 20_000 }).toContain('importada');
		await panel.getByTestId('staging-imported').waitFor({ timeout: 10_000 });
		expect(await panel.getByTestId('staging-imported').innerText()).toBe('Importada: 1 nueva · 1 actualizada · 1 eliminada.');
		// La corrida sigue abierta: notas.txt no se importó; el chat lo reporta por destino.
		await expect.poll(async () => (await lastRun()).estado, { timeout: 10_000 }).toBe('lista');
		await expect
			.poll(() => chat(page).locator('[data-rol="agente"]').last().innerText(), { timeout: 10_000 })
			.toMatch(/^Importé Planes GMF: 3 filas importadas\.\nPlanes GMF: 1 nueva, 1 actualizada, 1 eliminada\.\n[\s\S]*Falta 1 archivo por importar: notas\.txt\.$/);
		const planes = (await api('/api/import-assistant/planes?limit=50')).body.rows;
		expect(planes.map((r: any) => r.tipoPago)).toEqual(['CONTADO CON SEGURO', 'GMF TASA SUBSIDIADA CON SEGURO', 'LEASING']);
		expect(await panel.getByRole('button', { name: 'Importar Planes GMF' }).isDisabled()).toBe(true);
		await capture(page, '1366-pestana-importada');

		// «Importar todo» con lo que falta (sin tablas pendientes: sin insignia) cierra la corrida.
		await tabs.getByRole('tab', { name: /Archivos/ }).click();
		expect(await cellText(page, 'notas.txt', 'Estado')).toBe('Analizado · fijado por ti');
		expect(await importAll.getByTestId('import-all-count').count()).toBe(0);
		await importAll.click();
		await expect.poll(() => dialog(page).getByRole('list', { name: 'Pasos' }).locator('[aria-current="step"]').innerText(), { timeout: 20_000 }).toBe('Resultado');
		await waitCell(page, 'notas.txt', 'Estado', 'Descartado');
		expect((await lastRun()).estado).toBe('terminada');
	}, 120_000);

	it('AI-9 · en pantalla chica (390 px): a pantalla completa, las pestañas (Archivos, destino y Chat) caben con desplazamiento y el staging se ve con su botón', async () => {
		await api('/api/import-assistant/planes/dev/reset', { body: {} });
		const { page } = await openPage();
		await page.setViewportSize({ width: 390, height: 844 });
		await page.getByRole('button', { name: 'o elige archivos' }).click();
		await dialog(page).waitFor();
		// (tras la animación de apertura del modal)
		await expect.poll(async () => {
			const box = (await dialog(page).getByTestId('import-assistant').boundingBox())!;
			return [box.x, box.y, box.width, box.height].map(Math.round);
		}).toEqual([0, 0, 390, 844]);
		await dialog(page).getByLabel('Archivos a importar').setInputFiles([{ name: 'octubre-a lento.csv', mimeType: 'text/csv', buffer: csvPlanes(OCT_A) }]);
		await fileRow(page, 'octubre-a lento.csv').waitFor({ timeout: 15_000 });
		await footer(page).getByRole('button', { name: 'Analizar' }).click();
		await expect.poll(() => cellText(page, 'octubre-a lento.csv', 'Estado'), { timeout: 10_000 }).toMatch(/^Analizando…/);
		// Sin columnas fijas en pantalla chica: la hoja se desplaza hasta Estado.
		await (await cell(page, 'octubre-a lento.csv', 'Estado')).scrollIntoViewIfNeeded();
		await page.waitForTimeout(400);
		await capture(page, '390-archivos-spinner');
		await waitCell(page, 'octubre-a lento.csv', 'Estado', /^Analizado/, 30_000);
		const tabs = dialog(page).getByRole('tablist', { name: 'Vistas' });
		const planesTab = tabs.getByRole('tab', { name: /Planes GMF/ });
		await planesTab.waitFor({ timeout: 10_000 });
		// Nada se sale de la pantalla: la barra de pestañas se desplaza por dentro.
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		await planesTab.click();
		const panel = dialog(page).getByRole('tabpanel', { name: 'Staging de Planes GMF' });
		await panel.getByTestId('staging').locator('.oc-grid__sheet tbody tr', { hasText: 'GMF TASA' }).waitFor({ timeout: 15_000 });
		expect(await panel.getByRole('button', { name: 'Importar Planes GMF' }).isVisible()).toBe(true);
		await capture(page, '390-pestana-destino');
		// El chat, en su pestaña.
		await tabs.getByRole('tab', { name: /Chat/ }).click();
		expect(await chat(page).isVisible()).toBe(true);
		expect(await panel.isVisible()).toBe(false);
		await capture(page, '390-chat');
	}, 120_000);
});
