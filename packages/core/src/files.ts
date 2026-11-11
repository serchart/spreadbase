/**
 * Leer archivos tabulares (SB-34, SB-36): Excel (.xlsx) o texto separado (CSV,
 * TSV, lo pegado de una hoja de cálculo). Cada hoja sale como filas de celdas
 * (un CSV es una sola); encontrar la tabla —y en qué hoja está— es de
 * `locateTable`.
 *
 * Vive en core porque lo usan los dos lados: el cliente al soltar un archivo
 * en la vista previa y el servidor al extraer archivos para el asistente de
 * importación. core no depende de `exceljs`: quien lee un Excel lo carga
 * (diferido, pesa) y lo pasa a `readXlsx`.
 */

/** Una celda ya resuelta: su valor, no la fórmula ni el formato. */
export type FileCell = string | number | boolean | Date | null;

export interface FileSheet {
	name: string;
	cells: FileCell[][];
}

/** Lo que `readXlsx` usa de `exceljs` (`(await import('exceljs')).default`). */
export interface ExcelJSLike {
	Workbook: new () => {
		xlsx: { load(buffer: any): Promise<unknown> };
		worksheets: {
			name: string;
			eachRow(
				options: { includeEmpty: boolean },
				fn: (row: { eachCell(options: { includeEmpty: boolean }, fn: (cell: { value: unknown }, col: number) => void): void }, n: number) => void
			): void;
		}[];
	};
}

/** Las hojas de un libro .xlsx, con `exceljs` ya cargado. */
export async function readXlsx(ExcelJS: ExcelJSLike, buffer: ArrayBuffer | Uint8Array): Promise<FileSheet[]> {
	const workbook = new ExcelJS.Workbook();
	try {
		await workbook.xlsx.load(buffer);
	} catch {
		throw new Error('No se pudo leer el archivo: debe ser un Excel .xlsx');
	}
	if (!workbook.worksheets.length) throw new Error('El archivo no tiene hojas');
	return workbook.worksheets.map((ws) => {
		const rows: FileCell[][] = [];
		ws.eachRow({ includeEmpty: true }, (row, n) => {
			const cells: FileCell[] = [];
			row.eachCell({ includeEmpty: true }, (cell, col) => {
				cells[col - 1] = resolveCell(cell.value);
			});
			rows[n - 1] = cells;
		});
		return { name: ws.name, cells: Array.from(rows, (r) => r ?? []) };
	});
}

function resolveCell(value: unknown): FileCell {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value === 'object') {
		const v = value as Record<string, unknown>;
		if ('error' in v) return null; // #REF!, #N/A…
		if ('result' in v) return resolveCell(v.result);
		if (Array.isArray(v.richText)) return (v.richText as { text: string }[]).map((t) => t.text).join('');
		if ('text' in v) return String(v.text);
	}
	return null;
}

/**
 * CSV, TSV o lo pegado de una hoja de cálculo: detecta el separador (tabulador,
 * punto y coma o coma) por la primera línea y respeta las comillas.
 */
export function parseDelimited(text: string): FileCell[][] {
	const clean = text.replace(/^﻿/, '');
	const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
	const counts = [
		['\t', firstLine.split('\t').length],
		[';', firstLine.split(';').length],
		[',', firstLine.split(',').length]
	] as const;
	const sep = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
	const rows: FileCell[][] = [];
	let row: FileCell[] = [];
	let cell = '';
	let quoted = false;
	for (let i = 0; i < clean.length; i++) {
		const ch = clean[i]!;
		if (quoted) {
			if (ch === '"' && clean[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cell += ch;
		} else if (ch === '"' && cell === '') quoted = true;
		else if (ch === sep) {
			row.push(cell);
			cell = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && clean[i + 1] === '\n') i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
		} else cell += ch;
	}
	if (cell !== '' || row.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows.map((r) => r.map((c) => (c === '' ? null : c)));
}
