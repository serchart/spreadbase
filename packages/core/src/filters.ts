/**
 * Filtros por columna, como los de Excel (SB-33): por valores (una lista con
 * casillas) o por una condición (`>`, «contiene», «entre»…). Uno por columna;
 * entre columnas se combinan con Y.
 *
 * Viajan en `?where=<JSON>` (§5.1). Son independientes de los filtros fijos
 * `?<campo>=a,b` (SB-28), que siguen igual y se suman.
 */
import type { ColumnType } from './schema.ts';
import { fold, isBlank } from './values.ts';

/** Operadores. `in` es la lista de valores; los demás, condiciones. */
export type FilterOp =
	| 'in'
	| 'eq'
	| 'ne'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'between'
	| 'contains'
	| 'not_contains'
	| 'starts'
	| 'ends'
	| 'empty'
	| 'not_empty';

export interface ColumnFilter {
	field: string;
	op: FilterOp;
	/** Operando de la condición (texto, número o fecha `AAAA-MM-DD`). */
	value?: string | number | null;
	/** Límite superior de `between` (incluido). */
	value2?: string | number | null;
	/** Valores de `in`, como los devuelve `GET /values/:field`. `null` = celdas vacías. */
	values?: (string | number | boolean | null)[];
}

/** Un valor distinto de una columna y cuántas filas lo tienen (`GET /values/:field`). */
export interface DistinctValue {
	value: string | number | boolean | null;
	count: number;
}

export interface ValuesResult {
	values: DistinctValue[];
	/** Hay más valores que los devueltos: la lista no está completa. */
	truncated: boolean;
	/** Columnas `lookup`: el nombre de cada id (SB-21). */
	labels?: Record<string, string>;
}

/** Máximo de valores distintos que devuelve `GET /values/:field`. */
export const MAX_DISTINCT_VALUES = 1000;

/** Cómo se filtra cada tipo: texto, número, fecha o solo por lista. */
export type FilterKind = 'text' | 'number' | 'date' | 'list';

export function filterKind(type: ColumnType): FilterKind | null {
	switch (type) {
		case 'text':
		case 'image':
		case 'file':
			return 'text';
		case 'number':
			return 'number';
		case 'date':
		case 'datetime':
			return 'date';
		case 'select':
		case 'lookup':
		case 'boolean':
			return 'list';
		default:
			// password: filtrar por ella sería un oráculo del hash (SB-22).
			return null;
	}
}

const COMMON: FilterOp[] = ['in', 'empty', 'not_empty'];
const COMPARE: FilterOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'];
const TEXT: FilterOp[] = ['eq', 'ne', 'contains', 'not_contains', 'starts', 'ends'];

/** Operadores que admite un tipo de columna. */
export function filterOps(type: ColumnType): FilterOp[] {
	const kind = filterKind(type);
	if (kind === 'text') return [...COMMON, ...TEXT];
	if (kind === 'number' || kind === 'date') return [...COMMON, ...COMPARE];
	if (kind === 'list') return COMMON;
	return [];
}

/** Etiqueta de un operador para la interfaz, según el tipo de columna. */
export function filterOpLabel(op: FilterOp, kind: FilterKind): string {
	const date = kind === 'date';
	switch (op) {
		case 'in':
			return 'Valores';
		case 'eq':
			return date ? 'Es el día' : 'Es igual a';
		case 'ne':
			return date ? 'No es el día' : 'No es igual a';
		case 'gt':
			return date ? 'Después de' : 'Mayor que';
		case 'gte':
			return date ? 'Desde' : 'Mayor o igual que';
		case 'lt':
			return date ? 'Antes de' : 'Menor que';
		case 'lte':
			return date ? 'Hasta' : 'Menor o igual que';
		case 'between':
			return 'Entre';
		case 'contains':
			return 'Contiene';
		case 'not_contains':
			return 'No contiene';
		case 'starts':
			return 'Empieza con';
		case 'ends':
			return 'Termina con';
		case 'empty':
			return 'Está vacía';
		case 'not_empty':
			return 'No está vacía';
	}
}

/** El operador necesita operando (`value`), y `between` además `value2`. */
export const needsValue = (op: FilterOp): boolean => op !== 'in' && op !== 'empty' && op !== 'not_empty';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valida la forma de un filtro contra el tipo de su columna. Devuelve el
 * mensaje del problema o `null`. Normaliza el operando (número, fecha).
 */
export function checkFilter(filter: ColumnFilter, type: ColumnType): string | null {
	const kind = filterKind(type);
	if (!kind || !filterOps(type).includes(filter.op)) return `El operador «${filter.op}» no aplica a la columna "${filter.field}"`;
	if (filter.op === 'in') {
		return Array.isArray(filter.values) ? null : `"${filter.field}": «in» necesita values`;
	}
	if (!needsValue(filter.op)) return null;
	const operands = filter.op === 'between' ? [filter.value, filter.value2] : [filter.value];
	for (const v of operands) {
		if (isBlank(v)) return `"${filter.field}": falta el valor de la condición`;
		if (kind === 'number' && !Number.isFinite(Number(v))) return `"${filter.field}": el valor debe ser un número`;
		if (kind === 'date' && !DATE.test(String(v))) return `"${filter.field}": la fecha debe ser AAAA-MM-DD`;
	}
	return null;
}

/** `?where=[…]` → filtros; lanza con un mensaje si no es una lista de `{ field, op }`. */
export function parseWhere(raw: string): ColumnFilter[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('where debe ser JSON: [{ "field", "op", "value" }]');
	}
	if (!Array.isArray(parsed)) throw new Error('where debe ser una lista');
	return parsed.map((f, i) => {
		if (!isRecord(f) || typeof f.field !== 'string' || typeof f.op !== 'string') {
			throw new Error(`where[${i}] debe ser { field, op, value?, value2?, values? }`);
		}
		const out: ColumnFilter = { field: f.field, op: f.op as FilterOp };
		if (f.value !== undefined) out.value = f.value as ColumnFilter['value'];
		if (f.value2 !== undefined) out.value2 = f.value2 as ColumnFilter['value2'];
		if (f.values !== undefined) out.values = f.values as ColumnFilter['values'];
		return out;
	});
}

/**
 * El valor de una celda como se agrupa y compara en los filtros: número como
 * número, fecha-hora por su **día** (`AAAA-MM-DD`), vacío como `null`.
 */
export function filterValueOf(value: unknown, type: ColumnType): string | number | boolean | null {
	if (isBlank(value)) return null;
	if (type === 'number') return Number(value);
	if (type === 'datetime') return String(value).slice(0, 10);
	if (type === 'boolean') return value === true || value === 'true';
	return String(value);
}

/**
 * ¿La celda pasa el filtro? La regla de referencia: la fuente en memoria la
 * usa tal cual y la de Postgres la traduce a SQL con el mismo resultado.
 *
 * - Texto: sin acentos ni mayúsculas.
 * - «No es igual» y «no contiene» incluyen las vacías (como Excel).
 * - Fecha-hora: se compara por día.
 */
export function matchesFilter(value: unknown, filter: ColumnFilter, type: ColumnType): boolean {
	const v = filterValueOf(value, type);
	switch (filter.op) {
		case 'empty':
			return v === null;
		case 'not_empty':
			return v !== null;
		case 'in':
			return (filter.values ?? []).some((w) => (w === null ? v === null : v !== null && String(filterValueOf(w, type)) === String(v)));
	}
	const kind = filterKind(type);
	if (kind === 'text') {
		const needle = fold(String(filter.value ?? ''));
		if (v === null) return filter.op === 'ne' || filter.op === 'not_contains';
		const text = fold(String(v));
		switch (filter.op) {
			case 'eq':
				return text === needle;
			case 'ne':
				return text !== needle;
			case 'contains':
				return text.includes(needle);
			case 'not_contains':
				return !text.includes(needle);
			case 'starts':
				return text.startsWith(needle);
			case 'ends':
				return text.endsWith(needle);
			default:
				return false;
		}
	}
	if (v === null) return filter.op === 'ne';
	const cmp = (a: unknown, b: unknown) => {
		if (kind === 'number') return Number(a) - Number(b);
		const x = String(a);
		const y = String(b);
		return x < y ? -1 : x > y ? 1 : 0;
	};
	switch (filter.op) {
		case 'eq':
			return cmp(v, filter.value) === 0;
		case 'ne':
			return cmp(v, filter.value) !== 0;
		case 'gt':
			return cmp(v, filter.value) > 0;
		case 'gte':
			return cmp(v, filter.value) >= 0;
		case 'lt':
			return cmp(v, filter.value) < 0;
		case 'lte':
			return cmp(v, filter.value) <= 0;
		case 'between':
			return cmp(v, filter.value) >= 0 && cmp(v, filter.value2) <= 0;
		default:
			return false;
	}
}
