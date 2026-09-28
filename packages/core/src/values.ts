/**
 * Valores canónicos de SpreadBase. Sin DOM, sin framework: el mismo código
 * corre en el navegador, en el servidor y en las pruebas.
 *
 * **La regla de valores:** todo valor viaja normalizado. Un número es un
 * número, una fecha es `'YYYY-MM-DD'` y el vacío es `null`. Parsear al entrar,
 * nunca a la mitad.
 */

export type CellValue = string | number | boolean | null;

export const isBlank = (v: unknown): boolean => v === null || v === undefined || v === '';

/**
 * Igualdad normalizada: es la que decide si una celda difiere de su original y
 * la que usa el servidor para comparar el `from` de la concurrencia. Comparar
 * texto crudo daría choques falsos por formato.
 */
export function sameValue(a: unknown, b: unknown): boolean {
	if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
	if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
	return String(a) === String(b);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Acepta 'YYYY-MM-DD', 'DD/MM/YYYY', ISO o Date. Devuelve 'YYYY-MM-DD' o null. */
export function toCanonicalDate(raw: unknown): string | null {
	if (isBlank(raw)) return null;
	if (raw instanceof Date && !isNaN(raw.getTime())) {
		return `${raw.getFullYear()}-${pad(raw.getMonth() + 1)}-${pad(raw.getDate())}`;
	}
	const s = String(raw).trim();

	let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (m) return `${m[1]}-${m[2]}-${m[3]}`;

	// Formato local DD/MM/YYYY: primer grupo es día, segundo es mes.
	m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;

	const d = new Date(s);
	if (!isNaN(d.getTime())) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	return null;
}

/** Devuelve 'YYYY-MM-DD HH:mm' o null. */
export function toCanonicalDateTime(raw: unknown): string | null {
	if (isBlank(raw)) return null;
	const datePart = toCanonicalDate(raw);
	if (!datePart) return null;
	const s = raw instanceof Date ? raw.toISOString() : String(raw);
	const m = s.match(/(\d{1,2}):(\d{2})/);
	const hh = m ? pad(Math.min(23, +m[1])) : '00';
	const mm = m ? pad(Math.min(59, +m[2])) : '00';
	return `${datePart} ${hh}:${mm}`;
}

/** Acepta 1500, "1500", "1,500.00", "$1,500" y -12.5. Devuelve number o null. */
export function toCanonicalNumber(raw: unknown): number | null {
	if (isBlank(raw)) return null;
	if (typeof raw === 'number') return isNaN(raw) ? null : raw;
	const cleaned = String(raw)
		.replace(/[^\d.,\-]/g, '')
		.replace(/,/g, '');
	if (cleaned === '' || cleaned === '-') return null;
	const n = Number(cleaned);
	return isNaN(n) ? null : n;
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY'. */
export function formatDateDisplay(canonical: CellValue): string {
	if (isBlank(canonical)) return '';
	const m = String(canonical).match(/^(\d{4})-(\d{2})-(\d{2})/);
	return m ? `${m[3]}/${m[2]}/${m[1]}` : String(canonical);
}

export function formatDateTimeDisplay(canonical: CellValue): string {
	if (isBlank(canonical)) return '';
	const s = String(canonical);
	const time = s.match(/(\d{2}):(\d{2})/);
	return `${formatDateDisplay(s)}${time ? ` ${time[1]}:${time[2]}` : ''}`;
}

export function formatNumberDisplay(
	value: CellValue,
	column: { precision?: number; thousands?: boolean; prefix?: string; suffix?: string }
): string {
	if (isBlank(value)) return '';
	const n = Number(value);
	if (isNaN(n)) return String(value);
	const precision = column.precision ?? 0;
	const body =
		column.thousands === false
			? n.toFixed(precision)
			: n.toLocaleString('es-MX', { minimumFractionDigits: precision, maximumFractionDigits: precision });
	return `${column.prefix ?? ''}${body}${column.suffix ?? ''}`;
}

/** Minúsculas y sin acentos: «organico» encuentra «Orgánico». */
export function normalizeForSearch(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/gu, '');
}
