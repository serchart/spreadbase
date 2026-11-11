/**
 * De un bloque extraído (encabezados y celdas de texto) a filas de un formato
 * SB-34 (SB-36). Lo hace con reglas —como la vista previa de SB-34: la tabla
 * con `locateTable` y cada valor con el tipo de su columna— y el agente lo usa
 * como tool (`mapearTabla`), corrigiendo lo que haga falta.
 */
import { fold, locateTable, normalizeHeader } from '@spreadbase/core';
import type { CellValue, ImportSchema, ImportSchemaColumn } from '@spreadbase/core';
import type { BloqueExtraido } from '../extraction/types.ts';

const BLANKS = new Set(['', '-', '—', '–', 'n/a', 'na', 's/d']);

/**
 * Un importe o número como se escribe en un documento: `$319,100`,
 * `($60,000)` (negativo), `16.09%`, `1.234,56`. `null` si no es número.
 */
export function parseNumber(text: string): number | null {
	let s = text.trim().replace(/\s/g, '');
	if (BLANKS.has(s.toLowerCase())) return null;
	let negative = false;
	if (/^\(.*\)$/.test(s)) {
		negative = true;
		s = s.slice(1, -1);
	}
	s = s.replace(/^[-−]/, () => {
		negative = !negative;
		return '';
	});
	s = s.replace(/[$€£%]|MXN|USD/gi, '');
	const lastDot = s.lastIndexOf('.');
	const lastComma = s.lastIndexOf(',');
	if (lastDot >= 0 && lastComma >= 0) {
		// El último separador es el decimal.
		s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
	} else if (lastComma >= 0) {
		// Solo comas: de miles si van de tres en tres; si no, decimal.
		s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
	}
	if (!/^\d*\.?\d+$/.test(s)) return null;
	const n = Number(s);
	return negative ? -n : n;
}

/** `AAAA-MM-DD` desde `AAAA-MM-DD`, `DD/MM/AAAA` o `DD-MM-AAAA`. */
export function parseDate(text: string): string | null {
	const s = text.trim();
	let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
	if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
	m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
	if (m) {
		const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
		return `${year}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
	}
	return null;
}

/**
 * Un texto leído, con el tipo de su columna. Lo que no se pueda interpretar se
 * deja como texto: `review` lo marca, y el agente o la persona lo corrigen.
 */
export function coerceCell(raw: unknown, column: Pick<ImportSchemaColumn, 'type' | 'options'>): CellValue {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'number' || typeof raw === 'boolean') return column.type === 'text' ? String(raw) : raw;
	const text = String(raw).trim();
	if (text === '') return null;
	switch (column.type) {
		case 'number': {
			const n = parseNumber(text);
			return n ?? (BLANKS.has(text.toLowerCase()) ? null : text);
		}
		case 'date':
			return parseDate(text) ?? text;
		case 'datetime': {
			const day = parseDate(text);
			const time = /(\d{1,2}):(\d{2})/.exec(text);
			return day ? `${day} ${time ? `${time[1]!.padStart(2, '0')}:${time[2]}` : '00:00'}` : text;
		}
		case 'boolean': {
			const f = fold(text);
			if (['si', 'sí', 'true', '1', 'x', '✓', '✔', 'verdadero', 'yes'].includes(f)) return true;
			if (['no', 'false', '0', 'falso', '✗', '-'].includes(f)) return false;
			return text;
		}
		case 'select': {
			const found = column.options?.find((o) => fold(o.value) === fold(text) || fold(o.label) === fold(text));
			return found ? found.value : text;
		}
		default:
			return text;
	}
}

export interface MapeoOpciones {
	/** Por campo, de qué columna del bloque sale: su encabezado o su índice (0 = la primera). Pisa lo que encuentre por nombre. */
	columnas?: Record<string, string | number>;
	/** Por campo, un valor para todas las filas (lo que el documento dice una vez: la vigencia, el modelo del título). */
	fijos?: Record<string, CellValue>;
}

export interface Mapeo {
	filas: Record<string, CellValue>[];
	/** Campo → columna del bloque de donde salió. */
	columnas: Record<string, string>;
	/** Campos del archivo que no se encontraron. */
	faltan: string[];
	/** Encabezados del bloque que no son de ningún campo. */
	ignoradas: string[];
}

/**
 * Las filas de uno o varios bloques (con los mismos encabezados: una tabla
 * partida en varias páginas) en las columnas de un formato.
 */
export function mapearBloques(bloques: BloqueExtraido[], schema: ImportSchema, opciones: MapeoOpciones = {}): Mapeo {
	const fileFields = Object.entries(schema.columns).filter(([, c]) => c.from !== 'form');
	const filas: Record<string, CellValue>[] = [];
	let columnas: Record<string, string> = {};
	let faltan: string[] = [];
	let ignoradas: string[] = [];
	for (const bloque of bloques) {
		const encabezados = bloque.encabezados ?? [];
		const cells = [encabezados, ...(bloque.filas ?? [])];
		const located = encabezados.length ? locateTable(cells, schema) : null;
		const index: Record<string, number> = { ...(located?.headerRow === 1 ? located.columns : {}) };
		for (const [field, ref] of Object.entries(opciones.columnas ?? {})) {
			const i = typeof ref === 'number' ? ref : encabezados.findIndex((h) => normalizeHeader(h) === normalizeHeader(ref));
			if (i >= 0) index[field] = i;
		}
		columnas = Object.fromEntries(Object.entries(index).map(([f, i]) => [f, encabezados[i] || `#${i + 1}`]));
		faltan = fileFields.map(([f]) => f).filter((f) => index[f] === undefined && !(f in (opciones.fijos ?? {})));
		const used = new Set(Object.values(index));
		ignoradas = encabezados.filter((h, i) => h && !used.has(i));
		for (const raw of bloque.filas ?? []) {
			if (raw.every((c) => !c || !c.trim())) continue;
			const row: Record<string, CellValue> = {};
			for (const [field, column] of fileFields) {
				if (field in (opciones.fijos ?? {})) row[field] = coerceCell(opciones.fijos![field], column);
				else row[field] = index[field] === undefined ? null : coerceCell(raw[index[field]!], column);
			}
			filas.push(row);
		}
	}
	return { filas, columnas, faltan, ignoradas };
}

/** Cuántas columnas del formato reconoce un bloque: para elegir la tabla y el formato sin LLM. */
export function puntaje(bloque: BloqueExtraido, schema: ImportSchema): number {
	if (bloque.tipo !== 'tabla' || !bloque.encabezados?.length) return 0;
	const located = locateTable([bloque.encabezados, ...(bloque.filas ?? []).slice(0, 5)], schema);
	return located?.headerRow === 1 ? Object.keys(located.columns).length : 0;
}
