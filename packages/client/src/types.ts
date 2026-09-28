/**
 * Contratos del DataGrid tipo hoja de cálculo.
 *
 * El componente es agnóstico del backend: recibe un `GridConfig` con la
 * definición de columnas y un `DataSource`. Nada se escribe en el servidor
 * hasta que el usuario pulsa "Guardar".
 */

import type { Component } from 'svelte';

export type CellValue = string | number | boolean | null;

export interface Option {
	value: string;
	label: string;
	/** Datos extra que quiera arrastrar la fuente (no se persisten). */
	meta?: Record<string, unknown>;
}

/** Fila de trabajo. `__key` es identidad interna y no viaja al backend. */
export interface GridRow {
	__key: string;
	[field: string]: unknown;
}

export interface ColumnDef {
	field: string;
	label: string;
	/** Nombre del tipo de celda registrado en el `cellTypeRegistry`. */
	type: string;
	width?: number;
	readOnly?: boolean;
	required?: boolean;
	align?: 'left' | 'center' | 'right';
	/** Valor por defecto al crear una fila nueva. */
	defaultValue?: CellValue | (() => CellValue);

	// --- text ---
	maxLength?: number;
	pattern?: RegExp;
	patternMessage?: string;

	// --- number ---
	min?: number;
	max?: number;
	precision?: number;
	prefix?: string;
	suffix?: string;
	thousands?: boolean;

	// --- select (lista fija) ---
	options?: Option[];

	// --- remote-select (fuente externa) ---
	search?: (query: string) => Promise<Option[]>;
	/** Etiquetas conocidas de antemano, para pintar valores ya guardados. */
	preloadLabels?: [string, string][];
	/** Mínimo de caracteres antes de disparar la búsqueda. */
	minSearchLength?: number;

	/** Validador adicional propio de la columna. Devuelve mensaje o null. */
	validate?: (value: CellValue, row: GridRow, column: ColumnDef) => string | null;

	// --- action ---
	/** Botón por fila de las columnas `type: 'action'`. */
	action?: ColumnAction;
}

/**
 * Botón de una columna de acción: uno por fila, con icono y texto.
 *
 * La columna no guarda datos: no se valida, no se copia al portapapeles y
 * nunca queda sucia. Su `field` solo la identifica.
 */
export interface ColumnAction {
	/** Texto del botón. Siempre va en `aria-label` y `title`, se muestre o no. */
	label: string;
	/** Icono de `@lucide/svelte` (el componente, no su nombre). */
	icon?: Component;
	/** Mostrar el texto junto al icono. Default: `true`. Con `false`, solo icono. */
	showLabel?: boolean;
	/** Qué hacer al pulsarlo. Recibe la fila actual y su posición, 0-based. */
	onclick: (row: GridRow, rowIndex: number) => void;
}

/** Un error de validación, con su ubicación exacta en la grilla. */
export interface GridIssue {
	/** Llave interna `rowKey::field`. */
	id: string;
	/** Clave de la fila. Con fuente remota es la única forma de llegar a una fila no cargada. */
	rowKey: string;
	/** Índice de columna, 0-based. */
	x: number;
	/** Índice de fila en la hoja cargada, 0-based; `-1` si la fila está fuera de la ventana. */
	y: number;
	/** Número de fila visible, 1-based: la posición global, cargada o no. */
	row: number;
	field: string;
	label: string;
	message: string;
}

/**
 * Tipo de cambio pendiente de una fila.
 *
 * `unchanged` existe porque una fila puede figurar en el registro **sin tener
 * cambios**: una fila del servidor intacta pero con un valor que no valida. El
 * tipo de cambio y los errores son ejes independientes; mezclarlos en un solo
 * estado obligaría a inventar combinaciones como «creada-con-error».
 */
export type RowChangeState = 'created' | 'updated' | 'deleted' | 'unchanged';

/** Pestaña del panel de cambios. */
export type ChangesFilter = 'all' | 'created' | 'updated' | 'deleted' | 'errors' | 'conflicts';

/**
 * Por qué una fila quedó en conflicto al guardar (§11.14):
 *
 * - `field_conflict`: tú y otro usuario cambiaron los mismos campos.
 * - `version_mismatch`: la fila cambió y la colección es estricta, o
 *   eliminaste una fila que otro editó (G-16).
 * - `not_found`: otro usuario la eliminó.
 */
export type ConflictReason = 'field_conflict' | 'version_mismatch' | 'not_found';

/** Un campo en conflicto, ya formateado: Original · Tuyo · Remoto (G-17). */
export interface ConflictField {
	field: string;
	label: string;
	originalText: string;
	yoursText: string;
	remoteText: string;
	/** Lo que el usuario ya eligió para este campo, si eligió. */
	choice?: 'mine' | 'remote';
}

/**
 * Fila guardada que se combinó con cambios de otro usuario en otros campos
 * (G-15, política `merge`). Informativo: ya está guardada, no hay que decidir.
 */
export interface MergeNotice {
	rowKey: string;
	id: unknown;
	/** Posición global, 0-based, o `null` si es desconocida. */
	position: number | null;
	/** Los campos que cambió el otro usuario, con el valor que quedó. */
	fields: { field: string; label: string; valueText: string }[];
}

export interface RowConflictView {
	op: 'update' | 'delete';
	reason: ConflictReason;
	/** Solo en `field_conflict`. */
	fields: ConflictField[];
}

/** Una celda dentro del registro de cambios, ya formateada para mostrarse. */
export interface CellChange {
	field: string;
	label: string;
	/** Texto del valor confirmado. Vacío en filas nuevas: no hay valor previo. */
	previousText: string;
	/** Texto del valor actual. Vacío en filas eliminadas. */
	currentText: string;
	/** `error` prevalece sobre `changed`: una celda tocada e inválida es un error. */
	state: 'changed' | 'error';
	message?: string;
}

/** Una fila del registro de cambios, con sus celdas relevantes. */
export interface RowChange {
	key: string;
	id: unknown;
	/**
	 * Índice en la hoja cargada, 0-based. `null` en eliminadas y, con fuente
	 * remota, en filas que quedaron fuera de la ventana.
	 */
	rowIndex: number | null;
	/**
	 * Posición global, 0-based: la que tendría en el dataset completo. Igual a
	 * `rowIndex` con fuente local. `null` solo en eliminadas.
	 */
	position: number | null;
	state: RowChangeState;
	okCells: number;
	errorCells: number;
	cells: CellChange[];
	/** La fila quedó en conflicto al guardar y espera que el usuario decida. */
	conflict?: RowConflictView;
}

/** Contadores por fila. Una fila creada nunca cuenta como editada. */
export interface RowSummary {
	created: number;
	updated: number;
	deleted: number;
	/** Filas con al menos una celda inválida, sea cual sea su tipo de cambio. */
	withErrors: number;
	/** Filas en conflicto sin resolver. No se reenvían hasta resolverlas. */
	conflicts: number;
	/** Filas distintas con algo pendiente. **No** es la suma de los anteriores. */
	total: number;
}

export interface ChangeSetUpdate {
	key: string;
	id: unknown;
	/** Solo los campos que cambiaron respecto al baseline. */
	changes: Record<string, CellValue>;
	row: GridRow;
}

export interface ChangeSet {
	creates: GridRow[];
	updates: ChangeSetUpdate[];
	deletes: { key: string; id: unknown; row: GridRow }[];
}

/**
 * Resultado de un intento de guardado. Unión discriminada para que la UI
 * no tenga que adivinar qué pasó a partir de un booleano y un string.
 */
export type SaveResult =
	/** Hay celdas inválidas: no se llegó a llamar al backend. */
	| { status: 'invalid'; issues: GridIssue[] }
	/** El backend rechazó la operación o hubo un fallo de red. */
	| { status: 'error'; message: string }
	/**
	 * Guardado hecho, con el desglose de lo aplicado. Con fuente remota puede
	 * ser parcial (G-11): `conflicts` filas quedaron pendientes de resolver y
	 * `notices` se aplicaron conservando cambios de otros usuarios.
	 */
	| {
			status: 'ok';
			summary: { creates: number; updates: number; deletes: number; conflicts?: number; notices?: number };
	  }
	/** No había nada pendiente que guardar. */
	| { status: 'noop' };

/** Fuente con el dataset completo en memoria: `load()` trae todas las filas. */
export interface LocalDataSource {
	load: () => Promise<Record<string, unknown>[]>;
	/** Recibe el changeset completo. Debe lanzar excepción si falla. */
	save?: (changeSet: ChangeSet) => Promise<void>;
}

// -- lote de guardado remoto (§11.13, §11.14) -------------------------------

type Values = Record<string, unknown>;

/** Lo que cambió, agrupado por operación. El servidor decide el orden. */
export interface BatchRequest {
	/** `key`: clave temporal del cliente; vuelve en la respuesta junto al id real. */
	creates: { key: string; values: Values }[];
	/**
	 * Solo los campos cambiados, de → a. `rowVersion`: el testigo que el cliente
	 * leyó (opaco). `base`: lo leído en las escribibles que no cambió.
	 */
	updates: {
		id: unknown;
		rowVersion: unknown;
		changes: Record<string, { from: unknown; to: unknown }>;
		base: Record<string, unknown>;
	}[];
	deletes: { id: unknown; rowVersion: unknown }[];
}

export interface BatchConflict {
	op: 'update' | 'delete';
	id: unknown;
	reason: ConflictReason;
	/** Solo en `field_conflict`: lo que leíste, lo que quieres y lo que hay. */
	fields?: { field: string; from: unknown; yours: unknown; remote: unknown }[];
	/** La fila vigente en el servidor, para resolver sin otra petición. `null` si ya no existe. */
	remote: Values | null;
}

/** Resultado por fila: lo aplicado y lo que entró en conflicto, en la misma respuesta (G-11). */
export interface BatchResponse {
	created: { key: string; row: Values }[];
	updated: Values[];
	deleted: unknown[];
	/** Filas aplicadas que traían cambios ajenos en otros campos, conservados (G-15). */
	notices: { id: unknown; fields: string[] }[];
	conflicts: BatchConflict[];
}

/** Tramo pedido a una fuente remota. `offset` es la posición global de la primera fila. */
export interface PageRequest {
	offset: number;
	limit: number;
}

export interface PageResult {
	rows: Record<string, unknown>[];
	/** Filas totales de la consulta en el servidor, no solo las devueltas. */
	total: number;
}

/**
 * Fuente remota: el servidor tiene las filas y el grid solo retiene una
 * **ventana** de ellas. Ver `07-anexo-datagrid-engine.md` §11.
 *
 * Ordenar y filtrar son del servidor; la función recibe el tramo y debe
 * respetar un orden estable entre llamadas (con desempate por la PK), o al
 * paginar habría filas repetidas y perdidas.
 */
export interface RemoteDataSource {
	loadPage: (request: PageRequest, signal: AbortSignal) => Promise<PageResult>;
	/**
	 * Guarda un lote (§11.13). `idempotencyKey` identifica el intento: un
	 * reintento del mismo lote la reutiliza para que el servidor no lo aplique
	 * dos veces (G-12). Debe lanzar si falla la red o el servidor.
	 */
	saveBatch?: (batch: BatchRequest, idempotencyKey: string) => Promise<BatchResponse>;
	/**
	 * Posición global actual de una fila, 0-based, o `null` si la consulta ya
	 * no la incluye. La usa «Ir a la fila» del panel de cambios para llegar a
	 * una fila fuera de la ventana (decisión G-1). Sin ella se usa la última
	 * posición conocida, que puede haber cambiado si otros editaron.
	 */
	locate?: (id: unknown, signal: AbortSignal) => Promise<number | null>;
	/**
	 * Estrategia de desplazamiento (decisión G-5). `'window'`: ventana
	 * deslizante que pide páginas al acercarse a un borde y descarta las del
	 * extremo contrario. `'virtual'` —barra de scroll del total— está prevista.
	 */
	strategy?: 'window';
	/** Filas por petición. Default 60. */
	pageSize?: number;
	/**
	 * Máximo de filas retenidas en la ventana. Default 180. Cada desplazamiento
	 * reconstruye la ventana en la hoja con un coste proporcional a este valor
	 * (~0,2 ms por fila con 13 columnas): subirlo produce tirones al desplazarse.
	 */
	windowSize?: number;
}

export type DataSource = LocalDataSource | RemoteDataSource;

export const isRemoteSource = (source: DataSource): source is RemoteDataSource =>
	'loadPage' in source;

export interface GridConfig {
	/** Identificador estable: se usa como llave de persistencia local. */
	id: string;
	columns: ColumnDef[];
	dataSource: DataSource;
	/** Campo que actúa como PK del registro. Default: `id`. */
	idField?: string;
	allowInsert?: boolean;
	allowDelete?: boolean;
	/**
	 * Dónde guardar los cambios pendientes. Default: `session`.
	 *
	 * Con fuente local, `session`/`local` eligen el Storage del navegador. Con
	 * fuente remota, cualquier valor distinto de `none` guarda el borrador en
	 * IndexedDB (§11.11): dura hasta guardar o descartar.
	 */
	persist?: 'session' | 'local' | 'none';
	/**
	 * Registra en la consola lo que viaja al guardar —lote, respuesta, avisos,
	 * conflictos— y cada reconciliación al recargar. Para depurar; apagado por defecto.
	 */
	debug?: boolean;
	height?: string;
	/**
	 * Cuántas de las primeras columnas quedan fijas al desplazar en
	 * horizontal. El número de fila siempre está fijo, aparte de esta cuenta.
	 * Default: 0.
	 */
	frozenColumns?: number;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

/**
 * Acciones que puede ofrecer la barra de herramientas.
 *
 * Es una unión cerrada y no una lista de objetos con callbacks porque la barra
 * no debe poder invocar nada que el contenedor no pueda invocar también: cada
 * nombre corresponde uno a uno con un comando de `GridController.commands`. Si
 * un botón pudiera hacer algo fuera de ese conjunto, la barra externa y la
 * interna dejarían de ser intercambiables.
 */
export type GridToolbarAction =
	| 'undo'
	| 'redo'
	| 'copy'
	| 'copyRows'
	| 'paste'
	| 'addRow'
	| 'deleteRow'
	| 'reload'
	| 'discard'
	| 'save';

export interface GridToolbarConfig {
	/** `false` oculta la barra por completo. */
	enabled?: boolean;
	/**
	 * Acciones agrupadas. Cada grupo se dibuja junto y separado del siguiente
	 * por un divisor, como en Sheets u Office.
	 *
	 * Se pide una matriz y no una lista plana porque el agrupamiento **es**
	 * información: «copiar, copiar filas, pegar» se leen como una familia, y
	 * aplanarlos obligaría al ojo a redescubrir la relación cada vez.
	 */
	groups?: GridToolbarAction[][];
	/** Muestra los contadores de estado (filas, editadas, errores). Default: `true`. */
	status?: boolean;
	/**
	 * Sustituye los contadores de celdas editadas, nuevas y eliminadas por el
	 * botón «Cambios», que cuenta **filas** y abre el panel de cambios pendientes.
	 * Requiere `status`. Default: `true`.
	 */
	changes?: boolean;
}

/**
 * Contexto que reciben los validadores.
 *
 * `fromServer` existe para no producir falsos positivos en las columnas de
 * fuente externa: un id que llegó en la carga es válido por definición, aunque
 * el cliente todavía no conozca su etiqueta. Solo lo que el usuario introduce
 * tiene que poder resolverse contra el catálogo conocido.
 */
export interface ValidationContext {
	labelCache: Map<string, string>;
	fromServer: boolean;
}

export interface CellTypeContext {
	/** Cache compartido de etiquetas para valores de fuentes externas. */
	labelCache: Map<string, string>;
	/** Pide un repintado de estados (dirty / inválido). */
	requestRepaint: () => void;
}

export interface CellTypeDef {
	name: string;
	align?: 'left' | 'center' | 'right';
	/** Normaliza lo que escribe el usuario al valor canónico almacenado. */
	parse: (raw: unknown, column: ColumnDef) => CellValue;
	/** Valor canónico → texto mostrado en la celda. */
	format: (value: CellValue, column: ColumnDef, ctx: CellTypeContext) => string;
	/** Valida el valor canónico. Devuelve mensaje de error o null. */
	validate: (
		value: CellValue,
		column: ColumnDef,
		row: GridRow,
		ctx: ValidationContext
	) => string | null;
	/** Comparación para detectar celdas sucias. */
	equals?: (a: CellValue, b: CellValue) => boolean;
	/**
	 * Si es true, tras editar se reescribe el valor canónico en la hoja.
	 * Evita que lo mostrado (texto crudo) difiera de lo almacenado.
	 */
	normalizeInSheet?: boolean;
	/**
	 * Valor canónico → texto para el portapapeles.
	 * Por defecto se usa `format()`, para que lo copiado sea lo que se ve.
	 */
	toClipboard?: (value: CellValue, column: ColumnDef, ctx: CellTypeContext) => string;
	/**
	 * Texto del portapapeles → valor canónico.
	 * Por defecto se usa `parse()`. Los tipos con catálogo lo sobrescriben para
	 * poder resolver una etiqueta pegada de vuelta a su identificador.
	 */
	fromClipboard?: (raw: string, column: ColumnDef, ctx: CellTypeContext) => CellValue;
	/** Construye la definición de columna nativa de jspreadsheet. */
	toColumn: (column: ColumnDef, ctx: CellTypeContext) => Record<string, unknown>;
}

/**
 * Tema del DataGrid: cada clave es una variable CSS `--dg-*` (camelCase →
 * kebab-case: `headerActiveBg` → `--dg-header-active-bg`). Acepta cualquier
 * valor CSS, incluidos `var(...)` y `color-mix(...)`.
 *
 * Las claves omitidas conservan el valor global: el adaptador del proyecto
 * (`datagrid-daisy.css`) o, sin él, los valores por defecto de `datagrid.css`.
 */
export interface DataGridTheme {
	fontFamily?: string;
	fontSize?: string;
	headerFontSize?: string;
	headerFontWeight?: string;
	popoverFontSize?: string;

	bg?: string;
	fg?: string;
	fgMuted?: string;
	gridLine?: string;

	headerBg?: string;
	headerFg?: string;
	headerActiveBg?: string;
	headerActiveFg?: string;
	frozenEdge?: string;

	selectionBg?: string;
	selectionBorder?: string;
	copyBorder?: string;

	dirtyBg?: string;
	dirtyAccent?: string;
	newBg?: string;
	newAccent?: string;
	invalidBg?: string;
	invalidAccent?: string;

	popoverBg?: string;
	popoverFg?: string;
	popoverBorder?: string;
	popoverShadow?: string;
	hoverBg?: string;
	inputBorder?: string;
	accent?: string;
	accentFg?: string;
	radius?: string;
}
