import { locateTable, type ImportResult, type ImportSchema } from '@spreadbase/core';
import { FormState } from './FormState.svelte';
import { Sheet, schemaColumns } from './Sheet.svelte';
import { getCellType, lookupKey, resolveLookupText } from './cellTypes';
import { readImportFile, type FileCell, type FileSheet } from './importFile';
import { remoteClient, SpreadBaseApiError, type RemoteOptions } from './remote';
import type { CellTypeContext, CellValue, ColumnDef } from './types';

export interface ImportFormatInfo {
	id: string;
	label: string;
	description: string | null;
}

export interface ImportStateOptions extends Pick<RemoteOptions, 'headers' | 'fetch'> {
	/** El formato con que abre. Default: el primero. */
	format?: string;
	/** Filas vacías de la hoja para escribir o pegar sin archivo. Default 20. */
	blankRows?: number;
}

/** Lo que se sabe del archivo leído. */
export interface ImportFileInfo {
	name: string;
	/** Fila del encabezado en el archivo (1 = la primera). */
	headerRow: number;
	rows: number;
	/** Columnas obligatorias que el archivo no trae. */
	missing: string[];
	/** Encabezados del archivo que no son de ninguna columna. */
	ignored: string[];
}

const ROW_KEY = '__row';

/**
 * El estado del importador (SB-34), sin interfaz: los formatos del servidor,
 * el formulario de lo que no viene en el archivo, la hoja local de la vista
 * previa (con lo leído, lo pegado o lo escrito) y el resultado de revisar y
 * aplicar. `<SheetImport>` lo dibuja; una app puede dibujarlo a su manera.
 *
 * - `url` es la base de `importRoutes` (`GET /`, `/:format/schema`, …).
 * - Leer un archivo encuentra su tabla (`locateTable`), empareja encabezados por
 *   etiqueta o alias, interpreta cada valor con el tipo de su columna (como al
 *   pegar) y resuelve los `lookup` contra el servidor.
 * - Revisar marca en la hoja lo que el servidor encontró, celda por celda.
 */
export class ImportState {
	formats = $state<ImportFormatInfo[]>([]);
	schema = $state<ImportSchema | null>(null);
	/** La vista previa: una hoja local con las columnas del archivo. */
	sheet = $state<Sheet | null>(null);
	/** Los datos que no vienen en el archivo (un valor para todas las filas). */
	form = $state<FormState | null>(null);
	file = $state<ImportFileInfo | null>(null);
	/** Las sumas del pie del archivo, si el formato las espera. */
	checksum = $state<Record<string, number> | null>(null);
	/** Los `either` que el archivo sí trae: esos no se piden en el formulario. */
	present = $state<string[]>([]);
	/** Todas las columnas que trae el archivo leído. */
	inFile = $state<string[]>([]);
	/** Lo último que dijo el servidor al revisar o aplicar. */
	result = $state<ImportResult | null>(null);
	busy = $state<'loading' | 'reading' | 'review' | 'apply' | null>(null);
	error = $state<string | null>(null);

	#columns: ColumnDef[] = [];
	#submitted: string[] = [];
	#seq = 0;

	constructor(
		readonly url: string,
		private readonly options: ImportStateOptions = {}
	) {}

	// -- formatos -------------------------------------------------------------------------

	async init(): Promise<void> {
		this.busy = 'loading';
		this.error = null;
		try {
			this.formats = await this.request<ImportFormatInfo[]>('');
			const first = this.options.format ?? this.formats[0]?.id;
			if (first) await this.select(first);
		} catch (err) {
			this.error = messageOf(err, 'No se pudieron leer los formatos');
		} finally {
			this.busy = null;
		}
	}

	async select(formatId: string): Promise<void> {
		this.error = null;
		const schema = await this.request<ImportSchema>(`/${encodeURIComponent(formatId)}/schema`);
		const remote = remoteClient(`${this.url.replace(/\/+$/, '')}/${encodeURIComponent(formatId)}`, this.options);
		this.#columns = schemaColumns(schema.columns, { ...remote, upload: () => Promise.reject(new Error('Sin subir archivos')) }).map((c) => ({
			...c,
			// En la vista previa todo se corrige: nada es de solo lectura.
			readOnly: false
		}));
		this.schema = schema;
		this.file = null;
		this.checksum = null;
		this.present = [];
		this.inFile = [];
		this.result = null;
		this.#buildForm();
		this.#buildSheet(Array.from({ length: this.options.blankRows ?? 20 }, () => ({})));
	}

	/**
	 * Las columnas de la vista previa: las del archivo. Leído un archivo, las
	 * opcionales que no trae no se muestran (un extracto no se llena de columnas
	 * vacías), y un `either` que no trae tampoco: su valor es el del formulario.
	 */
	get fileColumns(): ColumnDef[] {
		const spec = (field: string) => this.schema?.columns[field];
		return this.#columns.filter((c) => {
			const from = spec(c.field)?.from ?? 'file';
			if (from === 'form') return false;
			if (!this.file) return true;
			if (this.inFile.includes(c.field)) return true;
			return from === 'file' && !!spec(c.field)?.required;
		});
	}

	/** Lo que se pide en el formulario: los `form` y los `either` que el archivo no trae. */
	get formFields(): string[] {
		if (!this.schema) return [];
		return Object.entries(this.schema.columns)
			.filter(([field, c]) => c.from === 'form' || (c.from === 'either' && !this.present.includes(field)))
			.map(([field]) => field);
	}

	#buildForm(): void {
		const fields = this.formFields;
		const previous = this.form?.values ?? {};
		const initial: Record<string, CellValue> = {};
		for (const f of fields) {
			const column = this.#columns.find((c) => c.field === f);
			const def = typeof column?.defaultValue === 'function' ? column.defaultValue() : (column?.defaultValue ?? null);
			initial[f] = previous[f] ?? def;
		}
		this.form = new FormState(this.#columns, initial);
	}

	#buildSheet(rows: Record<string, unknown>[], labels?: Map<string, string>): void {
		const schema = this.schema!;
		const sheet = new Sheet({
			id: `import:${schema.id}:${++this.#seq}`,
			idField: ROW_KEY,
			columns: this.fileColumns,
			dataSource: { load: async () => rows.map((r, i) => ({ ...r, [ROW_KEY]: String(i + 1) })) },
			allowInsert: true,
			allowDelete: true,
			persist: 'none'
		});
		if (labels) for (const [k, v] of labels) sheet.grid!.labelCache.set(k, v);
		this.sheet = sheet;
	}

	// -- leer un archivo ------------------------------------------------------------------------

	/** Lee el archivo, lo interpreta con las columnas del formato y lo pone en la vista previa. */
	async loadFile(file: File): Promise<void> {
		if (!this.schema) return;
		this.busy = 'reading';
		this.error = null;
		this.result = null;
		try {
			await this.loadSheets(await readImportFile(file), file.name);
		} catch (err) {
			this.error = messageOf(err, 'No se pudo leer el archivo');
		} finally {
			this.busy = null;
		}
	}

	/**
	 * Las hojas de un libro: la tabla está en la que más columnas del formato
	 * reconoce (un libro puede traer antes una hoja de instrucciones).
	 */
	async loadSheets(sheets: FileSheet[], name = 'Pegado'): Promise<void> {
		const schema = this.schema!;
		const found = sheets
			.map((s) => ({ sheet: s, table: locateTable(s.cells, schema) }))
			.filter((f): f is { sheet: FileSheet; table: NonNullable<ReturnType<typeof locateTable>> } => f.table !== null)
			.sort((a, b) => Object.keys(b.table.columns).length - Object.keys(a.table.columns).length)[0];
		if (!found) throw new Error(`No se encontró la tabla: el archivo no trae los encabezados de «${schema.label}»`);
		await this.loadCells(found.sheet.cells, sheets.length > 1 ? `${name} · hoja «${found.sheet.name}»` : name);
	}

	/** Como `loadFile`, con las celdas de una hoja ya leídas (una tabla pegada entera, pruebas). */
	async loadCells(cells: FileCell[][], name = 'Pegado'): Promise<void> {
		const schema = this.schema!;
		const table = locateTable(cells, schema);
		if (!table) throw new Error(`No se encontró la tabla: el archivo no trae los encabezados de «${schema.label}»`);
		const columns = this.fileColumns;
		const labels = new Map<string, string>();
		const resolved = await this.#resolveLookups(table.rows.map((r) => r.values), columns, labels);
		const ctx: CellTypeContext = { labelCache: labels, requestRepaint: () => {}, rowAt: () => undefined };
		const rows = table.rows.map(({ values }) => {
			const row: Record<string, unknown> = {};
			for (const column of columns) {
				if (!(column.field in table.columns)) {
					// El archivo no la trae: su valor por omisión, el mismo que usaría el servidor.
					const def = typeof column.defaultValue === 'function' ? column.defaultValue() : column.defaultValue;
					if (def !== undefined && def !== null) row[column.field] = def;
					continue;
				}
				const raw = values[column.field] as FileCell;
				// Un texto que el servidor resolvió a un solo registro (por nombre o por otra clave, `resolveBy`).
				const hit = column.type === 'lookup' && raw !== null ? resolved.get(column.field)?.get(String(raw).trim()) : undefined;
				row[column.field] = hit ?? coerce(raw, column, labels, ctx);
			}
			return row;
		});
		const checksum: Record<string, number> = {};
		if (table.footer) {
			for (const field of schema.footer?.checksum ?? []) {
				const column = columns.find((c) => c.field === field);
				const n = column ? coerce(table.footer.values[field] as FileCell, { ...column, type: 'number' }, labels, ctx) : null;
				if (typeof n === 'number') checksum[field] = n;
			}
		}
		this.present = Object.keys(table.columns).filter((f) => schema.columns[f]?.from === 'either');
		this.inFile = Object.keys(table.columns);
		this.file = {
			name,
			headerRow: table.headerRow,
			rows: rows.length,
			missing: table.missing.map((f) => schema.columns[f]?.label ?? f),
			ignored: table.ignored
		};
		this.checksum = Object.keys(checksum).length ? checksum : null;
		this.#buildForm();
		this.#buildSheet(rows, labels);
	}

	/**
	 * Los textos de cada `lookup`, contra el servidor, de una vez por columna
	 * (como al pegar). Devuelve, por columna, el texto → id de los que dieron un
	 * solo registro; los nombres quedan en `labels` para pintarlos.
	 */
	async #resolveLookups(rows: Record<string, unknown>[], columns: ColumnDef[], labels: Map<string, string>): Promise<Map<string, Map<string, string>>> {
		const out = new Map<string, Map<string, string>>();
		for (const column of columns) {
			if (column.type !== 'lookup' || !column.lookup?.resolve) continue;
			const texts = [...new Set(rows.map((r) => r[column.field]).filter((v) => v !== null && v !== undefined && String(v).trim() !== '').map((v) => String(v).trim()))];
			const byText = new Map<string, string>();
			for (let i = 0; i < texts.length; i += 500) {
				const matches = await column.lookup.resolve(texts.slice(i, i + 500));
				for (const [text, found] of Object.entries(matches)) {
					for (const row of found) labels.set(lookupKey(column.field, row[column.lookup.value]), String(row[column.lookup.display] ?? ''));
					if (found.length === 1) byText.set(text, String(found[0]![column.lookup.value]));
				}
			}
			out.set(column.field, byText);
		}
		return out;
	}

	/** Vacía la vista previa y olvida el archivo. */
	clear(): void {
		if (!this.schema) return;
		this.file = null;
		this.checksum = null;
		this.present = [];
		this.inFile = [];
		this.result = null;
		this.#buildForm();
		this.#buildSheet(Array.from({ length: this.options.blankRows ?? 20 }, () => ({})));
	}

	// -- revisar y aplicar ------------------------------------------------------------------------

	/** Las filas con algo escrito, como valores simples, y su clave en la hoja. */
	#rows(): { keys: string[]; rows: Record<string, CellValue>[] } {
		const grid = this.sheet?.grid;
		if (!grid) return { keys: [], rows: [] };
		const columns = this.fileColumns;
		const keys: string[] = [];
		const rows: Record<string, CellValue>[] = [];
		for (const r of grid.rows) {
			const values: Record<string, CellValue> = {};
			for (const c of columns) {
				const v = (r[c.field] ?? null) as CellValue;
				values[c.field] = typeof v === 'string' && v.trim() === '' ? null : v;
			}
			if (Object.values(values).every((v) => v === null)) continue;
			keys.push(r.__key);
			rows.push(values);
		}
		return { keys, rows };
	}

	get rowCount(): number {
		this.sheet?.grid?.version;
		return this.#rows().rows.length;
	}

	async review(): Promise<ImportResult | null> {
		return this.#send('review');
	}

	/** Aplica. `force`: pese a lo que el servidor frenó y se puede forzar. */
	async apply(force = false): Promise<ImportResult | null> {
		return this.#send('apply', force);
	}

	async #send(action: 'review' | 'apply', force = false): Promise<ImportResult | null> {
		if (!this.schema) return null;
		this.busy = action;
		this.error = null;
		try {
			const { keys, rows } = this.#rows();
			this.#submitted = keys;
			const fields: Record<string, CellValue> = {};
			for (const f of this.formFields) fields[f] = this.form?.values[f] ?? null;
			const result = await this.request<ImportResult>(`/${encodeURIComponent(this.schema.id)}/${action}`, {
				method: 'POST',
				body: JSON.stringify({ rows, fields, fileName: this.file?.name ?? null, checksum: this.checksum, force })
			});
			this.result = result;
			this.#paintIssues(result);
			return result;
		} catch (err) {
			this.error = messageOf(err, action === 'review' ? 'No se pudo revisar' : 'No se pudo aplicar');
			return null;
		} finally {
			this.busy = null;
		}
	}

	/** Lo del servidor, en la hoja (por fila y columna) y en el formulario (los datos del formulario). */
	#paintIssues(result: ImportResult): void {
		const onRows = result.issues
			.filter((i) => i.row !== null && i.level !== 'info' && this.#submitted[i.row] !== undefined)
			.map((i) => ({ rowKey: this.#submitted[i.row!]!, field: i.field ?? null, message: i.message }));
		this.sheet?.grid?.setExternalErrors(onRows);
		for (const f of this.formFields) {
			const issue = result.issues.find((i) => i.row === null && i.field === f && i.level === 'error');
			this.form?.setServerError(f, issue ? issue.message : null);
		}
	}

	/** Problemas de toda la carga (no de una fila ni de un dato del formulario). */
	get generalIssues() {
		return (this.result?.issues ?? []).filter((i) => i.row === null && (!i.field || !this.formFields.includes(i.field)));
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const doFetch = this.options.fetch ?? ((input: RequestInfo | URL, i?: RequestInit) => fetch(input, i));
		const res = await doFetch(`${this.url.replace(/\/+$/, '')}${path}`, {
			...init,
			headers: { 'content-type': 'application/json', ...this.options.headers?.(), ...init.headers }
		});
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			const error = body?.error ?? {};
			throw new SpreadBaseApiError(res.status, error.code ?? 'http_error', error.message ?? `HTTP ${res.status}`, error.details);
		}
		return body as T;
	}
}

/** Un valor del archivo, con el tipo de su columna (como al pegar). Las fechas de Excel son días UTC. */
function coerce(raw: FileCell, column: ColumnDef, labels: Map<string, string>, ctx: CellTypeContext): CellValue {
	if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
	const type = getCellType(column.type);
	if (raw instanceof Date) {
		const iso = raw.toISOString();
		const day = iso.slice(0, 10);
		if (column.type === 'datetime') return `${day} ${iso.slice(11, 16)}`;
		if (column.type === 'date') return day;
		return type.parse(day, column);
	}
	if (column.type === 'lookup') {
		const text = String(raw).trim();
		return resolveLookupText(text, column, labels) ?? text;
	}
	if (column.type === 'number' && typeof raw === 'number') return type.parse(raw, column);
	if (column.type === 'text' && typeof raw === 'number') return String(raw);
	const text = typeof raw === 'string' ? raw.trim() : String(raw);
	return type.fromClipboard ? type.fromClipboard(text, column, ctx) : type.parse(typeof raw === 'boolean' ? raw : text, column);
}

function messageOf(err: unknown, fallback: string): string {
	return err instanceof Error && err.message ? err.message : fallback;
}

