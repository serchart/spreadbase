/**
 * Importar a una hoja (SB-34): un **formato** declara columnas como una hoja
 * (mismos tipos y reglas) pero sin tabla detrás. El cliente lee el archivo
 * (Excel, CSV, lo pegado), lo muestra en una hoja local que se puede corregir y
 * manda las filas; el servidor las valida con las mismas reglas y las entrega a
 * `review` (qué haría) y `apply` (hacerlo) de la app.
 */
import type { ColumnSpec, SchemaColumn } from './schema.ts';
import type { CellValue } from './values.ts';
import { fold } from './values.ts';

/**
 * De dónde sale un dato: de una columna del archivo, del formulario (un valor
 * para todas las filas) o de cualquiera de los dos (si el archivo trae la
 * columna, manda el archivo; si no, se pide una vez).
 */
export type ImportFrom = 'file' | 'form' | 'either';

export interface ImportColumnSpec extends ColumnSpec {
	/** Otros encabezados con que puede venir en el archivo («Razón Social» = «Nombre fiscal»). */
	aliases?: string[];
	/** Default: `file`. */
	from?: ImportFrom;
}

export type ImportSchemaColumn = SchemaColumn & { aliases?: string[]; from: ImportFrom };

/** Lo que viaja en `GET /:format/schema`. */
export interface ImportSchema {
	id: string;
	label: string;
	description?: string;
	/** La llave de cada fila (crear o actualizar). No se repite en un mismo archivo. */
	key?: string;
	columns: Record<string, ImportSchemaColumn>;
	/** Encabezados que identifican la fila de títulos. Default: las columnas obligatorias del archivo. */
	header?: { find?: string[] };
	/** El pie del archivo trae las sumas de estas columnas: la suma de control. */
	footer?: { checksum?: string[] };
}

/** Un problema o aviso. `row` es la posición en `rows` (0 = la primera); `null`, de toda la carga. */
export interface ImportIssue {
	row: number | null;
	field?: string;
	level: 'error' | 'warning' | 'info';
	message: string;
}

/** Lo que manda el cliente a `review` y `apply`. */
export interface ImportPayload {
	rows: Record<string, CellValue>[];
	/** Los datos `form` (y los `either` que el archivo no trae). */
	fields: Record<string, CellValue>;
	fileName?: string | null;
	/** Las sumas del pie del archivo, para comprobar que no se perdió ni sobró nada. */
	checksum?: Record<string, number> | null;
	/** Aplicar aunque la app lo frene con algo que se puede forzar (el guardarraíl de un corte). */
	force?: boolean;
}

export interface ImportResult {
	/** Sin errores: se puede aplicar (o se aplicó). */
	ok: boolean;
	applied: boolean;
	/** Lo que la app quiera contar: cuántos se crean, se actualizan… */
	summary: Record<string, unknown>;
	issues: ImportIssue[];
	/** La app lo frena por algo de toda la carga; con `forceable`, una persona puede aplicarlo igual. */
	blocked?: { reasons: string[]; forceable: boolean } | null;
}

/** Encabezado comparable: sin acentos, minúsculas, sin espacios de más ni `:`/`*` finales. */
export const normalizeHeader = (s: unknown): string =>
	fold(String(s ?? ''))
		.replace(/\s+/g, ' ')
		.replace(/[\s:*]+$/, '')
		.trim();

/** Las columnas que se leen del archivo (`file` y `either`). */
export const fileFields = (schema: ImportSchema): string[] =>
	Object.entries(schema.columns)
		.filter(([, c]) => c.from !== 'form')
		.map(([f]) => f);

export interface LocatedTable {
	/** Fila del encabezado (1 = la primera del archivo). */
	headerRow: number;
	/** Por campo, en qué columna del archivo está (0 = la primera). */
	columns: Record<string, number>;
	/** Columnas obligatorias del archivo que no aparecen. */
	missing: string[];
	/** Encabezados del archivo que no son de ninguna columna (se ignoran). */
	ignored: string[];
	rows: { sourceRow: number; values: Record<string, unknown> }[];
	/** La fila de totales del pie, si el formato la espera y aparece. */
	footer: { sourceRow: number; values: Record<string, unknown> } | null;
}

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * Encuentra la tabla dentro de una hoja: la fila del encabezado (en las
 * primeras 30, la que trae `header.find` o la que más columnas reconoce), qué
 * columna es cada campo (por etiqueta o alias), las filas de datos y el pie con
 * las sumas. Pura: la usan el cliente al soltar un archivo y las pruebas.
 */
export function locateTable(cells: unknown[][], schema: ImportSchema): LocatedTable | null {
	const fields = fileFields(schema);
	const names = new Map<string, string>();
	for (const field of fields) {
		const column = schema.columns[field]!;
		for (const label of [column.label, ...(column.aliases ?? []), field]) {
			const key = normalizeHeader(label);
			if (key && !names.has(key)) names.set(key, field);
		}
	}
	const required = fields.filter((f) => schema.columns[f]!.required && schema.columns[f]!.from === 'file');
	const find = (schema.header?.find ?? []).map(normalizeHeader);

	let best: { index: number; columns: Record<string, number>; ignored: string[] } | null = null;
	for (let i = 0; i < Math.min(cells.length, 30); i++) {
		const row = cells[i] ?? [];
		const columns: Record<string, number> = {};
		const ignored: string[] = [];
		row.forEach((cell, j) => {
			const key = normalizeHeader(cell);
			if (!key) return;
			const field = names.get(key);
			if (field && columns[field] === undefined) columns[field] = j;
			else ignored.push(String(cell).trim());
		});
		const headers = new Set(row.map(normalizeHeader));
		// Con `header.find`, esos encabezados; si no, la fila que más columnas reconoce (al menos dos, o la única que hay).
		if (find.length && !find.every((f) => headers.has(f))) continue;
		const matched = Object.keys(columns).length;
		if (matched < Math.min(2, fields.length)) continue;
		if (!best || matched > Object.keys(best.columns).length) best = { index: i, columns, ignored };
		if (find.length || matched === fields.length) break;
	}
	if (!best) return null;

	const checksum = schema.footer?.checksum ?? [];
	const rows: LocatedTable['rows'] = [];
	let footer: LocatedTable['footer'] = null;
	for (let i = best.index + 1; i < cells.length; i++) {
		const row = cells[i] ?? [];
		const values: Record<string, unknown> = {};
		for (const [field, j] of Object.entries(best.columns)) values[field] = row[j] ?? null;
		if (Object.values(values).every(isEmpty)) continue;
		// El pie: trae sumas y ninguna de las columnas obligatorias (una factura siempre las trae). Un
		// cero en otra columna («Cancelado» = 0) no lo vuelve fila. Sin obligatorias, nada más que sumas.
		if (checksum.length) {
			const identifying = required.filter((f) => !checksum.includes(f) && f in values);
			const others = identifying.length ? identifying : Object.keys(values).filter((f) => !checksum.includes(f));
			if (others.every((f) => isEmpty(values[f])) && checksum.some((f) => !isEmpty(values[f]))) {
				footer = { sourceRow: i + 1, values };
				break;
			}
		}
		rows.push({ sourceRow: i + 1, values });
	}
	return {
		headerRow: best.index + 1,
		columns: best.columns,
		missing: required.filter((f) => best!.columns[f] === undefined),
		ignored: best.ignored,
		rows,
		footer
	};
}
