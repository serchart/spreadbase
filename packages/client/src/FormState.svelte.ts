/**
 * Estado de un formulario hecho con las columnas de SpreadBase (SB-25).
 *
 * Las columnas salen de una hoja —su esquema del servidor, con las búsquedas
 * de sus columnas `lookup` ya conectadas— o de una lista escrita en el
 * cliente. Cada `<Field>` pinta una y usa **el mismo tipo de celda** que la
 * hoja: su `parse`, su `format`, su `validate` y su editor (calendario, lista,
 * mini tabla). Así una fecha o un registro se eligen y se validan igual en la
 * hoja y en el formulario.
 *
 * ```ts
 * const form = new FormState(new Sheet('/api/contracts/sheet'), {
 *   customer_id: null, start_date: '2026-10-01'
 * }, { columns: { customer_id: { readOnly: false, required: true } } });
 * ```
 *
 * Los campos del formulario son las claves de `initial`: la hoja puede tener
 * más columnas y no estorban. `columns` ajusta cada columna solo aquí (como
 * `SheetOptions.columns`, SB-23): una columna de solo lectura en la hoja —el
 * cliente de un contrato ya creado— sí se captura en el alta.
 *
 * Las reglas del cliente guían; el servidor sigue siendo la autoridad al guardar.
 */
import { getCellType } from './cellTypes';
import type { Sheet } from './Sheet.svelte';
import type { CellTypeContext, CellValue, ColumnDef, GridRow } from './types';

export interface FormStateOptions {
	/** Ajustes por columna, solo en este formulario (`{ readOnly: false, required: true }`). */
	columns?: Record<string, Partial<ColumnDef>>;
}

export class FormState {
	/** Valores por campo, en su forma canónica (la misma que guarda la hoja). */
	values = $state<Record<string, CellValue>>({});
	/** Las columnas del formulario, en el orden de `initial`. Vacío hasta conectar. */
	columns = $state<ColumnDef[]>([]);
	/** Por qué no se pudo leer el esquema de la hoja, si falló. */
	loadError = $state<string | null>(null);
	/** Nombres de etiqueta de las columnas `lookup` (compartido con la hoja, si la hay). */
	labelCache: Map<string, string>;

	#touched = $state<Record<string, boolean>>({});
	#fields: string[];
	#options: FormStateOptions;
	/** Sube con cada elección en un editor: las etiquetas nuevas no son reactivas por sí solas. */
	#labels = $state(0);

	constructor(source: Sheet | ColumnDef[], initial: Record<string, CellValue>, options: FormStateOptions = {}) {
		this.#fields = Object.keys(initial);
		this.#options = options;
		this.values = { ...initial };
		if (Array.isArray(source)) {
			this.labelCache = new Map();
			this.#setColumns(source);
		} else {
			// Sin esquema todavía: la hoja comparte su caché al conectar.
			this.labelCache = new Map();
			source
				.connect()
				.then((grid) => {
					this.labelCache = grid.labelCache;
					this.#setColumns(grid.config.columns);
				})
				.catch((err) => {
					this.loadError = err instanceof Error ? err.message : String(err);
				});
		}
	}

	#setColumns(all: ColumnDef[]) {
		const byField = new Map(all.map((c) => [c.field, c]));
		this.columns = this.#fields.flatMap((field) => {
			const base = byField.get(field);
			if (!base) return [];
			return [{ ...base, ...this.#options.columns?.[field] }];
		});
	}

	/** El esquema ya llegó: los campos se pueden pintar. */
	get ready(): boolean {
		return this.columns.length > 0;
	}

	column(name: string): ColumnDef | undefined {
		return this.columns.find((c) => c.field === name);
	}

	/** Contexto para los tipos de celda (etiquetas de `lookup`). */
	get context(): CellTypeContext {
		return { labelCache: this.labelCache, requestRepaint: () => this.#labels++ };
	}

	set(name: string, value: CellValue) {
		this.values[name] = value;
		this.#labels++;
	}

	/** Texto visible del valor, con el formato de su tipo (la etiqueta en `select` y `lookup`). */
	display(name: string): string {
		void this.#labels;
		const column = this.column(name);
		if (!column) return '';
		return getCellType(column.type).format(this.values[name] ?? null, column, this.context);
	}

	/** El error del campo, se haya tocado o no. */
	errorOf(name: string): string | null {
		void this.#labels;
		const column = this.column(name);
		if (!column || column.readOnly) return null;
		return getCellType(column.type).validate(this.values[name] ?? null, column, this.values as GridRow, {
			labelCache: this.labelCache,
			fromServer: false
		});
	}

	/** El error que se muestra: solo después de tocar el campo (o de `touchAll`). */
	shownError(name: string): string | null {
		return this.#touched[name] ? this.errorOf(name) : null;
	}

	touch(name: string) {
		this.#touched[name] = true;
	}

	/** Muestra los errores de todos los campos: lo que hace un «Siguiente» con algo pendiente. */
	touchAll() {
		for (const field of this.#fields) this.#touched[field] = true;
	}

	/** Todos los campos pasan sus reglas. Falso mientras no llega el esquema. */
	get valid(): boolean {
		return this.ready && this.columns.every((c) => this.errorOf(c.field) === null);
	}
}
