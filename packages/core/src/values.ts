/**
 * Un archivo guardado en una celda (`FILE`, y cada elemento de `FOLDER`; SB-38):
 * su URL (la de `FileStorage.save`, SB-30), el nombre que se muestra, el tipo
 * real y el tamaño en bytes.
 */
export interface FileRef {
	url: string;
	/** Display name (clean file name). */
	name: string;
	/** Real MIME type (`image/png`), or `''` if unknown. */
	type: string;
	/** Size in bytes, or `0` if unknown. */
	size: number;
}

/**
 * The Spanish shape of `FileRef` written up to 0.1.3.
 *
 * @deprecated Still **read** everywhere (cells, `fileRefsOf`, validation,
 * comparisons) so stored values keep working, but never written: new values
 * are always `{ url, name, type, size }`. Removed in the next major version.
 */
export interface LegacyFileRef {
	url: string;
	nombre: string;
	tipo: string;
	tamano: number;
}

/**
 * Valor de una celda tal como viaja por el protocolo. Los archivos (`FILE`,
 * `FOLDER`, SB-38) viajan como `FileRef` o lista de `FileRef`.
 */
export type CellValue = string | number | boolean | null | FileRef | FileRef[] | string[];

export const isBlank = (v: unknown): boolean => v === null || v === undefined || v === '';

/**
 * Igualdad de valores de celda, normalizada: `null` y ausente son lo mismo, y
 * `1500` y `"1500.00"` también. Comparar el texto crudo daría conflictos falsos
 * por formato.
 */
export function sameValue(a: unknown, b: unknown): boolean {
	if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
	// Archivos (SB-38): por contenido, sin importar el orden de las claves.
	// La forma obsoleta y la actual del mismo archivo son el mismo valor.
	if (typeof a === 'object' || typeof b === 'object') return canonicalJson(normalizeFileValue(a)) === canonicalJson(normalizeFileValue(b));
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

/**
 * ¿Es un archivo guardado en una celda? Acepta la forma actual
 * (`{ url, name, type, size }`) y la obsoleta (`{ url, nombre, tipo, tamano }`,
 * `LegacyFileRef`): para leer sus campos, `normalizeFileRef`.
 */
export function isFileRef(v: unknown): v is FileRef | LegacyFileRef {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as FileRef).url === 'string';
}

/**
 * Un archivo en la forma actual. Lee también la obsoleta (`LegacyFileRef`) y
 * completa lo que falte: sin nombre, el último tramo de la URL.
 */
export function normalizeFileRef(v: FileRef | LegacyFileRef): FileRef {
	const r = v as Partial<FileRef> & Partial<LegacyFileRef> & { url: string };
	const name = r.name ?? r.nombre;
	return {
		url: r.url,
		name: typeof name === 'string' && name ? name : fileNameOf(r.url),
		type: String(r.type ?? r.tipo ?? ''),
		size: Number(r.size ?? r.tamano) || 0
	};
}

/**
 * El nombre visible de un archivo: el último tramo de su URL, sin la consulta
 * (`/uploads/docs/8f3k2a/contrato.pdf` → `contrato.pdf`).
 */
export function fileNameOf(url: string): string {
	const path = url.split(/[?#]/)[0] ?? '';
	const last = path.slice(path.lastIndexOf('/') + 1);
	try {
		return decodeURIComponent(last) || url;
	} catch {
		return last || url;
	}
}

/**
 * Un valor de celda con sus archivos en la forma actual (los demás valores,
 * tal cual): para comparar sin conflictos falsos entre la forma vieja y la
 * nueva del mismo archivo.
 */
export function normalizeFileValue(v: unknown): unknown {
	if (Array.isArray(v)) return v.map((x) => (isFileRef(x) ? normalizeFileRef(x) : x));
	return isFileRef(v) ? normalizeFileRef(v) : v;
}
