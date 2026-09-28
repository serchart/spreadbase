/**
 * El protocolo HTTP de SpreadBase (SB-5). Tipos compartidos por el servidor
 * (los produce) y el cliente (los consume); no se rediseñan.

 * Referencia: docs/07-anexo-datagrid-engine.md §11.13–§11.14 de OpenCollect.
 */

/** Lectura por tramos. `offset` es la posición global de la primera fila. */
export interface PageRequest {
	offset: number;
	limit: number;
	sort?: { field: string; direction: 'asc' | 'desc' };
	filters?: Record<string, unknown>;
	search?: string;
}

export interface PageResult<Row = Record<string, unknown>> {
	rows: Row[];
	total: number;
	version: number;
}

export interface LocateResult {
	position: number;
	total: number;
	version: number;
}

/** Una celda que cambia: el valor que el cliente leyó y el que quiere. */
export interface FieldChange {
	from: unknown;
	to: unknown;
}

export interface BatchCreate {
	/** Clave temporal del cliente; la respuesta la devuelve con la fila creada. */
	key: string;
	values: Record<string, unknown>;
}

export interface BatchUpdate {
	id: unknown;
	/** Versión que el cliente leyó; si coincide con la remota, se aplica sin comparar. */
	rowVersion: number;
	changes: Record<string, FieldChange>;
}

export interface BatchDelete {
	id: unknown;
	rowVersion: number;
}

export interface BatchRequest {
	creates: BatchCreate[];
	updates: BatchUpdate[];
	deletes: BatchDelete[];
}

export type ConflictReason = 'field_conflict' | 'version_mismatch' | 'not_found';

/** Un campo que cambiaron el cliente y otro usuario, a valores distintos. */
export interface FieldConflict {
	field: string;
	/** Lo que el cliente leyó. */
	from: unknown;
	/** Lo que el cliente quiere guardar. */
	yours: unknown;
	/** Lo que hay ahora. */
	remote: unknown;
}

export interface Conflict<Row = Record<string, unknown>> {
	op: 'update' | 'delete';
	id: unknown;
	reason: ConflictReason;
	/** Solo en `field_conflict`. */
	fields?: FieldConflict[];
	/** La fila vigente, para resolver sin otra petición. `null` si ya no existe. */
	remote: Row | null;
}

/** Fila aplicada que conservó cambios ajenos en otros campos (política merge). */
export interface Notice {
	id: unknown;
	fields: string[];
}

export interface BatchResponse<Row = Record<string, unknown>> {
	created: { key: string; row: Row }[];
	updated: Row[];
	deleted: unknown[];
	notices: Notice[];
	conflicts: Conflict<Row>[];
}

/** Qué hacer con cambios ajenos en campos que la petición no toca. */
export type RemoteChangePolicy = 'merge' | 'strict';
