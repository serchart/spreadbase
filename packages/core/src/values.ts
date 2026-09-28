/** Valor de una celda tal como viaja por el protocolo. */
export type CellValue = string | number | boolean | null;

export const isBlank = (v: unknown): boolean => v === null || v === undefined || v === '';

/**
 * Igualdad de valores de celda, normalizada: `null` y ausente son lo mismo, y
 * `1500` y `"1500.00"` también. Comparar el texto crudo daría conflictos falsos
 * por formato.
 */
export function sameValue(a: unknown, b: unknown): boolean {
	if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
	if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
	return String(a) === String(b);
}

/** Minúsculas y sin acentos: «grúas» encuentra «Grúas» y «gruas». */
export const fold = (s: string): string =>
	s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
