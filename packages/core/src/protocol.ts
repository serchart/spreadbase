/**
 * Protocolo HTTP entre `@spreadbase/client` y `@spreadbase/server` (SB-5).
 * Origen: `open-collect-crm/docs/07-anexo-datagrid-engine.md` §11.13–§11.14.
 */
import type { CellValue } from './values.ts';
import type { RemoteChangePolicy } from './schema.ts';

export type { RemoteChangePolicy };

/**
 * Testigo de versión de una fila. **Opaco**: el cliente solo lo guarda y lo
 * devuelve; solo importa si es igual o distinto. Lo pone la fuente: un contador
 * en memoria, una huella del contenido en Postgres (SB-4).
 */
export type Version = string | number;

/** Una fila tal como la devuelve el servidor: sus campos más el testigo de versión. */
export type Row = Record<string, unknown> & { rowVersion: Version };

/** `?offset&limit&sort=campo:asc|desc&search=&<campo>=a,b` */
export interface ListQuery {
	offset: number;
	limit: number;
	sort: { field: string; dir: 'asc' | 'desc' } | null;
	/** Por campo: valores admitidos. */
	filters: Record<string, string[]>;
	search: string;
}

export interface Page<R = Row> {
	rows: R[];
	/** Filas totales de la consulta, no solo las devueltas. */
	total: number;
	offset: number;
	limit: number;
	/** Versión global de la fuente. Si cambia entre dos páginas, los datos cambiaron en medio. */
	version: number;
}

export interface Position {
	id: string;
	/** 0-based; `null` si la consulta excluye la fila. */
	position: number | null;
	total: number;
}

// -- lote de guardado -------------------------------------------------------

export interface CreateInput {
	/** Clave temporal del cliente. Vuelve en la respuesta junto al id real. */
	key: string;
	values: Record<string, CellValue>;
}

/** Un campo cambiado: el valor que el cliente leyó (`from`) y el que quiere (`to`). */
export interface FieldChange {
	from: CellValue;
	to: CellValue;
}

export interface UpdateInput {
	id: string;
	/** Versión que el cliente leyó. Si coincide, nadie más tocó la fila. */
	rowVersion: Version;
	/** Solo los campos que cambian. */
	changes: Record<string, FieldChange>;
	/**
	 * Lo que el cliente leyó en las columnas escribibles que **no** cambia.
	 * Si el valor actual de una ya es otro, la cambió otro usuario (SB-16).
	 */
	base?: Record<string, CellValue>;
}

export interface DeleteInput {
	id: string;
	rowVersion: Version;
}

export interface BatchInput {
	creates: CreateInput[];
	updates: UpdateInput[];
	deletes: DeleteInput[];
}

/** Un campo que cambiaron el cliente y otro usuario, a valores distintos. */
export interface FieldConflict {
	field: string;
	from: CellValue;
	yours: CellValue;
	remote: unknown;
}

/**
 * Una operación que no se aplicó.
 * - `field_conflict`: uno o más campos los cambiaron ambos.
 * - `version_mismatch`: la fila cambió y la política es `strict`, o es una baja
 *   sobre una fila que otro editó (G-16).
 * - `not_found`: otro usuario la eliminó.
 */
export interface Conflict {
	op: 'update' | 'delete';
	id: string;
	reason: 'field_conflict' | 'version_mismatch' | 'not_found';
	fields?: FieldConflict[];
	/** La fila vigente, para resolver sin otra petición; `null` si ya no existe. */
	remote: Row | null;
}

/** Fila aplicada que traía cambios ajenos en otros campos (política `merge`). */
export interface Notice {
	id: string;
	fields: string[];
}

export interface BatchResult {
	created: { key: string; row: Row }[];
	updated: Row[];
	deleted: string[];
	notices: Notice[];
	conflicts: Conflict[];
}

/** Lo que emite el servidor por cada fila aplicada (SB-8). */
export interface ChangeEvent {
	sheet: string;
	op: 'create' | 'update' | 'delete';
	id: string;
	fields: string[];
	rowVersion: Version | null;
}
