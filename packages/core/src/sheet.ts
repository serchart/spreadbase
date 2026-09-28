/**
 * La hoja definida una sola vez (SB-1): qué campos tiene, de qué tipo y con
 * qué reglas. La usa el servidor para validar el lote y el front para validar
 * al editar; también orienta cambios de orden/filtros.
 */
import type { CellValue } from './values.ts';
import {
	isBlank,
	sameValue,
	toCanonicalDate,
	toCanonicalDateTime,
	toCanonicalNumber
} from './values.ts';

export type FieldKind = 'text' | 'number' | 'enum' | 'date' | 'datetime';

/** Una columna de dominio. Todo lo visual (ancho, formato) vive en el front. */
export interface FieldSpec {
	kind: FieldKind;
	label: string;
	/** El cliente no la puede editar. */
	readOnly?: boolean;
	/** Vacío no permitido. En enum: se necesita una opción válida. */
	required?: boolean;
	min?: number;
	max?: number;
	maxLength?: number;
	/** Enum: valores válidos. */
	options?: { value: string; label: string }[];
	/** Regla de negocio; recibe la fila entera, no solo la celda. */
	validate?: (value: CellValue, row: Record<string, CellValue>) => string | null;
}

export interface SheetDef {
	/** Nombre de la colección: identifica la hoja y su ruta. `cases.portfolio`. */
	id: string;
	/** Campo que identifica a cada fila. Default: `id`. */
	idField?: string;
	allowInsert?: boolean;
	allowDelete?: boolean;
	fields: Record<string, FieldSpec>;
}

export function defineSheet(def: SheetDef): SheetDef {
	return def;
}

export const idFieldOf = (sheet: SheetDef) => sheet.idField ?? 'id';

/**
 * Normaliza un valor al canon de su tipo (`null` si era vacío). Nunca lanza:
 * lo que no se puede parsear se devuelve tal cual y lo atrapa `validateField`.
 */
export function canonicalize(spec: FieldSpec, raw: unknown): CellValue {
	switch (spec.kind) {
		case 'number':
			return toCanonicalNumber(raw);
		case 'enum':
			return isBlank(raw) ? null : String(raw);
		case 'date':
			return toCanonicalDate(raw);
		case 'datetime':
			return toCanonicalDateTime(raw);
		default:
			return isBlank(raw) ? null : String(raw).trim();
	}
}

/** Valida un valor **ya canónico** contra su campo. `null` = válido. */
export function validateField(
	field: string,
	spec: FieldSpec,
	value: CellValue,
	row: Record<string, CellValue>
): string | null {
	if (spec.required && isBlank(value)) return `«${spec.label}» es obligatorio`;
	if (isBlank(value)) return spec.validate?.(value, row) ?? null;

	switch (spec.kind) {
		case 'text': {
			const s = String(value);
			if (spec.maxLength !== undefined && s.length > spec.maxLength) return `«${spec.label}» admite hasta ${spec.maxLength} caracteres`;
			break;
		}
		case 'number': {
			const n = Number(value);
			if (typeof value === 'string' && isNaN(n)) return `«${spec.label}» debe ser número`;
			if (!isNaN(n)) {
				if (spec.min !== undefined && n < spec.min) return `«${spec.label}» no puede ser menor que ${spec.min}`;
				if (spec.max !== undefined && n > spec.max) return `«${spec.label}» no puede ser mayor que ${spec.max}`;
			}
			break;
		}
		case 'enum': {
			if (spec.options && !spec.options.some((o) => o.value === value)) return `«${spec.label}» no es una opción válida`;
			break;
		}
		case 'date':
			if (!toCanonicalDate(value)) return `«${spec.label}» debe ser una fecha`;
			break;
		case 'datetime':
			if (!toCanonicalDateTime(value)) return `«${spec.label}» debe ser fecha y hora`;
			break;
	}
	return spec.validate?.(value, row) ?? null;
}

/** Campos que el cliente puede escribir: ni de solo lectura ni el id. */
export function writableFields(sheet: SheetDef): string[] {
	const idField = idFieldOf(sheet);
	return Object.entries(sheet.fields)
		.filter(([name, spec]) => !spec.readOnly && name !== idField)
		.map(([name]) => name);
}

export { sameValue };
