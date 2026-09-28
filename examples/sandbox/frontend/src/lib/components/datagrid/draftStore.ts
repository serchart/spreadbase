/**
 * Borrador del DataGrid en IndexedDB (decisión G-8, `07-anexo-datagrid-engine.md` §11.11).
 *
 * Tres almacenes, todos por grid:
 *
 * - `draft_rows`: una entrada por fila con algo pendiente —el mapa por fila—.
 * - `draft_actions`: el registro de acciones de deshacer/rehacer, por `seq`.
 * - `draft_meta`: puntero de deshacer, etiquetas y versión del formato.
 *
 * **Por qué IndexedDB y no `localStorage`.** Escribe por registro: editar una
 * celda escribe esa fila, no el borrador entero reserializado. Cuota de cientos
 * de MB, asíncrono, y con versión de esquema para migrar en lugar de tirar el
 * borrador. Sin dependencias: la API nativa basta para accesos por clave.
 *
 * Todas las funciones degradan a no-op si IndexedDB no existe (SSR, modos que
 * lo bloquean): perder la recuperación ante refresco no debe romper la hoja.
 */
import type { CellValue, GridRow } from './types';

const DB_NAME = 'oc-datagrid';
/** Versión del esquema de la base. Subirla dispara `onupgradeneeded` para migrar. */
const DB_VERSION = 1;
/** Versión del formato de los registros. Un borrador de otro formato se ignora. */
export const DRAFT_FORMAT = 1;

export type DraftRowState = 'updated' | 'created' | 'deleted';

/** Una fila con algo pendiente: el mapa por fila del §4.1. */
export interface DraftRow {
	gridId: string;
	rowKey: string;
	id: unknown;
	state: DraftRowState;
	/** Valores actuales, con los cambios del usuario. */
	current: GridRow;
	/** Valores del servidor al tocarla. `null` en filas nuevas. */
	original: GridRow | null;
	/** Campos que difieren del original. Informativo: al restaurar se recalcula. */
	dirty: string[];
	/** Testigo de modificación del servidor al leer la fila (R3: conflictos). */
	rowVersion: CellValue;
	/** Última posición global conocida. `null` en nuevas. */
	position: number | null;
	/** Orden entre las nuevas. `null` en las demás. */
	order: number | null;
	updatedAt: string;
}

export interface DraftAction {
	gridId: string;
	seq: number;
	changes: unknown[];
}

export interface DraftMeta {
	gridId: string;
	format: number;
	savedAt: string;
	/** Acciones deshacibles: las `cursor` primeras por `seq`. */
	cursor: number;
	labels: [string, string][];
	/** G-10, pendiente: usuario dueño del borrador. */
	owner: string | null;
}

export interface Draft {
	rows: DraftRow[];
	actions: DraftAction[];
	meta: DraftMeta | null;
}

export interface DraftWrite {
	upsertRows: DraftRow[];
	deleteRows: string[];
	putActions: DraftAction[];
	deleteActions: number[];
	meta: DraftMeta;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === 'undefined') return Promise.resolve(null);
	dbPromise ??= new Promise((resolve) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains('draft_rows')) {
				db.createObjectStore('draft_rows', { keyPath: ['gridId', 'rowKey'] }).createIndex('gridId', 'gridId');
			}
			if (!db.objectStoreNames.contains('draft_actions')) {
				db.createObjectStore('draft_actions', { keyPath: ['gridId', 'seq'] }).createIndex('gridId', 'gridId');
			}
			if (!db.objectStoreNames.contains('draft_meta')) {
				db.createObjectStore('draft_meta', { keyPath: 'gridId' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => resolve(null);
		request.onblocked = () => resolve(null);
	});
	return dbPromise;
}

const done = (tx: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});

const all = <T>(request: IDBRequest<T[]>) =>
	new Promise<T[]>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

/** Lee el borrador de un grid. `null` si no hay, o si es de otro formato. */
export async function loadDraft(gridId: string): Promise<Draft | null> {
	const db = await openDb();
	if (!db) return null;
	const tx = db.transaction(['draft_rows', 'draft_actions', 'draft_meta'], 'readonly');
	const range = IDBKeyRange.only(gridId);
	const [rows, actions, metaList] = await Promise.all([
		all<DraftRow>(tx.objectStore('draft_rows').index('gridId').getAll(range)),
		all<DraftAction>(tx.objectStore('draft_actions').index('gridId').getAll(range)),
		all<DraftMeta>(tx.objectStore('draft_meta').getAll(range))
	]);
	const meta = metaList[0] ?? null;
	if (!meta || meta.format !== DRAFT_FORMAT) return null;
	if (rows.length === 0 && actions.length === 0) return null;
	actions.sort((a, b) => a.seq - b.seq);
	return { rows, actions, meta };
}

/**
 * Escribe un lote de cambios del borrador en **una** transacción: o se aplica
 * todo, o nada. Así una recarga a mitad de escritura nunca deja filas sin su
 * puntero de historial, ni al revés.
 */
export async function writeDraft(gridId: string, write: DraftWrite): Promise<void> {
	const db = await openDb();
	if (!db) return;
	const tx = db.transaction(['draft_rows', 'draft_actions', 'draft_meta'], 'readwrite');
	const rows = tx.objectStore('draft_rows');
	const actions = tx.objectStore('draft_actions');
	for (const row of write.upsertRows) rows.put(row);
	for (const key of write.deleteRows) rows.delete([gridId, key]);
	for (const action of write.putActions) actions.put(action);
	for (const seq of write.deleteActions) actions.delete([gridId, seq]);
	tx.objectStore('draft_meta').put(write.meta);
	await done(tx);
}

/** Borra el borrador de un grid: al guardar con éxito o al descartar. */
export async function clearDraft(gridId: string): Promise<void> {
	const db = await openDb();
	if (!db) return;
	const tx = db.transaction(['draft_rows', 'draft_actions', 'draft_meta'], 'readwrite');
	const range = IDBKeyRange.only(gridId);
	for (const name of ['draft_rows', 'draft_actions'] as const) {
		const store = tx.objectStore(name);
		const keys = await all<IDBValidKey>(store.index('gridId').getAllKeys(range));
		for (const key of keys) store.delete(key);
	}
	tx.objectStore('draft_meta').delete(gridId);
	await done(tx);
}
