/**
 * La hoja: qué columnas tiene, de qué tipo y con qué reglas (SB-1, SB-12).
 *
 * Se escribe en el backend y viaja al front por `GET <base>/schema`. Las
 * reglas declarativas viajan y el front las aplica al editar; `validate`, que
 * es una función, solo corre en el servidor.
 */
import type { CellValue, FileRef } from './values.ts';
import { fileNameOf, isFileRef, normalizeFileRef } from './values.ts';

export const types = {
	TEXT: 'text',
	NUMBER: 'number',
	SELECT: 'select',
	/**
	 * Varias opciones de `options` (SB-41): una lista de sus `value`, sin
	 * repetidos y en el orden de `options`. Vacía es `null` (como `folder`; `[]`
	 * se lee igual). Se pega y se copia como «BYD, Honda».
	 */
	MULTISELECT: 'multiselect',
	DATE: 'date',
	DATETIME: 'datetime',
	/** URL de una imagen (`https://…`, `/ruta`, `data:image/…`). Con `upload`, también se sube (SB-30). */
	IMAGE: 'image',
	/**
	 * Un archivo (SB-30, SB-38): `{ url, nombre, tipo, tamano }` (`FileRef`).
	 * También vale solo su URL (`https://…` o `/ruta`), como antes de SB-38: la
	 * celda muestra el nombre, que es el último tramo de la URL. Con `upload`,
	 * se sube.
	 */
	FILE: 'file',
	/** Varios archivos (SB-38): una lista de `FileRef`. La celda muestra el conteo y la lista. Con `upload`, se suben. */
	FOLDER: 'folder',
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
	/**
	 * Nombre de un ícono del registro del cliente (`registerIcons`), p. ej.
	 * `hourglass`: se pinta antes de la etiqueta, en la celda y en la lista
	 * (SB-39). Un nombre desconocido no pinta nada.
	 */
	icon?: string;
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
	/**
	 * Otros campos de las filas de `resolve` con que un texto pegado identifica
	 * el registro, además de `value` y `display` (una clave corta: «YADI» →
	 * Yadira López). Sin acentos ni mayúsculas. SB-34.
	 */
	resolveBy?: string[];
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
 * Orden de respaldo: la imagen; si no hay o no carga, el ícono propio del
 * registro (`iconField`); si no hay o no es un nombre conocido, las iniciales
 * (si `initials`); si no, el ícono fijo (`icon`); si no, uno genérico (persona
 * si es redonda, edificio si es cuadrada).
 */
export interface AvatarSpec {
	/**
	 * Campo con la URL de la imagen. En una columna `lookup`, del registro
	 * elegido (el servidor lo manda con su nombre); en las demás, de la misma
	 * fila.
	 */
	image?: string;
	/**
	 * Campo con el **nombre** de un ícono del registro del cliente
	 * (`registerIcons`): un ícono distinto por fila (SB-39). Sale del mismo lugar
	 * que `image`: en una columna `lookup`, del registro elegido (el servidor lo
	 * manda con su nombre, en `icons`); en las demás, de la misma fila. Se
	 * dibuja con `currentColor`, así sigue el tema. Vacío o desconocido: lo que
	 * sigue en el orden de respaldo.
	 */
	iconField?: string;
	/** Las iniciales del texto (hasta dos), con un color estable por texto. */
	initials?: boolean;
	/** Nombre de un ícono del registro del cliente (`registerIcons`), p. ej. `building`: el mismo en toda la columna. */
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
	/** Solo `image`, `file` y `folder`: se pueden subir archivos (SB-30, SB-38). El destino no viaja. */
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
	/** Solo `text`: texto largo (una ficha en markdown, un JSON): la celda muestra la primera línea y se lee y edita en un visor amplio (SB-38). */
	multiline?: boolean;
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

/** Tipos que se aceptan sin `accept`, por tipo de columna (SB-30). `folder`, como `file`. */
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
		case 'multiselect': {
			if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return 'Debe ser una lista de opciones';
			if (!value.length) return spec.required ? 'No admite vacío' : null;
			if (new Set(value).size !== value.length) return 'Opción repetida';
			return value.every((v) => spec.options?.some((o) => o.value === v)) ? null : 'Valor fuera del catálogo';
		}
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
			return fileProblem(value);
		case 'folder': {
			if (!Array.isArray(value)) return 'Debe ser una lista de archivos';
			if (!value.length && spec.required) return 'No admite vacío';
			for (const item of value) {
				const problem = isFileRef(item) ? fileProblem(item) : 'Cada archivo debe ser { url, name, type, size }';
				if (problem) return problem;
			}
			return null;
		}
		// Que el registro exista lo comprueba el motor con `lookup.byIds`, de una vez por lote.
		case 'lookup':
			return (typeof value === 'string' && value.trim() !== '') || typeof value === 'number' ? null : 'Valor inválido';
		default:
			return 'Tipo de columna desconocido';
	}
}

/**
 * Un archivo válido: su URL (como en SB-30) o `{ url, name, type, size }` con
 * una URL válida. La forma obsoleta `{ url, nombre, tipo, tamano }` también vale.
 */
function fileProblem(value: unknown): string | null {
	if (typeof value === 'string') return FILE_URL.test(value) ? null : 'URL de archivo inválida';
	if (!isFileRef(value)) return 'URL de archivo inválida';
	if (!FILE_URL.test(value.url)) return 'URL de archivo inválida';
	const raw = value as { name?: unknown; nombre?: unknown; size?: unknown; tamano?: unknown };
	const name = raw.name ?? raw.nombre;
	if (typeof name !== 'string' || !name.trim()) return 'El archivo necesita nombre';
	const size = raw.size ?? raw.tamano;
	if (size !== undefined && (typeof size !== 'number' || size < 0)) return 'Tamaño inválido';
	return null;
}

/**
 * Un valor de archivo como `FileRef` (SB-38), siempre en la forma actual: un
 * objeto (también en la forma obsoleta) se normaliza; una URL suelta (SB-30)
 * toma su nombre del final de la URL, sin tipo ni tamaño.
 */
export function toFileRef(value: unknown): FileRef | null {
	if (isFileRef(value)) return normalizeFileRef(value);
	if (typeof value === 'string' && value.trim()) return { url: value.trim(), name: fileNameOf(value.trim()), type: '', size: 0 };
	return null;
}

/** Los archivos de una celda `folder` (o `file`) como lista de `FileRef`. */
export function fileRefsOf(value: unknown): FileRef[] {
	if (Array.isArray(value)) return value.map(toFileRef).filter((f): f is FileRef => f !== null);
	const one = toFileRef(value);
	return one ? [one] : [];
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;

/** ¿El archivo es una imagen? Por su tipo real o, si no lo trae (una URL suelta), por la extensión. */
export function isImageFile(ref: FileRef): boolean {
	if (ref.type) return ref.type.startsWith('image/') && ref.type !== 'image/svg+xml';
	return IMAGE_EXT.test(ref.name || ref.url.split(/[?#]/)[0]!);
}

/**
 * La imagen que representa un valor como miniatura (`avatar.image`, SB-29):
 * una URL tal cual; en una carpeta (`folder`, SB-38), su **principal** —el
 * primero de la lista— si es imagen; si no, la primera imagen de la carpeta;
 * si no hay ninguna, `null`. Una carpeta que llega como texto JSON (una
 * columna `text` de la base) se lee igual.
 */
export function thumbnailOf(value: unknown): string | null {
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) return null;
		if (!text.startsWith('[') && !text.startsWith('{')) return text;
		try {
			value = JSON.parse(text);
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== 'object') return null;
	// `fileRefsOf` normaliza: también lee la forma obsoleta `{ url, nombre, tipo, tamano }`.
	const refs = Array.isArray(value) || isFileRef(value) ? fileRefsOf(value) : [];
	return refs.find(isImageFile)?.url ?? null;
}

// -- selección múltiple (SB-41) ---------------------------------------------

/**
 * Los valores de una celda `multiselect` como lista: la lista guardada, o el
 * JSON de una lista (una columna de texto en la base). Vacía, `null` o
 * cualquier otra cosa: `[]`.
 */
export function multiValuesOf(value: unknown): string[] {
	if (typeof value === 'string' && value.trim().startsWith('[')) {
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	}
	return Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined && v !== '').map(String) : [];
}

const foldText = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

/**
 * Lo escrito, pegado o importado → el valor canónico de una `multiselect`:
 * una lista (o su JSON) o un texto separado por comas, punto y coma o saltos
 * de línea («BYD, Honda»). Cada parte se busca por etiqueta o por valor, sin
 * acentos ni mayúsculas; lo que no está en `options` se conserva tal cual
 * para que la validación lo marque. Sin repetidos, en el orden de `options`
 * (lo desconocido al final). Vacío → `null`.
 */
export function parseMultiSelect(raw: unknown, options: Option[] = []): string[] | null {
	let parts: string[];
	if (Array.isArray(raw)) parts = raw.filter((v) => v !== null && v !== undefined).map(String);
	else if (raw === null || raw === undefined) parts = [];
	else {
		const text = String(raw).trim();
		parts = text.startsWith('[') ? multiValuesOf(text) : text.split(/[,;\n]/);
	}
	const chosen = new Set<string>();
	const unknown: string[] = [];
	for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
		const needle = foldText(part);
		const match = options.find((o) => o.value === part) ?? options.find((o) => foldText(o.label) === needle) ?? options.find((o) => foldText(o.value) === needle);
		if (match) chosen.add(match.value);
		else if (!unknown.includes(part)) unknown.push(part);
	}
	const ordered = [...options.filter((o) => chosen.has(o.value)).map((o) => o.value), ...unknown];
	return ordered.length ? ordered : null;
}

/** Las etiquetas de una `multiselect` como se copian y se leen: «BYD, Honda». */
export function formatMultiSelect(value: unknown, options: Option[] = []): string {
	return multiValuesOf(value)
		.map((v) => options.find((o) => o.value === v)?.label ?? v)
		.join(', ');
}
