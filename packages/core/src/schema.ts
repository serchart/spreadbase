/**
 * La hoja: qué columnas tiene, de qué tipo y con qué reglas (SB-1, SB-12).
 *
 * Se escribe en el backend y viaja al front por `GET <base>/schema`. Las
 * reglas declarativas viajan y el front las aplica al editar; `validate`, que
 * es una función, solo corre en el servidor.
 */
import type { CellValue } from './values.ts';

export const types = {
	TEXT: 'text',
	NUMBER: 'number',
	SELECT: 'select',
	DATE: 'date',
	DATETIME: 'datetime',
	/** URL de una imagen (`https://…`, `/ruta`, `data:image/…`). Con `upload`, también se sube (SB-30). */
	IMAGE: 'image',
	/**
	 * Un archivo (SB-30): su URL (`https://…` o `/ruta`). La celda muestra el
	 * nombre, que es el último tramo de la URL. Con `upload`, se sube.
	 */
	FILE: 'file',
	/** Llave de un registro de otro recurso, elegido en una mini tabla (SB-21). */
	LOOKUP: 'lookup',
	/** Casilla: `true` o `false`. */
	BOOLEAN: 'boolean',
	/**
	 * Contraseña (SB-22): se escribe en claro, el servidor guarda `hash(plain)` y
	 * nunca la devuelve; al leer viaja una marca opaca (`pwd:…`) o `null`.
	 */
	PASSWORD: 'password'
} as const;

/** Prefijo de la marca con la que viaja una contraseña guardada. */
export const PASSWORD_MARK = 'pwd:';
/** ¿Es la marca de una contraseña guardada (y no una contraseña nueva)? */
export const isPasswordMark = (v: unknown): boolean => typeof v === 'string' && v.startsWith(PASSWORD_MARK);

export type ColumnType = (typeof types)[keyof typeof types];

export interface Option {
	value: string;
	label: string;
}

type MaybePromise<T> = T | Promise<T>;
type Ctx = Record<string, unknown>;

/** Una columna de la mini tabla de un `lookup`: solo se muestra. */
export interface LookupColumn {
	type: Exclude<ColumnType, 'lookup'>;
	label: string;
	width?: number;
	align?: 'left' | 'center' | 'right';
	precision?: number;
	prefix?: string;
	suffix?: string;
	thousands?: boolean;
	/** Solo `image`: `round` la pinta como avatar. */
	shape?: 'round' | 'square';
	options?: Option[];
}

/** Un tramo del recurso de un `lookup`. */
export interface LookupPage {
	rows: Record<string, unknown>[];
	total: number;
}

/**
 * De dónde salen los registros de una columna `lookup` (SB-21, `03-lookup.md`).
 * Cada fila que devuelven las funciones trae al menos `value`, `display` y los
 * campos de `columns`. `ctx` es el contexto de la petición (el usuario…).
 */
export interface LookupSpec {
	/** El campo que se guarda en la celda. Casi siempre el id. */
	value: string;
	/** El campo que se ve en la celda. */
	display: string;
	/** Las columnas de la mini tabla. Sin ellas: solo `display`, sin encabezado. */
	columns?: Record<string, LookupColumn>;
	/** Caracteres antes de buscar. Default 0: al abrir ya muestra el primer tramo. */
	minLength?: number;
	/** Búsqueda paginada, para el popover. */
	search: (q: string, page: { offset: number; limit: number }, ctx: Ctx) => MaybePromise<LookupPage>;
	/** Las filas de ids concretos: nombres de cada página y validación al guardar. */
	byIds: (ids: string[], ctx: Ctx) => MaybePromise<Record<string, unknown>[]>;
	/** Para pegar: filas cuyo `display` o `value` coincide con alguno de los textos. */
	resolve?: (texts: string[], ctx: Ctx) => MaybePromise<Record<string, unknown>[]>;
}

/** Lo que viaja de un `lookup` en el esquema: sin funciones. */
export interface LookupSchema {
	value: string;
	display: string;
	columns: Record<string, LookupColumn>;
	minLength: number;
	/** El servidor sabe resolver texto pegado (`POST /lookup/:field/resolve`). */
	resolvable: boolean;
}

/**
 * Miniatura antes del texto de la celda (SB-29): la foto de una persona, las
 * iniciales de una empresa o un ícono. Es presentación: el valor de la celda
 * (y lo que se valida, copia, busca o guarda) sigue siendo el texto o el id.
 *
 * Orden de respaldo: la imagen; si no hay o no carga, las iniciales (si
 * `initials`); si no, el ícono; si no, uno genérico (persona si es redonda,
 * edificio si es cuadrada).
 */
export interface AvatarSpec {
	/**
	 * Campo con la URL de la imagen. En una columna `lookup`, del registro
	 * elegido (el servidor lo manda con su nombre); en las demás, de la misma
	 * fila.
	 */
	image?: string;
	/** Las iniciales del texto (hasta dos), con un color estable por texto. */
	initials?: boolean;
	/** Nombre de un ícono del registro del cliente (`registerIcons`), p. ej. `building`. */
	icon?: string;
	/** Default: `round`. */
	shape?: 'round' | 'square';
}

/** Lo que recibe un destino al guardar un archivo subido (SB-30). */
export interface UploadedFile {
	bytes: Uint8Array;
	/** Tipo real, revisado por el contenido (no el que dice el navegador). */
	type: string;
	/** Nombre limpio (sin acentos ni signos) y con la extensión de su tipo. */
	name: string;
}

/**
 * Dónde se guardan los archivos subidos (SB-30): `diskStorage` (una carpeta
 * del servidor) o uno propio (un bucket) con la misma forma.
 */
export interface FileStorage {
	/** Guarda el archivo y devuelve la URL con la que se verá desde el navegador. */
	save(file: UploadedFile, ctx: Record<string, unknown>): Promise<string>;
}

/**
 * Subir archivos a una columna `image` o `file` (SB-30). La URL que devuelve
 * el destino queda en la celda y se guarda con el lote, como cualquier cambio.
 */
export interface UploadSpec {
	storage: FileStorage;
	/** Tamaño máximo: bytes o texto (`'2mb'`, `'500kb'`). Default: 5 MB. */
	maxSize?: number | string;
	/**
	 * Tipos aceptados (`image/png`, `application/pdf`…). Default: en `image`,
	 * PNG, JPEG, WebP y GIF; en `file`, además PDF y XML. SVG y HTML nunca.
	 */
	accept?: string[];
	/** ¿Puede subir quien pide? Con el contexto de la petición. Default: sí. */
	allow?: (ctx: Record<string, unknown>) => boolean | Promise<boolean>;
}

/** Lo que viaja en el esquema de una columna con `upload`. */
export interface UploadSchema {
	maxSize: number;
	accept: string[];
}

export interface ColumnSpec {
	type: ColumnType;
	label: string;

	// -- reglas: el servidor las exige al guardar y el cliente al editar
	/** El cliente no la puede editar. El `idField` siempre es de solo lectura. */
	readOnly?: boolean;
	/** Vacío no permitido. */
	required?: boolean;
	/** Texto y contraseña. En contraseña, default 8. */
	minLength?: number;
	maxLength?: number;
	/** Expresión regular, como texto para que viaje en JSON. */
	pattern?: string;
	patternMessage?: string;
	min?: number;
	max?: number;
	options?: Option[];
	/** Solo `lookup`: de dónde salen sus registros. */
	lookup?: LookupSpec;
	/** Solo `image` y `file`: se pueden subir archivos (SB-30). El destino no viaja. */
	upload?: UploadSpec;
	/**
	 * Solo `password`, y obligatoria: convierte la contraseña en claro en lo que
	 * se guarda (bcrypt, argon2, scrypt…). No viaja.
	 */
	hash?: (plain: string, ctx: Record<string, unknown>) => string | Promise<string>;
	/** Entra en la búsqueda de texto (`?search=`). Sin ninguna marcada, entran todas las de texto. */
	searchable?: boolean;
	defaultValue?: CellValue;
	/** Regla de negocio sobre la fila entera. Solo en el servidor: no viaja. */
	validate?: (value: CellValue, row: Record<string, unknown>) => string | null;

	// -- pistas visuales: el servidor las ignora, el cliente las usa
	width?: number;
	align?: 'left' | 'center' | 'right';
	precision?: number;
	prefix?: string;
	suffix?: string;
	thousands?: boolean;
	/** Solo `image`: `round` la pinta como avatar. */
	shape?: 'round' | 'square';
	/** Solo `text` y `lookup`: miniatura antes del texto (SB-29). */
	avatar?: AvatarSpec;
	/**
	 * Fuera de la vista por omisión: la fila la trae y se puede filtrar por ella
	 * (`filters: { contract_id }`), pero no se pinta. El cliente la muestra con
	 * `columns: { campo: { hidden: false } }` (SB-31).
	 */
	hidden?: boolean;
}

export type RemoteChangePolicy = 'merge' | 'strict';

export interface SheetDefinition {
	/** Identifica la hoja; el cliente lo usa como llave de su borrador local. */
	id: string;
	/** Campo que identifica cada fila. Default: `id`. */
	idField?: string;
	allowInsert?: boolean;
	allowDelete?: boolean;
	/** Cambios ajenos en campos que el lote no toca (G-15). Default: `merge`. */
	policy?: RemoteChangePolicy;
	/**
	 * Orden cuando la consulta no pide ninguno. Sin él, por id (con ids `uuid`
	 * parece aleatorio). El desempate por id se agrega siempre.
	 */
	defaultSort?: { field: string; dir: 'asc' | 'desc' };
	/** El orden de las claves es el orden de las columnas. */
	columns: Record<string, ColumnSpec>;
}

/** Lo que viaja en `GET /schema`: la definición sin funciones. */
export interface SheetSchema {
	id: string;
	idField: string;
	allowInsert: boolean;
	allowDelete: boolean;
	policy: RemoteChangePolicy;
	columns: Record<string, SchemaColumn>;
}

export type SchemaColumn = Omit<ColumnSpec, 'validate' | 'lookup' | 'hash' | 'upload'> & { lookup?: LookupSchema; upload?: UploadSchema };

export function toSchema(def: SheetDefinition): SheetSchema {
	const idField = def.idField ?? 'id';
	const columns: SheetSchema['columns'] = {};
	for (const [field, { validate: _validate, hash: _hash, lookup, upload, ...spec }] of Object.entries(def.columns)) {
		const column: SchemaColumn = field === idField ? { ...spec, readOnly: true } : { ...spec };
		if (upload) column.upload = uploadLimits(spec.type, upload);
		if (lookup) {
			column.lookup = {
				value: lookup.value,
				display: lookup.display,
				columns: lookup.columns ?? { [lookup.display]: { type: 'text', label: spec.label } },
				minLength: lookup.minLength ?? 0,
				resolvable: typeof lookup.resolve === 'function'
			};
		}
		columns[field] = column;
	}
	return {
		id: def.id,
		idField,
		allowInsert: def.allowInsert ?? false,
		allowDelete: def.allowDelete ?? false,
		policy: def.policy ?? 'merge',
		columns
	};
}

const IMAGE_URL = /^(https?:\/\/|data:image\/|\/)/;
const FILE_URL = /^(https?:\/\/|\/)/;

/** Tipos que se aceptan sin `accept`, por tipo de columna (SB-30). */
export const DEFAULT_ACCEPT: Record<'image' | 'file', string[]> = {
	image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
	file: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/xml']
};
/** Nunca se aceptan: un SVG o un HTML pueden llevar código que corre en el sitio. */
export const FORBIDDEN_TYPES = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/javascript', 'application/javascript']);
const DEFAULT_MAX_SIZE = 5 * 1024 * 1024;

/** `'2mb'`, `'500kb'`, `1024` → bytes. */
export function parseSize(size: number | string | undefined): number {
	if (size === undefined) return DEFAULT_MAX_SIZE;
	if (typeof size === 'number') return size;
	const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(size);
	if (!m) throw new Error(`Tamaño inválido: "${size}" (usa 500kb, 2mb…)`);
	const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] ?? 'b').toLowerCase() as 'b'];
	return Math.round(Number(m[1]) * unit);
}

/** Tamaño máximo y tipos aceptados de una columna con `upload`, ya resueltos. */
export function uploadLimits(type: ColumnType, upload: UploadSpec): UploadSchema {
	const base = type === 'image' ? DEFAULT_ACCEPT.image : DEFAULT_ACCEPT.file;
	return { maxSize: parseSize(upload.maxSize), accept: (upload.accept ?? base).filter((t) => !FORBIDDEN_TYPES.has(t)) };
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
 * Mensaje de error si `value` no es válido para la columna; `null` si lo es.
 * Solo las reglas declarativas: `readOnly` y `validate` los decide quien llama.
 */
export function validateValue(spec: ColumnSpec, value: unknown): string | null {
	if (value === null || value === undefined) return spec.required ? 'No admite vacío' : null;

	switch (spec.type) {
		case 'text': {
			if (typeof value !== 'string') return 'Debe ser texto';
			if (value.trim() === '' && spec.required) return 'No admite vacío';
			if (spec.minLength !== undefined && value.length < spec.minLength) return `Mínimo ${spec.minLength} caracteres`;
			if (spec.maxLength !== undefined && value.length > spec.maxLength) return `Máximo ${spec.maxLength} caracteres`;
			if (spec.pattern && value !== '' && !new RegExp(spec.pattern).test(value)) {
				return spec.patternMessage ?? 'Formato inválido';
			}
			return null;
		}
		case 'number': {
			if (typeof value !== 'number' || !Number.isFinite(value)) return 'Debe ser un número';
			if (spec.min !== undefined && value < spec.min) return `No puede ser menor que ${spec.min}`;
			if (spec.max !== undefined && value > spec.max) return `No puede ser mayor que ${spec.max}`;
			return null;
		}
		case 'date':
			return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
				? null
				: 'Fecha inválida (AAAA-MM-DD)';
		case 'datetime':
			return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : 'Fecha y hora inválida';
		case 'select':
			return spec.options?.some((o) => o.value === value) ? null : 'Valor fuera del catálogo';
		case 'boolean':
			return typeof value === 'boolean' ? null : 'Debe ser verdadero o falso';
		// Lo que se escribe es la contraseña nueva, en claro. La marca que viaja al
		// leer no es una contraseña: devolverla tal cual es «no la cambié».
		case 'password': {
			if (typeof value !== 'string') return 'Debe ser texto';
			if (isPasswordMark(value)) return 'Escribe la contraseña nueva';
			const min = spec.minLength ?? 8;
			if (value.length < min) return `Mínimo ${min} caracteres`;
			if (spec.maxLength !== undefined && value.length > spec.maxLength) return `Máximo ${spec.maxLength} caracteres`;
			return null;
		}
		case 'image':
			return typeof value === 'string' && IMAGE_URL.test(value) ? null : 'URL de imagen inválida';
		case 'file':
			return typeof value === 'string' && FILE_URL.test(value) ? null : 'URL de archivo inválida';
		// Que el registro exista lo comprueba el motor con `lookup.byIds`, de una vez por lote.
		case 'lookup':
			return (typeof value === 'string' && value.trim() !== '') || typeof value === 'number' ? null : 'Valor inválido';
		default:
			return 'Tipo de columna desconocido';
	}
}
