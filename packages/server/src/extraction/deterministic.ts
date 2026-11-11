/**
 * Método P (SB-36): extraer un archivo a la estructura intermedia sin LLM.
 *
 * | Archivo | Cómo |
 * |---|---|
 * | PDF con capa de texto | `pdfjs-dist`, tablas por alineación (`extraerPdf`) |
 * | Excel (.xlsx) | `readXlsx` de core con `exceljs` (la misma lectura que la vista previa de SB-34): un bloque tabla por hoja |
 * | CSV / TSV | `parseDelimited` de core: un bloque tabla |
 * | Texto, Markdown, JSON | un bloque texto |
 * | Imagen (PNG, JPG…) | un bloque imagen: solo la lee el método X |
 */
import { locateTable, parseDelimited, readXlsx } from '@spreadbase/core';
import type { ExcelJSLike, FileCell, ImportSchema } from '@spreadbase/core';
import { extraerPdf } from './pdf.ts';
import type { OpcionesPdf } from './pdf.ts';
import type { BloqueExtraido, Extraccion } from './types.ts';

export interface OpcionesExtraccion extends OpcionesPdf {
	nombre: string;
	mime?: string;
	/**
	 * El formato destino (SB-34). En un Excel o CSV, el encabezado se busca con
	 * `locateTable` (donde esté, por etiqueta o alias) en lugar de tomar la
	 * primera fila con datos.
	 */
	schema?: ImportSchema;
}

const startsWith = (buffer: Uint8Array, text: string) => [...text].every((c, i) => buffer[i] === c.charCodeAt(0));

function kindOf(buffer: Uint8Array, nombre: string, mime = ''): Extraccion['archivo']['tipo'] | null {
	const ext = nombre.toLowerCase().split('.').pop() ?? '';
	if (startsWith(buffer, '%PDF') || mime === 'application/pdf' || ext === 'pdf') return 'pdf';
	if (ext === 'xlsx' || mime.includes('spreadsheetml')) return 'xlsx';
	if (ext === 'csv' || ext === 'tsv' || mime === 'text/csv' || mime === 'text/tab-separated-values') return 'csv';
	if (ext === 'json' || mime === 'application/json') return 'json';
	if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'tif', 'tiff'].includes(ext) || mime.startsWith('image/')) return 'imagen';
	if (['txt', 'md', 'markdown', 'text'].includes(ext) || mime.startsWith('text/')) return 'texto';
	return null;
}

/** Una celda como texto: las fechas de Excel son días UTC (como en SB-34). */
function cellText(value: FileCell | undefined): string {
	if (value === null || value === undefined) return '';
	if (value instanceof Date) {
		const iso = value.toISOString();
		return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
	}
	return String(value).trim();
}

/** Una hoja de celdas como bloque tabla: encabezado por `locateTable` o la primera fila con datos. */
function tableBlock(cells: FileCell[][], pagina: number, titulo: string, schema?: ImportSchema): BloqueExtraido {
	const rows = cells.map((r) => Array.from(r ?? [], cellText));
	let start = schema ? (locateTable(cells, schema)?.headerRow ?? 0) - 1 : -1;
	if (start < 0) start = rows.findIndex((r) => r.some((c) => c !== ''));
	if (start < 0) return { pagina, tipo: 'tabla', titulo, encabezados: [], filas: [], confianza: 1 };
	const width = Math.max(...rows.slice(start).map((r) => r.length));
	const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? '');
	const filas = rows
		.slice(start + 1)
		.filter((r) => r.some((c) => c !== ''))
		.map(pad);
	return { pagina, tipo: 'tabla', titulo, encabezados: pad(rows[start]!), filas, confianza: 1 };
}

/**
 * Extrae un archivo con el método P. Devuelve la estructura intermedia; con
 * `imagenes: true`, un PDF trae además cada página como PNG para el método X.
 */
export async function extraerDeterminista(buffer: Uint8Array, opciones: OpcionesExtraccion): Promise<Extraccion> {
	const { nombre, mime, schema } = opciones;
	const tipo = kindOf(buffer, nombre, mime);
	switch (tipo) {
		case 'pdf':
			return extraerPdf(buffer, nombre, opciones);
		case 'xlsx': {
			let ExcelJS: ExcelJSLike;
			try {
				ExcelJS = (await import('exceljs')).default as unknown as ExcelJSLike;
			} catch {
				throw new Error('Extraer un Excel necesita el paquete `exceljs`: npm install exceljs');
			}
			const sheets = await readXlsx(ExcelJS, buffer);
			return {
				archivo: { nombre, paginas: sheets.length, tipo },
				bloques: sheets.map((s, i) => tableBlock(s.cells, i + 1, s.name, schema))
			};
		}
		case 'csv': {
			const cells = parseDelimited(new TextDecoder().decode(buffer));
			return { archivo: { nombre, paginas: 1, tipo }, bloques: [tableBlock(cells, 1, nombre, schema)] };
		}
		case 'json':
		case 'texto': {
			let contenido = new TextDecoder().decode(buffer).replace(/^﻿/, '');
			if (tipo === 'json') {
				try {
					contenido = JSON.stringify(JSON.parse(contenido), null, 2);
				} catch {
					// JSON mal formado: va como texto, tal cual.
				}
			}
			return { archivo: { nombre, paginas: 1, tipo }, bloques: [{ pagina: 1, tipo: 'texto', contenido, confianza: 1 }] };
		}
		case 'imagen':
			return {
				archivo: { nombre, paginas: 1, tipo },
				bloques: [{ pagina: 1, tipo: 'imagen', contenido: 'Una imagen no tiene texto: la lee el método X (LLM)', confianza: 0 }]
			};
		default:
			throw new Error(`No se sabe extraer «${nombre}»${mime ? ` (${mime})` : ''}: PDF, Excel, CSV, texto, JSON o imagen`);
	}
}
