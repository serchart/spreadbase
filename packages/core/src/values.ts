/**
 * Un archivo guardado en una celda (`FILE`, y cada elemento de `FOLDER`; SB-38):
 * su URL (la de `FileStorage.save`, SB-30), el nombre que se muestra, el tipo
 * real y el tamaño en bytes.
 */
export interface FileRef {
	url: string;
	nombre: string;
	tipo: string;
	tamano: number;
}

/**
 * Valor de una celda tal como viaja por el protocolo. Los archivos (`FILE`,
 * `FOLDER`, SB-38) viajan como `FileRef` o lista de `FileRef`.
 */
export type CellValue = string | number | boolean | null | FileRef | FileRef[];

export const isBlank = (v: unknown): boolean => v === null || v === undefined || v === '';

/**
 * Igualdad de valores de celda, normalizada: `null` y ausente son lo mismo, y
 * `1500` y `"1500.00"` también. Comparar el texto crudo daría conflictos falsos
 * por formato.
 */
export function sameValue(a: unknown, b: unknown): boolean {
	if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
	// Archivos (SB-38): por contenido, sin importar el orden de las claves.
	if (typeof a === 'object' || typeof b === 'object') return canonicalJson(a) === canonicalJson(b);
	if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
	return String(a) === String(b);
}

/** Minúsculas y sin acentos: «grúas» encuentra «Grúas» y «gruas». */
export const fold = (s: string): string =>
	s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** JSON con las claves ordenadas: dos objetos iguales dan el mismo texto. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) : v
	);
}

/** ¿Es un archivo guardado en una celda (`{ url, nombre, … }`)? */
export function isFileRef(v: unknown): v is FileRef {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as FileRef).url === 'string';
}
