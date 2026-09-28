/**
 * Red y errores (tests/grid/README.md §5): doble clic, corte de red al guardar y
 * servidor caído al abrir. Los cortes se provocan interceptando las peticiones.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { FRONT_URL } from '../support/env.ts';
import { GridPage, uiButton } from '../support/grid.ts';
import { api } from '../support/api.ts';
import { reset } from '../protocol/support.ts';

const { user } = browserHarness();

beforeEach(async () => {
	await reset();
});

const countByName = async (name: string) =>
	(await api(`/api/cases?search=${encodeURIComponent(name)}`)).body.total as number;

/** Agrega una fila completa (Cliente, RFC y Etapa). */
async function addRow(grid: GridPage, name: string) {
	await grid.toolbar('Agregar fila');
	await expect.poll(() => grid.row('+').count()).toBe(1);
	await grid.editText('+', 'Cliente', name);
	await grid.editText('+', 'RFC', 'RED900101AA');
	await grid.setField(0, 'Etapa', 'early');
}

describe('red', () => {
	it('R-1 · doble clic en Guardar crea una sola fila', async () => {
		const { page } = await user('A');
		const grid = await new GridPage(page).open(`${FRONT_URL}/`);
		await addRow(grid, 'Doble Clic SA');
		await uiButton(page, 'Guardar').first().dblclick();
		await page.locator('dialog[open]').first().waitFor();
		expect(await countByName('Doble Clic SA')).toBe(1);
	});

	it('R-2 · se corta la red tras aplicar: el reintento usa la misma llave y no duplica (G-12)', async () => {
		const { page } = await user('A');
		const grid = await new GridPage(page).open(`${FRONT_URL}/`);
		await addRow(grid, 'Corte de Red SA');

		const keys: string[] = [];
		let cut = true;
		await page.route('**/api/cases/batch', async (route) => {
			keys.push(route.request().headers()['idempotency-key'] ?? '');
			if (cut) {
				cut = false;
				await route.fetch(); // llega al servidor y se aplica…
				await route.abort('connectionreset'); // …pero la respuesta nunca vuelve
				return;
			}
			await route.continue();
		});

		expect(await grid.save()).toContain('El guardado falló');
		expect(await countByName('Corte de Red SA')).toBe(1);
		await grid.closeDialog();

		expect(await grid.save()).toMatch(/Filas creadas\s*1/);
		expect(keys).toHaveLength(2);
		expect(keys[1]).toBe(keys[0]);
		expect(await countByName('Corte de Red SA')).toBe(1);
	});

	it('R-3 · servidor caído al abrir: aviso y Reintentar', async () => {
		const { page } = await user('A');
		await page.route('**/api/cases/schema', (route) => route.abort('connectionrefused'));
		await page.goto(`${FRONT_URL}/`);
		await expect.poll(() => page.getByText('No se pudo abrir la hoja').count(), { timeout: 15_000 }).toBe(1);

		await page.unroute('**/api/cases/schema');
		await page.getByRole('button', { name: 'Reintentar' }).click();
		const grid = new GridPage(page);
		await grid.rows().first().waitFor({ timeout: 20_000 });
		expect(await grid.rows().count()).toBeGreaterThan(0);
	});
});
