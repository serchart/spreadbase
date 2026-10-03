/**
 * Leer un archivo en el navegador para importarlo (SB-34): Excel (.xlsx) o
 * texto separado (CSV, TSV). Devuelve cada hoja como filas de celdas (un CSV es
 * una sola); encontrar la tabla —y en qué hoja está— es de `locateTable` (core).
 *
 * `exceljs` pesa: se carga solo la primera vez que alguien suelta un Excel.
 */

/** Una celda ya resuelta: su valor, no la fórmula ni el formato. */
export type FileCell = string | number | boolean | Date | null;

export interface FileSheet {
	name: string;
	cells: FileCell[][];
}

export async function readImportFile(file: File): Promise<FileSheet[]> {
	const name = file.name.toLowerCase();
	if (name.endsWith('.xlsx') || file.type.includes('spreadsheetml')) return readXlsx(await file.arrayBuffer());
	if (name.endsWith('.xls')) throw new Error('El formato .xls (Excel 97) no se lee: guárdalo como .xlsx');
	return [{ name: file.name, cells: parseDelimited(await file.text()) }];
}

async function readXlsx(buffer: ArrayBuffer): Promise<FileSheet[]> {
	const { default: ExcelJS } = await import('exceljs');
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
				cells[col - 1] = resolve(cell.value);
			});
			rows[n - 1] = cells;
		});
		return { name: ws.name, cells: Array.from(rows, (r) => r ?? []) };
	});
}

function resolve(value: unknown): FileCell {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value === 'object') {
		const v = value as Record<string, unknown>;
		if ('error' in v) return null; // #REF!, #N/A…
		if ('result' in v) return resolve(v.result);
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
