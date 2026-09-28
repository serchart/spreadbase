import type { CellValue, ListQuery, Page, Row, SheetDefinition } from '@spreadbase/core';

type MaybePromise<T> = T | Promise<T>;

/**
 * De dónde lee y dónde escribe una hoja (SB-2). SpreadBase no es dueño de la
 * conexión: habla con esta interfaz. Hay una en memoria (`memorySource`) y
 * habrá una para Postgres.
 *
 * Requisitos para la concurrencia por campo (SB-4): cada fila lleva
 * `rowVersion`, que sube con cada cambio, y la fuente sabe qué campos
 * cambiaron desde una versión (`changedFieldsSince`).
 */
export interface SheetSource {
	/** La llama `SpreadBase` una vez, al construirse: la fuente conoce las columnas. */
	attach?(definition: SheetDefinition): void;

	/** Orden y filtros del servidor. El orden **siempre** termina en el id. */
	list(query: ListQuery): MaybePromise<Page>;
	/** Posición 0-based de la fila en la misma consulta; `null` si la excluye. */
	position(id: string, query: ListQuery): MaybePromise<{ position: number | null; total: number }>;
	get(id: string): MaybePromise<Row | undefined>;
	/** Campos que cambiaron después de `version` en esa fila. */
	changedFieldsSince(id: string, version: number): MaybePromise<string[]>;

	insert(values: Record<string, CellValue>): MaybePromise<Row>;
	/** Escribe campos, sube `rowVersion` y anota qué campos cambiaron. Devuelve la fila resultante. */
	update(id: string, values: Record<string, CellValue>): MaybePromise<Row>;
	remove(id: string): MaybePromise<void>;
}
