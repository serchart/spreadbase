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
	DATETIME: 'datetime'
} as const;

export type ColumnType = (typeof types)[keyof typeof types];

export interface Option {
	value: string;
	label: string;
}

export interface ColumnSpec {
	type: ColumnType;
	label: string;

	// -- reglas: el servidor las exige al guardar y el cliente al editar
	/** El cliente no la puede editar. El `idField` siempre es de solo lectura. */
	readOnly?: boolean;
	/** Vacío no permitido. */
	required?: boolean;
	maxLength?: number;
	/** Expresión regular, como texto para que viaje en JSON. */
	pattern?: string;
	patternMessage?: string;
	min?: number;
	max?: number;
	options?: Option[];
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
	columns: Record<string, Omit<ColumnSpec, 'validate'>>;
}

export function toSchema(def: SheetDefinition): SheetSchema {
	const idField = def.idField ?? 'id';
	const columns: SheetSchema['columns'] = {};
	for (const [field, { validate: _validate, ...spec }] of Object.entries(def.columns)) {
		columns[field] = field === idField ? { ...spec, readOnly: true } : spec;
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
		default:
			return 'Tipo de columna desconocido';
	}
}
