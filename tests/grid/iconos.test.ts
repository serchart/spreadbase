/**
 * Íconos tomados de los datos (SB-39), sobre el ejemplo de etapas (`/stages`):
 *
 * - `avatar.iconField` en un `lookup` («Etapa» de Casos): el ícono de la etapa
 *   elegida en la celda y en la mini tabla del buscador, con respaldo a las
 *   iniciales; en una columna de texto («Etapa» de Etapas), de la misma fila.
 * - `Option.icon` en un `select`, y la lista sin repetir el valor si es igual
 *   a la etiqueta.
 * - Una fuente remota escrita a mano también entrega nombres e íconos de sus
 *   `lookup`: el buscador abre con la lista completa.
 * - `ColumnAction.label` como función de la fila («#1001»).
 *
 * Ninguna guarda: lo editado se queda en el borrador de un contexto nuevo.
 */
import type { Locator, Page } from 'playwright';
import { beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { API_URL, FRONT_URL } from '../support/env.ts';
import { GridPage } from '../support/grid.ts';

const { user } = browserHarness();
const BASE = `${API_URL}/api/stages`;

async function open(view = 'casos', theme?: string) {
	const u = await user('A');
	if (theme) await u.page.addInitScript((t) => localStorage.setItem('sb:theme', t), theme);
	const grid = await new GridPage(u.page).open(`${FRONT_URL}/stages?view=${view}`);
	return { ...u, grid };
}

const avatarOf = (cell: Locator) => cell.locator('.oc-avatar');
const popoverOf = (page: Page) => page.locator('.oc-cell-editor.oc-lookup-editor');
const listOf = (page: Page) => page.locator('.oc-cell-editor .oc-cell-editor__list');

beforeEach(async () => {
	await fetch(`${BASE}/reset`, { method: 'POST' });
});

describe('ícono del registro elegido en un lookup (avatar.iconField)', () => {
	it('IC-1 · cada celda de «Etapa» lleva el ícono de su etapa; su texto sigue siendo solo el nombre', async () => {
		const { grid } = await open();
		const expected: [number, string, string][] = [
			[1, 'Recepción', 'inbox'],
			[2, 'En espera', 'hourglass'],
			[3, 'Cita agendada', 'calendar-check'],
			[4, 'Cerrado', 'circle-check']
		];
		for (const [n, name, icon] of expected) {
			const cell = grid.cell(grid.row(n), 'Etapa');
			await expect.poll(() => avatarOf(cell).getAttribute('data-icon')).toBe(icon);
			expect(await avatarOf(cell).locator('svg').count()).toBe(1);
			expect(await avatarOf(cell).getAttribute('class')).toMatch(/\bis-square\b.*\bhas-icon\b/);
			expect((await cell.innerText()).trim()).toBe(name);
		}
	});

	it('IC-2 · sin ícono o con un nombre desconocido: las iniciales, como hoy', async () => {
		const { grid } = await open();
		const empty = avatarOf(grid.cell(grid.row(5), 'Etapa'));
		const unknown = avatarOf(grid.cell(grid.row(6), 'Etapa'));
		await expect.poll(() => empty.getAttribute('data-initials')).toBe('SÍ');
		expect(await unknown.getAttribute('data-initials')).toBe('ÍD');
		expect(await empty.locator('svg').count()).toBe(0);
		expect(await unknown.locator('svg').count()).toBe(0);
	});

	it('IC-3 · la mini tabla del buscador muestra el ícono de cada etapa, con la lista completa', async () => {
		const { grid, page } = await open();
		await grid.cell(grid.row(2), 'Etapa').locator('.oc-picker__chevron').click();
		const popover = popoverOf(page);
		await expect.poll(() => popover.locator('.oc-lookup__foot').innerText()).toBe('6 de 6');
		expect(await popover.locator('input').inputValue()).toBe('');
		const icons = await popover.locator('tbody tr').evaluateAll((trs) =>
			trs.map((tr) => [tr.textContent?.trim(), tr.querySelector('.oc-avatar')?.getAttribute('data-icon') ?? null])
		);
		expect(icons.slice(0, 4)).toEqual([
			['Recepción', 'inbox'],
			['En espera', 'hourglass'],
			['Cita agendada', 'calendar-check'],
			['Cerrado', 'circle-check']
		]);
		// La que ya tiene la celda queda resaltada.
		expect((await popover.locator('tr.is-active').innerText()).trim()).toBe('En espera');
	});

	it('IC-4 · al elegir otra etapa, la celda toma su ícono', async () => {
		const { grid, page } = await open();
		const cell = grid.cell(grid.row(1), 'Etapa');
		await cell.locator('.oc-picker__chevron').click();
		await page.keyboard.type('cita');
		await expect.poll(() => popoverOf(page).locator('.oc-lookup__foot').innerText()).toBe('1 de 1');
		await page.keyboard.press('Enter');
		await expect.poll(() => cell.innerText().then((t) => t.trim())).toBe('Cita agendada');
		expect(await avatarOf(cell).getAttribute('data-icon')).toBe('calendar-check');
		expect(await grid.state(grid.row(1), 'Etapa')).toContain('oc-cell-dirty');
	});

	it('IC-5 · el ícono se dibuja con currentColor: en tema oscuro toma el color claro del tema', async () => {
		const colorOf = async (theme: string) => {
			const { grid, page } = await open('casos', theme);
			const avatar = avatarOf(grid.cell(grid.row(2), 'Etapa'));
			await expect.poll(() => avatar.getAttribute('data-icon')).toBe('hourglass');
			const [stroke, color] = await avatar.evaluate((node) => [node.querySelector('svg')!.getAttribute('stroke'), getComputedStyle(node).color]);
			await page.close();
			return { stroke, color };
		};
		const light = await colorOf('oc-light');
		const dark = await colorOf('oc-midnight');
		expect(light.stroke).toBe('currentColor');
		expect(dark.stroke).toBe('currentColor');
		expect(dark.color).not.toBe(light.color);
		expect(brightness(dark.color)).toBeGreaterThan(brightness(light.color));
	});
});

/** 0…255: el promedio de los canales de un color computado (`rgb(…)` u `oklch(L …)`). */
function brightness(css: string): number {
	const oklch = css.match(/^oklch\(([\d.]+)(%?)/);
	if (oklch) return (Number(oklch[1]) / (oklch[2] ? 100 : 1)) * 255;
	const [r = 0, g = 0, b = 0] = (css.match(/[\d.]+/g) ?? []).map(Number);
	return (r + g + b) / 3;
}

describe('ícono de la misma fila en una columna de texto', () => {
	it('IC-6 · en Etapas, el nombre lleva el ícono de su campo «Ícono»', async () => {
		const { grid } = await open('etapas');
		const name = grid.cell(grid.row(2), 'Etapa');
		await expect.poll(() => avatarOf(name).getAttribute('data-icon')).toBe('hourglass');
		expect((await name.innerText()).trim()).toBe('En espera');
		expect(await avatarOf(grid.cell(grid.row(5), 'Etapa')).getAttribute('data-initials')).toBe('SÍ');
	});
});

describe('ícono por opción en un select', () => {
	it('IC-7 · «Prioridad» pinta el ícono de la opción en la celda y en la lista; el código va a la derecha', async () => {
		const { grid, page } = await open();
		const cell = grid.cell(grid.row(1), 'Prioridad');
		expect(await cell.locator('.oc-option-icon').getAttribute('data-icon')).toBe('arrow-up');
		expect((await cell.innerText()).trim()).toBe('Alta');
		expect(await grid.cell(grid.row(2), 'Prioridad').locator('.oc-option-icon').getAttribute('data-icon')).toBe('minus');

		await cell.locator('.oc-picker__chevron').click();
		const options = listOf(page).locator('.oc-cell-editor__option');
		await expect.poll(() => options.count()).toBe(3);
		const seen = await options.evaluateAll((els) =>
			els.map((el) => [
				el.querySelector('.oc-option-icon')?.getAttribute('data-icon') ?? null,
				el.querySelector('.oc-cell-editor__label')?.textContent,
				el.querySelector('.oc-cell-editor__value')?.textContent ?? null
			])
		);
		expect(seen).toEqual([
			['arrow-up', 'Alta', 'high'],
			['minus', 'Media', 'medium'],
			['arrow-down', 'Baja', 'low']
		]);

		// Elegir otra cambia también el ícono de la celda.
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect.poll(() => cell.locator('.oc-option-icon').getAttribute('data-icon')).toBe('arrow-down');
		expect((await cell.innerText()).trim()).toBe('Baja');
	});

	it('IC-8 · con valor y etiqueta iguales («Estado»), la lista no repite el valor', async () => {
		const { grid, page } = await open();
		const cell = grid.cell(grid.row(1), 'Estado');
		expect(await cell.locator('.oc-option-icon').count()).toBe(0);
		await cell.locator('.oc-picker__chevron').click();
		const options = listOf(page).locator('.oc-cell-editor__option');
		await expect.poll(() => options.count()).toBe(2);
		expect(await options.allInnerTexts()).toEqual(['Abierto', 'Cerrado']);
		expect(await listOf(page).locator('.oc-cell-editor__value').count()).toBe(0);
	});
});

describe('fuente remota pasada directamente', () => {
	it('IC-9 · los nombres e íconos del lookup llegan igual, y el buscador abre con la lista completa', async () => {
		const { grid, page } = await open('directa');
		const cell = grid.cell(grid.row(2), 'Etapa');
		// El nombre y no el id: `labels` de la página entró a la caché.
		await expect.poll(() => cell.innerText().then((t) => t.trim())).toBe('En espera');
		expect(await avatarOf(cell).getAttribute('data-icon')).toBe('hourglass');

		await cell.locator('.oc-picker__chevron').click();
		const popover = popoverOf(page);
		await expect.poll(() => popover.locator('.oc-lookup__foot').innerText()).toBe('6 de 6');
		expect(await popover.locator('input').inputValue()).toBe('');
		expect((await popover.locator('tr.is-active').innerText()).trim()).toBe('En espera');
		expect(await popover.locator('tr.is-active .oc-avatar').getAttribute('data-icon')).toBe('hourglass');
	});
});

describe('acción con el texto de la fila', () => {
	it('IC-10 · el botón dice el folio de su fila, con su ícono, y abre el detalle', async () => {
		const { grid, page } = await open();
		const button = grid.row(1).locator('.oc-action');
		await expect.poll(() => button.innerText().then((t) => t.trim())).toBe('#1001');
		expect(await button.getAttribute('aria-label')).toBe('#1001');
		expect(await button.locator('svg').count()).toBe(1);
		expect((await grid.row(2).locator('.oc-action').innerText()).trim()).toBe('#1002');

		await button.click();
		await expect.poll(() => page.locator('[data-testid="detalle"]').innerText()).toContain('#1001 · Caso 1001');
	});

	it('IC-11 · al editar el folio, el botón de esa fila cambia de texto', async () => {
		const { grid } = await open();
		await grid.editText(3, 'Folio', '2003');
		await expect.poll(() => grid.row(3).locator('.oc-action').innerText().then((t) => t.trim())).toBe('#2003');
		expect(await grid.row(3).locator('.oc-action').getAttribute('aria-label')).toBe('#2003');
	});
});
