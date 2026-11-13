/**
 * Carpeta con principal (SB-38, SB-29), sobre el ejemplo del catálogo
 * (`/catalog`):
 *
 * - La celda `folder` muestra el principal —el primero de la lista— según su
 *   tipo (miniatura si es imagen, ícono si no), siempre el número de archivos
 *   y, al pasar el cursor, los nombres.
 * - «Hacer principal» en el panel pasa un archivo al primer lugar.
 * - `avatar.image` sobre una carpeta: la miniatura es su principal si es
 *   imagen; si no, la primera imagen; si no hay, el respaldo. En la misma fila
 *   y en un `lookup` (el servidor la manda en `images`).
 */
import type { Locator, Page } from 'playwright';
import { beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { API_URL, FRONT_URL } from '../support/env.ts';
import { GridPage } from '../support/grid.ts';

const { user } = browserHarness();
const BASE = `${API_URL}/api/catalog`;
const file = (name: string) => `${BASE}/files/${name}`;

async function open(view: 'modelos' | 'unidades' = 'modelos', page?: Page) {
	if (page) {
		const grid = await new GridPage(page).open(`${FRONT_URL}/catalog?view=${view}`);
		return { page, grid };
	}
	const u = await user('A');
	const grid = await new GridPage(u.page).open(`${FRONT_URL}/catalog?view=${view}`);
	return { ...u, grid };
}

const thumbOf = (cell: Locator) => cell.locator('.oc-folder__thumb img');
const avatarImg = (cell: Locator) => cell.locator('.oc-avatar img');
const panel = (page: Page) => page.locator('.oc-cell-editor.oc-folder-editor');

beforeEach(async () => {
	await fetch(`${BASE}/reset`, { method: 'POST' });
});

describe('carpeta: el principal en la celda', () => {
	it('CP-1 · miniatura si el principal es imagen; ícono de su tipo si no; siempre el número; los nombres al pasar el cursor', async () => {
		const { grid } = await open();
		const onix = grid.cell(grid.rowById('md_1'), 'Fotos');
		await expect.poll(() => thumbOf(onix).getAttribute('src')).toBe(file('onix-frente.png'));
		expect(await onix.locator('.oc-folder__count').innerText()).toBe('3 archivos');
		expect(await onix.locator('.oc-folder').getAttribute('title')).toBe('onix-frente.png\nonix-lateral.png\nficha.pdf');

		// Principal PDF (aunque haya una imagen después): su ícono, no una miniatura.
		const aveo = grid.cell(grid.rowById('md_2'), 'Fotos');
		expect(await thumbOf(aveo).count()).toBe(0);
		expect(await aveo.locator('.oc-file__icon svg').getAttribute('class')).toContain('file-text');
		expect(await aveo.locator('.oc-folder__count').innerText()).toBe('2 archivos');

		// Principal de Excel: el ícono de hoja de cálculo.
		const tracker = grid.cell(grid.rowById('md_3'), 'Fotos');
		expect(await tracker.locator('.oc-file__icon svg').getAttribute('class')).toContain('file-spreadsheet');

		expect((await grid.cell(grid.rowById('md_4'), 'Fotos').innerText()).trim()).toBe('—');
	});

	it('CP-2 · avatar.image sobre la carpeta, en la misma fila: el principal, si no la primera imagen, si no el respaldo', async () => {
		const { grid } = await open();
		const modelo = (id: string) => grid.cell(grid.rowById(id), 'Modelo y año');
		await expect.poll(() => avatarImg(modelo('md_1')).getAttribute('src')).toBe(file('onix-frente.png'));
		expect(await avatarImg(modelo('md_2')).getAttribute('src')).toBe(file('aveo-interior.png'));
		expect(await avatarImg(modelo('md_3')).count()).toBe(0);
		expect(await modelo('md_3').locator('.oc-avatar').getAttribute('class')).toContain('is-fallback');
		expect((await modelo('md_1').innerText()).trim()).toBe('Onix 2026');
	});

	it('CP-3 · «Hacer principal» lo pasa al primer lugar; la celda y la miniatura del modelo lo siguen; se guarda en ese orden', async () => {
		const { grid, page, shot } = await open();
		const row = grid.rowById('md_1');
		const fotos = grid.cell(row, 'Fotos');
		await fotos.dblclick();
		await panel(page).waitFor();
		const names = () => panel(page).locator('.oc-folder-editor__item .oc-file__name').allInnerTexts();
		expect(await panel(page).locator('.oc-folder-editor__item.is-primary .oc-file__name').innerText()).toBe('onix-frente.png');
		// El primero no tiene la acción: ya es el principal.
		expect(await panel(page).getByRole('button', { name: 'Hacer principal onix-frente.png' }).count()).toBe(0);

		await panel(page).getByRole('button', { name: 'Hacer principal onix-lateral.png' }).click();
		expect(await names()).toEqual(['onix-lateral.png', 'onix-frente.png', 'ficha.pdf']);
		expect(await panel(page).locator('.oc-folder-editor__item.is-primary .oc-file__name').innerText()).toBe('onix-lateral.png');
		await shot('panel');
		await panel(page).getByRole('button', { name: 'Aceptar' }).click();
		await panel(page).waitFor({ state: 'detached' });

		expect(await thumbOf(fotos).getAttribute('src')).toBe(file('onix-lateral.png'));
		expect(await grid.state(row, 'Fotos')).toContain('oc-cell-dirty');
		// La miniatura del modelo se repinta con el principal nuevo.
		await expect.poll(() => avatarImg(grid.cell(row, 'Modelo y año')).getAttribute('src')).toBe(file('onix-lateral.png'));

		expect(await grid.save()).toContain('Cambios guardados');
		const saved = (await (await fetch(`${BASE}/models/md_1`)).json()).photos as { name: string }[];
		expect(saved.map((f) => f.name)).toEqual(['onix-lateral.png', 'onix-frente.png', 'ficha.pdf']);
	});

	it('CP-4 · vale para cualquier tipo: un PDF como principal muestra su ícono, y la miniatura del modelo cae a la primera imagen', async () => {
		const { grid, page } = await open();
		const row = grid.rowById('md_1');
		const fotos = grid.cell(row, 'Fotos');
		await fotos.dblclick();
		await panel(page).waitFor();
		await panel(page).getByRole('button', { name: 'Hacer principal ficha.pdf' }).click();
		await panel(page).getByRole('button', { name: 'Aceptar' }).click();
		await panel(page).waitFor({ state: 'detached' });
		expect(await thumbOf(fotos).count()).toBe(0);
		expect(await fotos.locator('.oc-file__icon svg').getAttribute('class')).toContain('file-text');
		expect(await fotos.locator('.oc-folder__count').innerText()).toBe('3 archivos');
		expect(await avatarImg(grid.cell(row, 'Modelo y año')).getAttribute('src')).toBe(file('onix-frente.png'));
	});
});

describe('carpeta: la miniatura en un lookup', () => {
	it('CP-5 · el modelo elegido muestra la foto principal de su carpeta (el servidor la resuelve en images)', async () => {
		const { grid, page } = await open('unidades');
		const modelo = (id: string) => grid.cell(grid.rowById(id), 'Modelo');
		await expect.poll(() => avatarImg(modelo('un_1')).getAttribute('src')).toBe(file('onix-frente.png'));
		expect(await avatarImg(modelo('un_2')).getAttribute('src')).toBe(file('aveo-interior.png'));
		expect(await avatarImg(modelo('un_3')).count()).toBe(0);

		// Lo que responde el servidor: la URL del principal, no la carpeta.
		const body = await (await fetch(`${BASE}/units?offset=0&limit=10`)).json();
		expect(body.images.model_id).toEqual({ md_1: file('onix-frente.png'), md_2: file('aveo-interior.png') });

		// Al cambiar el principal del modelo, las unidades lo siguen.
		const { grid: models } = await open('modelos', page);
		const fotos = models.cell(models.rowById('md_1'), 'Fotos');
		await fotos.dblclick();
		await panel(page).waitFor();
		await panel(page).getByRole('button', { name: 'Hacer principal onix-lateral.png' }).click();
		await panel(page).getByRole('button', { name: 'Aceptar' }).click();
		expect(await models.save()).toContain('Cambios guardados');
		const { grid: again } = await open('unidades', page);
		await expect.poll(() => avatarImg(again.cell(again.rowById('un_1'), 'Modelo')).getAttribute('src')).toBe(file('onix-lateral.png'));
	});
});
