/**
 * Módulo sandbox: datos **sintéticos** para probar el DataGrid contra un
 * backend HTTP real, con volumen. No es el modelo de cobranza: sus filas tienen
 * la forma de `/cases` (`CaseGridRow` en el frontend), no el esquema de
 * `02-diseno-base-datos.md`. Ver `07-anexo-datagrid-engine.md` §11.5.
 */

export type CellValue = string | number | null;

export interface CaseRow {
	id: string;
	customer_name: string;
	customer_rfc: string;
	stage_code: string;
	handler_id: string | null;
	dpd: number;
	overdue_amount: number;
	total_amount: number;
	charges_overdue: number;
	contracts: number;
	promise_amount: number | null;
	promise_date: string | null;
	last_contact_at: string | null;
	/**
	 * Testigo de modificación. Sube en cada cambio de la fila. El cliente lo
	 * devuelve al guardar: si no coincide, alguien la cambió desde que la leyó.
	 */
	rowVersion: number;
	updated_at: string;
}

export type FieldName = Exclude<keyof CaseRow, 'rowVersion' | 'updated_at'>;

export type FieldKind = 'id' | 'text' | 'number' | 'date' | 'enum';

export interface FieldSpec {
	kind: FieldKind;
	nullable: boolean;
	/** Editable por el cliente vía `batch`. Los importes son del ledger: no. */
	editable: boolean;
	/** Valores admitidos, para `enum`. */
	values?: readonly string[];
}

export interface ListQuery {
	offset: number;
	limit: number;
	sort: { field: FieldName; dir: 'asc' | 'desc' } | null;
	stage: string[];
	handler: string[];
	search: string;
}

export interface CreateInput {
	/** Clave temporal del cliente. Se devuelve para enlazar la fila creada. */
	key: string;
	values: Partial<Record<FieldName, CellValue>>;
}

/** Un campo cambiado: el valor que el cliente leyó (`from`) y el que quiere (`to`). */
export interface FieldChange {
	from: CellValue;
	to: CellValue;
}

export interface UpdateInput {
	id: string;
	/** Versión que el cliente leyó. Si coincide, nadie más tocó la fila: se aplica sin comparar. */
	rowVersion: number;
	/** Solo los campos que cambian (§11.14). */
	changes: Partial<Record<FieldName, FieldChange>>;
}

/**
 * Qué hacer con los cambios **ajenos** en campos que la petición no toca
 * (G-15). Es de la colección, no de la petición: el cliente no puede relajarla.
 *
 * - `merge`: se conservan y se informan en `notices`.
 * - `strict`: la fila se rechaza como conflicto.
 */
export type RemoteChangePolicy = 'merge' | 'strict';

export interface DeleteInput {
	id: string;
	rowVersion: number;
}

export interface BatchInput {
	creates: CreateInput[];
	updates: UpdateInput[];
	deletes: DeleteInput[];
}

/** Un campo que cambiaron el cliente y otro usuario, a valores distintos. */
export interface FieldConflict {
	field: FieldName;
	/** Lo que el cliente leyó. */
	from: CellValue;
	/** Lo que el cliente quiere. */
	yours: CellValue;
	/** Lo que hay ahora. */
	remote: CellValue;
}

/**
 * Una operación del lote que no se aplicó.
 *
 * - `field_conflict`: uno o más campos los cambiaron ambos (`fields`).
 * - `version_mismatch`: la fila cambió y la política es estricta, o es una
 *   baja sobre una fila que otro editó (G-16).
 * - `not_found`: otro usuario la eliminó.
 *
 * `remote` trae la fila vigente para resolver sin otra petición.
 */
export interface Conflict {
	op: 'update' | 'delete';
	id: string;
	reason: 'field_conflict' | 'version_mismatch' | 'not_found';
	fields?: FieldConflict[];
	remote: CaseRow | null;
}

/** Fila aplicada que traía cambios ajenos en otros campos (política `merge`). */
export interface Notice {
	id: string;
	fields: FieldName[];
}

export interface BatchResult {
	created: { key: string; row: CaseRow }[];
	updated: CaseRow[];
	deleted: string[];
	notices: Notice[];
	conflicts: Conflict[];
}
