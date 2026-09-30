import type { BatchResult, CellValue, DistinctValue, ListQuery, Page, Row, SheetDefinition } from '@spreadbase/core';

type MaybePromise<T> = T | Promise<T>;

/**
 * De dónde lee y dónde escribe una hoja (SB-2). SpreadBase no es dueño de la
 * conexión: habla con esta interfaz. Hay una en memoria (`memorySource`) y una
 * para Postgres (`postgresSource`).
 *
 * Cada fila lleva `rowVersion`, un testigo opaco que cambia cuando cambia la
 * fila (SB-4). La tabla del usuario no necesita nada especial: la fuente decide
 * cómo calcularlo (contador, huella del contenido, columna existente).
 */
export interface SheetSource {
	/** La llama `SpreadBase` una vez, al construirse: la fuente conoce las columnas. */
	attach?(definition: SheetDefinition): void;

	/** Orden y filtros del servidor. El orden **siempre** termina en el id. */
	list(query: ListQuery): MaybePromise<Page>;
	/** Posición 0-based de la fila en la misma consulta; `null` si la excluye. */
	position(id: string, query: ListQuery): MaybePromise<{ position: number | null; total: number }>;
	get(id: string): MaybePromise<Row | undefined>;
	/**
	 * Valores distintos de una columna con su cuenta, dentro de la consulta
	 * (SB-33), ordenados, hasta `limit`. Para la lista con casillas del filtro.
	 * Opcional: sin ella, el filtro solo ofrece condiciones.
	 */
	values?(field: string, query: ListQuery, limit: number): MaybePromise<DistinctValue[]>;

	insert(values: Record<string, CellValue>): MaybePromise<Row>;
	/** Escribe campos. Devuelve la fila resultante con su nuevo `rowVersion`. */
	update(id: string, values: Record<string, CellValue>): MaybePromise<Row>;
	remove(id: string): MaybePromise<void>;

	/**
	 * Corre `fn` en una transacción (SB-19). `tx` es la misma fuente atada a esa
	 * conexión. Si la fuente no la tiene, el motor aplica los lotes de uno en uno.
	 */
	transaction?<T>(fn: (tx: SheetTx) => Promise<T>): Promise<T>;
}

/** La fuente dentro de una transacción. */
export interface SheetTx extends SheetSource {
	/** Bloquea estas filas hasta el final de la transacción. Se llama con los ids ordenados. */
	lock(ids: string[]): Promise<void>;
	/** La conexión de la transacción: los handlers escriben con ella. */
	db: unknown;
	/** Guarda la idempotencia en la misma transacción que el lote (SB-18). */
	idempotency?: IdempotencyStore;
}

/** Llave de idempotencia → respuesta del lote que la usó. */
export interface IdempotencyStore {
	get(key: string): MaybePromise<{ bodyHash: string; result: BatchResult } | undefined>;
	put(key: string, bodyHash: string, result: BatchResult): MaybePromise<void>;
}
