/**
 * Acceso al DataGrid del playground, a través de la interfaz (doc 09 §4:
 * Playwright lee la UI y Vitest compara; el resultado final, cuando importa,
 * se verifica además por la API).
 */
import type { Locator, Page } from 'playwright';
import { expect } from 'vitest';

const SHEET = '.oc-grid__sheet';

/** Botón real de la toolbar o de la UI, nunca las copias invisibles de medición. */
export const uiButton = (page: Page, aria: string): Locator =>
	page.locator(`button[aria-label="${aria}"]:not(.invisible *,[aria-hidden="true"] *)`);

export class GridPage {
	columns = new Map<string, number>();

	constructor(public page: Page) {}

	/** Abre la grilla y espera a que tenga filas cargadas. */
	async open(url: string): Promise<this> {
		await this.page.goto(url);
		await expect(this.rows()).not.toHaveCount(0, { timeout: 20_000 });
		await this.readColumns();
		return this;
	}

	rows(): Locator {
		return this.page.locator(`${SHEET} tbody tr`);
	}

	private async readColumns(): Promise<void> {
		const labels = await this.page.locator(`${SHEET} thead td`).allTextContents();
		labels.forEach((label, x) => this.columns.set(label.trim(), x));
	}

	private column(fieldLabel: string): number {
		const x = this.columns.get(fieldLabel);
		if (x === undefined) throw new Error(`la grilla no tiene la columna «${fieldLabel}»`);
		return x;
	}

	/** Fila por su id (columna «ID»), presente o ausente. */
	rowById(id: string): Locator {
		return this.page.locator(`${SHEET} tbody tr`).filter({
			has: this.page.locator(`td:nth-child(2)`, { hasText: new RegExp(`^${id}$`, 'gm') })
		});
	}

	/** Fila por su número (primera columna), o por «+» en nuevas. */
	row(numberOrPlus: number | '+'): Locator {
		const text = String(numberOrPlus);
		return this.page.locator(`${SHEET} tbody tr`, {
			has: this.page.locator(`td.jss_row`, { hasText: new RegExp(`^${text.replace('+', '\\+')}$`) })
		});
	}

	cell(row: Locator, fieldLabel: string): Locator {
		return row.locator('td').nth(this.column(fieldLabel));
	}

	state(row: Locator, fieldLabel: string): Promise<string> {
		return this.cell(row, fieldLabel).getAttribute('class').then((c) => c ?? '');
	}

	/** Edita una celda de texto escribiendo y confirmando con Enter. */
	async editText(idOrPlus: string | number | '+', fieldLabel: string, value: string): Promise<void> {
		const target = typeof idOrPlus === 'string' && idOrPlus.startsWith('case_') ? this.rowById(idOrPlus) : this.row(idOrPlus as number | '+');
		await target.scrollIntoViewIfNeeded();
		const cell = this.cell(target, fieldLabel);
		await cell.dblclick();
		await this.page.locator(`${SHEET} td.editor input`).fill(value);
		await this.page.keyboard.press('Enter');
	}

	/** Asigna un valor por la API de la hoja (para desplegables: abrirlos no es estable). */
	async setField(y: number, fieldLabel: string, value: string): Promise<void> {
		const x = this.column(fieldLabel);
		const found = await this.page.evaluate(
			([x, y, value]) => {
				const el = [...document.querySelectorAll('.oc-grid__sheet *')].find(
					(e) => (e as any).jspreadsheet
				) as any;
				const ws = Array.isArray(el?.jspreadsheet) ? el.jspreadsheet[0] : el?.jspreadsheet;
				if (!ws) return false;
				ws.setValueFromCoords(x, y, value);
				return true;
			},
			[x, y, value] as const
		);
		expect(found, 'instancia de jspreadsheet').toBe(true);
	}

	/** Espera a que terminen las cargas en vuelo («Cargando …» en la leyenda). */
	async settle(): Promise<void> {
		await expect(this.page.locator('.oc-grid__legend span', { hasText: 'Cargando' })).toHaveCount(0, { timeout: 15_000 });
	}

	/** Contenido del botón Cambios, sin etiqueta: los badges (p. ej. «Contratos»). */
	badges(): Locator {
		return this.page.locator('button[aria-label="Cambios"]', { has: this.page.locator('.badge') }).last();
	}

	/** Texto del diálogo abierto, si lo hay. */
	dialog(): Locator {
		return this.page.locator('dialog[open], [role="dialog"]');
	}

	/** Posición del scroll de la hoja. */
	async scrollTop(): Promise<number> {
		return Number(await this.page.locator(`${SHEET} .jss_content`).evaluate((el) => (el as HTMLElement).scrollTop));
	}
}
