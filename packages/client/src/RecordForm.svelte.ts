/**
 * Un registro de una hoja como formulario (SB-32): la ficha de un cliente, de
 * un usuario, de un contrato. Sus campos son las columnas **editables** de la
 * hoja, con los mismos editores y reglas (`Field`, SB-25), y guardar es un lote
 * de la hoja: solo lo que cambió, con la versión que se leyó.
 *
 * ```ts
 * const record = new RecordForm(new Sheet('/api/customers/sheet'), id, { exclude: ['assigned_user_id'] });
 * ```
 * ```svelte
 * {#if record.form}
 *   {#each record.fields as name (name)}<Field form={record.form} {name} />{/each}
 *   <button disabled={!record.dirty || record.saving} onclick={() => record.save()}>Guardar</button>
 * {/if}
 * ```
 *
 * - **Concurrencia**, la de la hoja (SB-7, G-15): si otro cambió el mismo
 *   campo, `conflict` dice cuáles y el formulario conserva lo tuyo para que
 *   decidas (`reload()` trae lo vigente); si cambió otro campo, se combina.
 * - **Errores del servidor**: los de un campo (reglas, «no corresponde a
 *   ningún registro») aparecen en ese campo; los demás (un RFC repetido del
 *   dominio), en `saveError`.
 */
import { getCellType, looseEquals } from './cellTypes';
import { FormState } from './FormState.svelte';
import { SpreadBaseApiError } from './remote';
import type { Sheet } from './Sheet.svelte';
import type { CellValue, ColumnDef } from './types';

export interface RecordFormOptions {
	/** Solo estos campos, en este orden. Default: todas las columnas editables de la hoja. */
	fields?: string[];
	/** Campos editables que no van en este formulario (se editan en otro lado). */
	exclude?: string[];
	/** Ajustes por columna, solo aquí (como `FormState`). */
	columns?: Record<string, Partial<ColumnDef>>;
}

type Row = Record<string, unknown>;

export class RecordForm {
	/** El formulario, cuando ya llegaron el esquema y el registro. */
	form = $state<FormState | null>(null);
	/** Los campos del formulario, en orden. */
	fields = $state<string[]>([]);
	loading = $state(true);
	loadError = $state<string | null>(null);
	saving = $state(false);
	/** Por qué no se guardó, cuando no es de un campo. */
	saveError = $state<string | null>(null);
	/** Otro cambió lo mismo mientras tanto: esos campos. Tus valores siguen en el formulario. */
	conflict = $state<string[] | null>(null);
	/** Sube con cada guardado exitoso: para avisar «Guardado» o recargar lo demás. */
	savedCount = $state(0);

	readonly #sheet: Sheet;
	readonly #id: string | number;
	readonly #options: RecordFormOptions;
	#row: Row | null = null;
	#idField = 'id';
	/** La fila vigente que trajo el último conflicto. */
	#remote: Row | null = null;

	constructor(sheet: Sheet, id: string | number, options: RecordFormOptions = {}) {
		this.#sheet = sheet;
		this.#id = id;
		this.#options = options;
		void this.reload();
	}

	/** Vuelve a leer el registro del servidor; descarta lo no guardado. */
	async reload(): Promise<void> {
		this.loadError = null;
		this.conflict = null;
		this.saveError = null;
		try {
			const grid = await this.#sheet.connect();
			this.#idField = grid.config.idField ?? 'id';
			const client = this.#sheet.client({ [this.#idField]: String(this.#id) });
			if (!client) throw new Error('RecordForm necesita una hoja con servidor');
			// Por la lista con filtro de id, no por `GET /:id`: trae los nombres y fotos de sus `lookup`.
			const page = await client.loadPage({ offset: 0, limit: 1 }, new AbortController().signal);
			const row = page.rows[0];
			if (!row) throw new Error('El registro no existe');
			this.#row = row;

			const editable = grid.config.columns.filter((c) => !c.readOnly && c.type !== 'action' && c.field !== this.#idField);
			const wanted = this.#options.fields ?? editable.map((c) => c.field).filter((f) => !this.#options.exclude?.includes(f));
			const byField = new Map(editable.map((c) => [c.field, c]));
			const columns = wanted.flatMap((f) => (byField.has(f) ? [{ ...byField.get(f)!, ...this.#options.columns?.[f] }] : []));
			const form = new FormState(columns, Object.fromEntries(columns.map((c) => [c.field, (row[c.field] ?? null) as CellValue])));
			// Los `lookup` con su nombre y su foto: el campo nunca muestra un id.
			for (const c of columns) {
				const value = row[c.field];
				if (c.type !== 'lookup' || value === null || value === undefined) continue;
				form.set(c.field, value as CellValue, page.labels?.[c.field]?.[String(value)], page.images?.[c.field]?.[String(value)]);
			}
			this.fields = columns.map((c) => c.field);
			this.form = form;
		} catch (err) {
			this.loadError = err instanceof Error ? err.message : String(err);
		} finally {
			this.loading = false;
		}
	}

	/** Lo que se leyó del servidor, por campo. */
	original(name: string): CellValue {
		return (this.#row?.[name] ?? null) as CellValue;
	}

	/** Los campos que cambiaron respecto a lo leído. */
	get changed(): string[] {
		const form = this.form;
		if (!form) return [];
		return this.fields.filter((f) => {
			const column = form.column(f)!;
			const equals = getCellType(column.type).equals ?? looseEquals;
			return !equals(form.values[f] ?? null, this.original(f));
		});
	}

	get dirty(): boolean {
		return this.changed.length > 0;
	}

	/** Vuelve a lo leído, sin ir al servidor. */
	reset(): void {
		const form = this.form;
		if (!form || !this.#row) return;
		for (const f of this.fields) form.set(f, this.original(f));
		this.conflict = null;
		this.saveError = null;
	}

	/**
	 * Tras un conflicto: guarda lo tuyo encima de lo vigente (la decisión
	 * «Mío» del panel de cambios de la hoja).
	 */
	async overwrite(): Promise<boolean> {
		if (!this.#remote) return false;
		this.#row = this.#remote;
		this.#remote = null;
		return this.save();
	}

	/**
	 * Guarda lo cambiado. `true` si quedó guardado (y el formulario, con lo que
	 * quedó en el servidor); `false` si hay errores o conflicto.
	 */
	async save(): Promise<boolean> {
		const form = this.form;
		const row = this.#row;
		if (!form || !row || this.saving) return false;
		form.touchAll();
		if (!form.valid) return false;
		const changed = this.changed;
		if (changed.length === 0) return true;

		this.saving = true;
		this.saveError = null;
		this.conflict = null;
		try {
			const client = this.#sheet.client()!;
			const base = Object.fromEntries(this.fields.filter((f) => !changed.includes(f)).map((f) => [f, row[f] ?? null]));
			const result = await client.saveBatch(
				{
					creates: [],
					updates: [
						{
							id: row[this.#idField],
							rowVersion: row.rowVersion,
							changes: Object.fromEntries(changed.map((f) => [f, { from: row[f] ?? null, to: form.values[f] ?? null }])),
							base
						}
					],
					deletes: []
				},
				crypto.randomUUID()
			);
			const conflict = result.conflicts[0];
			if (conflict) {
				this.#remote = conflict.remote;
				this.conflict = conflict.fields?.map((f) => form.column(f.field)?.label ?? f.field) ?? [];
				if (!conflict.remote) this.saveError = 'El registro ya no existe';
				return false;
			}
			await this.reload();
			this.savedCount++;
			return true;
		} catch (err) {
			if (err instanceof SpreadBaseApiError && Array.isArray(err.details)) {
				// `updates[0].changes.<campo>`: el error va a su campo.
				let placed = false;
				for (const d of err.details as { path?: string; message?: string }[]) {
					const field = /changes\.([^.]+)/.exec(d.path ?? '')?.[1];
					if (field && this.fields.includes(field)) {
						form.setServerError(field, d.message ?? 'Valor inválido');
						placed = true;
					}
				}
				if (!placed) this.saveError = err.message;
			} else {
				this.saveError = err instanceof Error ? err.message : String(err);
			}
			return false;
		} finally {
			this.saving = false;
		}
	}
}
