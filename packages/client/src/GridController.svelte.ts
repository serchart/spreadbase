/**
 * Controlador de estado del DataGrid.
 *
 * Mantiene tres capas:
 *   baseline  → cómo vino el registro del servidor (última verdad confirmada)
 *   rows      → copia de trabajo que el usuario edita
 *   dirty     → qué celdas difieren del baseline
 *
 * Nada llega al servidor hasta `save()`. Mientras tanto, todo el estado
 * pendiente se persiste en session/localStorage para sobrevivir un refresh.
 */

import { getCellType } from './cellTypes';
import type {
	BatchRequest,
	BatchResponse,
	CellChange,
	CellTypeContext,
	CellValue,
	ChangeSet,
	ConflictReason,
	MergeNotice,
	RowConflictView,
	ChangesFilter,
	ColumnDef,
	GridConfig,
	GridIssue,
	GridRow,
	RemoteDataSource,
	RowChange,
	RowSummary,
	SaveResult,
	ValidationContext
} from './types';
import { isRemoteSource } from './types';
import {
	DRAFT_FORMAT,
	clearDraft,
	loadDraft,
	writeDraft,
	type Draft,
	type DraftRow,
	type DraftRowState
} from './draftStore';

/** Resultado de desplazar la ventana remota: lo que la hoja necesita para compensar el scroll. */
export interface WindowShift {
	direction: 'up' | 'down';
	/** Filas que entraron **por arriba** (al subir). Mueven el contenido hacia abajo. */
	added: number;
	/** Filas que salieron **por arriba** (al bajar). Mueven el contenido hacia arriba. */
	removed: number;
}

const STORAGE_PREFIX = 'oc.grid.';
const STORAGE_VERSION = 1;

/**
 * Acciones que **no pueden vivir en el controlador** porque dependen de la
 * instancia de jspreadsheet: necesitan la selección activa, la celda con foco
 * o el portapapeles del navegador.
 *
 * En vez de importar jspreadsheet aquí —lo que costaría la mejor propiedad de
 * esta clase, que es no saber nada del DOM y poder probarse sin navegador— el
 * controlador solo guarda una tabla de funciones que `SpreadsheetGrid` le
 * registra al montar. El controlador las invoca sin saber qué hacen.
 *
 * `save` y `discard` también están aquí, y no es redundante: las versiones del
 * componente además **repintan la hoja**. Si el contenedor llamara al
 * `save()` de datos directamente, guardaría bien pero dejaría la cuadrícula
 * mostrando valores viejos.
 */
export interface SheetCommands {
	copy(cut?: boolean): void | Promise<void>;
	copyRows(): void | Promise<void>;
	paste(): void | Promise<void>;
	addRow(): void | Promise<void>;
	deleteSelection(): void | Promise<void>;
	reload(): void | Promise<void>;
	save(): void | Promise<void>;
	discard(): void | Promise<void>;
	undo(): void | Promise<void>;
	redo(): void | Promise<void>;
}

type DeletedRow = { key: string; id: unknown; row: GridRow };

/**
 * Un cambio atómico del historial:
 *
 * - `cell`: un campo pasó de `before` a `after`.
 * - `insert`: apareció una fila nueva en la posición `at`. Con fuente local,
 *   posición en `rows`; con remota, en la lista de nuevas (§11.11).
 * - `delete`: salió la fila que estaba en `at`. `row` es su copia al borrarla y
 *   `created` si era nueva —entonces desaparece sin ir al changeset—.
 * - `mark`: solo fuente remota. Una fila del servidor se marcó (o desmarcó)
 *   como eliminada; sigue en su posición, tachada, hasta guardar (G-7).
 *
 * Todo es por **clave de fila** y con valores planos: es serializable tal cual,
 * que es lo que permite guardarlo en IndexedDB y conservar ⌘Z tras un refresco.
 */
export type HistoryChange =
	| { kind: 'cell'; rowKey: string; field: string; before: CellValue; after: CellValue }
	| { kind: 'insert'; rowKey: string; at: number; row: GridRow }
	| { kind: 'delete'; rowKey: string; at: number; row: GridRow; created: boolean }
	| { kind: 'mark'; rowKey: string; before: boolean; after: boolean };

/**
 * Una acción del usuario: la unidad de deshacer. Pegar 200×10 son 2 000
 * cambios y **una** acción.
 *
 * **Registro de operaciones, no fotografías.** Deshacer aplica `before` de
 * cada cambio en orden inverso; rehacer, `after` en orden directo. El estado
 * derivado —qué celdas están sucias, qué errores hay— no se guarda: se
 * recalcula de los valores contra `baseline`, así que no puede desincronizarse
 * del dato. Es el mismo registro que se persiste; el mapa neto por fila vive
 * aparte y es el que se guarda en el servidor.
 *
 * **Por qué no el historial de jspreadsheet.** Solo conoce valores de celdas:
 * deshacer con él un alta quitaría la fila de la pantalla pero la dejaría en
 * el changeset. Ver `07-anexo-datagrid-engine.md` §5.
 */
export interface HistoryAction {
	/** Número creciente. Identifica la acción en IndexedDB: se escribe una vez y no cambia. */
	seq: number;
	changes: HistoryChange[];
}

/** Profundidad del historial. */
const HISTORY_LIMIT = 50;

interface PersistedState {
	v: number;
	rows: GridRow[];
	baseline: [string, GridRow][];
	dirty: string[];
	created: string[];
	deleted: { key: string; id: unknown; row: GridRow }[];
	labels: [string, string][];
	savedAt: string;
}

let keySeq = 0;
function nextKey(): string {
	return `tmp_${Date.now().toString(36)}_${(keySeq++).toString(36)}`;
}

const cellId = (rowKey: string, field: string) => `${rowKey}::${field}`;

/**
 * Separa un `cellId` en clave de fila y campo.
 *
 * Se corta por el **último** separador: la clave de fila deriva del id del
 * servidor y podría contener `::`; un nombre de campo, no.
 */
function splitCellId(id: string): [rowKey: string, field: string] {
	const at = id.lastIndexOf('::');
	return [id.slice(0, at), id.slice(at + 2)];
}

/** Vacío a efectos de mostrar: `0` y `false` son valores, no ausencia de valor. */
const isEmpty = (value: unknown): boolean =>
	value === null || value === undefined || value === '';

/**
 * Igualdad normalizada, la misma que usa el servidor para detectar conflictos:
 * vacío = vacío, y `1500` = `"1500.00"`. Comparar texto crudo daría conflictos
 * falsos por formato.
 */
function same(a: unknown, b: unknown): boolean {
	if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
	if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
	return String(a) === String(b);
}

export class GridController {
	readonly config: GridConfig;
	readonly columns: ColumnDef[];
	readonly idField: string;
	readonly labelCache = new Map<string, string>();
	/** Posición de cada columna por su campo. Fija durante toda la vida del grid. */
	private readonly columnIndex: Map<string, number>;

	rows: GridRow[] = [];

	/**
	 * Posición de cada fila por su clave.
	 *
	 * Existe para que localizar una fila sea O(1). Sin él, todo lo que parte de
	 * una clave —un error, una celda sucia— tenía que recorrer `rows` para saber
	 * en qué fila estaba, y ese recorrido dentro de un bucle convertía operaciones
	 * lineales en cuadráticas: con 10 000 filas y 5 000 errores, `errorList`
	 * ejecutaba 5×10⁷ comparaciones cada vez que se confirmaba una celda.
	 *
	 * Solo se reconstruye cuando cambia el **orden o el número** de filas. Editar
	 * no mueve nada de sitio, así que durante la actividad normal el índice se
	 * mantiene válido sin coste alguno.
	 */
	private rowIndex = new Map<string, number>();
	/** Alguna columna valida con contexto de la fila entera: cada edición revalida la fila. */
	private readonly hasRowValidators: boolean;
	private baseline = new Map<string, GridRow>();
	private dirtyCells = new Set<string>();
	private createdKeys = new Set<string>();
	private deletedRows: DeletedRow[] = [];
	private errors = new Map<string, string>();

	/** Contador para disparar reactividad tras mutaciones imperativas. */
	version = $state(0);
	loading = $state(false);
	saving = $state(false);
	loadError = $state<string | null>(null);
	restoredFromStorage = $state(false);
	lastSavedAt = $state<string | null>(null);

	private persistTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Tabla de comandos que registra la hoja al montar. `null` hasta entonces,
	 * porque el contenedor puede construir el controlador y renderizar su
	 * toolbar antes de que jspreadsheet exista.
	 */
	private sheetCommands = $state<SheetCommands | null>(null);

	/** Filas seleccionadas en la hoja, o `null`. La escribe el componente. */
	selection = $state<{ from: number; to: number } | null>(null);

	/**
	 * Panel lateral abierto —filtros, grupos o cambios— y pestaña activa de
	 * cambios.
	 *
	 * Es estado de **vista**, no de datos, pero vive aquí porque lo comparten
	 * dos componentes que no se conocen: la toolbar lo abre y la hoja lo
	 * dibuja junto a la cuadrícula. Con la toolbar montada fuera de la hoja no
	 * hay otro punto en común.
	 *
	 * Un solo valor y no dos booleanos: comparten el mismo hueco junto a la
	 * hoja, así que abrir uno cierra el otro por construcción.
	 */
	sidePanel = $state<'changes' | 'filters' | 'groups' | null>(null);
	changesFilter = $state<ChangesFilter>('all');

	/**
	 * Grupos activos: carpetas virtuales que acotan la hoja (p. ej. «Atiende:
	 * Karina Gloria»). Solo el contador por ahora, para el badge del botón;
	 * el modelo completo llega con el panel de grupos.
	 */
	activeGroupCount = $state(0);

	get groupsOpen(): boolean {
		return this.sidePanel === 'groups';
	}

	toggleGroups(): void {
		this.sidePanel = this.sidePanel === 'groups' ? null : 'groups';
	}

	get changesOpen(): boolean {
		return this.sidePanel === 'changes';
	}

	get filtersOpen(): boolean {
		return this.sidePanel === 'filters';
	}

	openChanges(filter?: ChangesFilter): void {
		if (filter) this.changesFilter = filter;
		this.sidePanel = 'changes';
	}

	closeChanges(): void {
		if (this.sidePanel === 'changes') this.sidePanel = null;
	}

	toggleChanges(): void {
		this.sidePanel = this.sidePanel === 'changes' ? null : 'changes';
	}

	toggleFilters(): void {
		this.sidePanel = this.sidePanel === 'filters' ? null : 'filters';
	}

	closeSidePanel(): void {
		this.sidePanel = null;
	}

	// -- historial ----------------------------------------------------------

	/**
	 * Registro de acciones y puntero: `actions[0..cursor)` se pueden deshacer,
	 * `actions[cursor..)` rehacer. Una lista y un índice en lugar de dos pilas:
	 * es la forma que se persiste tal cual.
	 */
	private actions: HistoryAction[] = [];
	private cursor = 0;
	/** Contador propio: el historial cambia sin que cambien los datos. */
	private historyVersion = $state(0);

	get canUndo(): boolean {
		this.historyVersion;
		return this.cursor > 0;
	}

	get canRedo(): boolean {
		this.historyVersion;
		return this.cursor < this.actions.length;
	}

	/** Acción de la transacción abierta, o `null` fuera de una. */
	private txAction: HistoryAction | null = null;

	/**
	 * Añade un cambio a la acción en curso.
	 *
	 * Dentro de una transacción va a la acción de la transacción; fuera, cada
	 * cambio abre la suya. Abrir una acción nueva descarta lo que se podía
	 * rehacer: tras una edición nueva, ese futuro ya no es alcanzable, y
	 * conservarlo permitiría «rehacer» hacia un estado que nunca existió en esta
	 * línea de cambios.
	 */
	private record(change: HistoryChange): void {
		this.draftKeys.add(change.rowKey);
		if (this.txAction) {
			this.txAction.changes.push(change);
			return;
		}
		this.pushAction({ seq: 0, changes: [change] });
	}

	private actionSeq = 0;

	private pushAction(action: HistoryAction): void {
		action.seq = ++this.actionSeq;
		this.actions.length = this.cursor;
		this.actions.push(action);
		if (this.actions.length > HISTORY_LIMIT) this.actions.shift();
		this.cursor = this.actions.length;
		this.historyVersion++;
	}

	/**
	 * Aplica los cambios de una acción en un sentido.
	 *
	 * Deshacer recorre los cambios al revés y aplica `before`; rehacer, al
	 * derecho y `after`. Después se recalcula el estado derivado —sucias,
	 * errores— de las filas tocadas, en lugar de guardarlo en el historial.
	 *
	 * Coste O(cambios × columnas); una alta o baja añade O(filas) por reindexar.
	 */
	private applyAction(action: HistoryAction, direction: 'undo' | 'redo'): void {
		const changes = direction === 'undo' ? [...action.changes].reverse() : action.changes;
		const touched = new Set<string>();
		let structural = false;
		for (const change of changes) {
			touched.add(change.rowKey);
			if (change.kind === 'cell') {
				const row = this.getRow(change.rowKey);
				if (row) row[change.field] = direction === 'undo' ? change.before : change.after;
			} else if (change.kind === 'mark') {
				if ((direction === 'undo' ? change.before : change.after)) this.deletedKeys.add(change.rowKey);
				else this.deletedKeys.delete(change.rowKey);
			} else {
				structural = true;
				if ((change.kind === 'insert') === (direction === 'redo')) this.attachRow(change);
				else this.detachChangeRow(change);
			}
		}
		// Con ventana, las nuevas se recolocan al inicio en un solo paso.
		if (structural && this.remote) this.composeWindow();
		for (const key of touched) {
			this.draftKeys.add(key);
			const row = this.getRow(key);
			if (row) this.refreshRow(row);
			else this.forgetRowState(key);
		}
	}

	/**
	 * Pone una fila en la hoja: rehacer un alta o deshacer una baja. Se inserta
	 * una **copia** del registro para que el historial nunca comparta objeto con
	 * la hoja: si no, editar la fila después alteraría el propio historial.
	 *
	 * Con fuente remota solo hay altas de filas nuevas (las bajas del servidor
	 * son marcas): van a la lista de nuevas y `composeWindow` las pinta.
	 */
	private attachRow(change: Extract<HistoryChange, { kind: 'insert' | 'delete' }>): void {
		const row = { ...change.row };
		const wasCreated = change.kind === 'insert' || change.created;
		if (this.remote) {
			this.createdOrder.splice(Math.min(change.at, this.createdOrder.length), 0, change.rowKey);
			this.detached.set(change.rowKey, row);
			this.createdKeys.add(change.rowKey);
			return;
		}
		this.rows.splice(Math.min(change.at, this.rows.length), 0, row);
		if (wasCreated) this.createdKeys.add(change.rowKey);
		else this.deletedRows = this.deletedRows.filter((d) => d.key !== change.rowKey);
		this.reindexRows();
	}

	/** Saca una fila de la hoja: deshacer un alta o rehacer una baja. */
	private detachChangeRow(change: Extract<HistoryChange, { kind: 'insert' | 'delete' }>): void {
		const wasCreated = change.kind === 'insert' || change.created;
		if (this.remote) {
			this.createdOrder = this.createdOrder.filter((k) => k !== change.rowKey);
			this.detached.delete(change.rowKey);
			this.createdKeys.delete(change.rowKey);
			return;
		}
		const at = this.rowIndex.get(change.rowKey);
		if (at === undefined) return;
		const [row] = this.rows.splice(at, 1);
		if (wasCreated) this.createdKeys.delete(change.rowKey);
		else this.deletedRows.push({ key: change.rowKey, id: row[this.idField] ?? null, row });
		this.reindexRows();
	}

	/** Olvida sucias y errores de una fila que ya no está en la hoja. */
	private forgetRowState(key: string): void {
		for (const column of this.columns) {
			this.dirtyCells.delete(cellId(key, column.field));
			this.errors.delete(cellId(key, column.field));
		}
	}

	/**
	 * Agrupa varias mutaciones en **una sola** entrada de historial.
	 *
	 * Es imprescindible para las operaciones masivas. Un pegado de 200×10 llama a
	 * `setCellValue` 2000 veces: sin agrupar, deshacerlo exigiría 2000 pulsaciones
	 * de ⌘Z y dejaría 2000 instantáneas del estado completo en memoria.
	 *
	 * La unidad de deshacer debe ser **la acción que hizo el usuario**, no cada
	 * celda que esa acción tocó. El usuario pegó una vez; deshacer una vez.
	 *
	 * Solo admite funciones sincrónicas: con `await` dentro, la transacción se
	 * cerraría antes de que terminaran las mutaciones pendientes y estas
	 * generarían entradas sueltas.
	 */
	transaction<T>(fn: () => T): T {
		if (this.txAction) return fn();
		const action: HistoryAction = { seq: 0, changes: [] };
		this.txAction = action;
		try {
			return fn();
		} finally {
			this.txAction = null;
			// Una transacción que no tocó nada no altera el historial: ni deja un
			// ⌘Z que no hace nada ni descarta lo que se podía rehacer.
			if (action.changes.length > 0) this.pushAction(action);
		}
	}

	undo(): boolean {
		if (this.cursor === 0) return false;
		this.cursor--;
		this.applyAction(this.actions[this.cursor], 'undo');
		this.historyVersion++;
		this.touch();
		return true;
	}

	redo(): boolean {
		if (this.cursor >= this.actions.length) return false;
		this.applyAction(this.actions[this.cursor], 'redo');
		this.cursor++;
		this.historyVersion++;
		this.touch();
		return true;
	}

	private clearHistory(): void {
		this.actions = [];
		this.cursor = 0;
		this.historyVersion++;
	}

	/** El historial menciona esta fila: deshacer o rehacer podría necesitarla. */
	private historyMentions(key: string): boolean {
		return this.actions.some((a) => a.changes.some((c) => c.rowKey === key));
	}

	/**
	 * La hoja ya está montada y los comandos responden.
	 *
	 * Sirve para deshabilitar la toolbar externa durante el primer render, en
	 * lugar de ofrecer botones que no harían nada.
	 */
	get sheetReady(): boolean {
		return this.sheetCommands !== null;
	}

	get hasSelection(): boolean {
		return this.selection !== null;
	}

	/**
	 * Registra los comandos de la hoja y devuelve la función para darlos de baja.
	 *
	 * Devolver el limpiador —en vez de un `detachSheet()` suelto— evita que al
	 * desmontar se borren por error los comandos de otra hoja que ya se hubiera
	 * registrado en medio.
	 */
	attachSheet(commands: SheetCommands): () => void {
		this.sheetCommands = commands;
		return () => {
			if (this.sheetCommands === commands) this.sheetCommands = null;
		};
	}

	/**
	 * Superficie pública para una toolbar externa.
	 *
	 * Está separada de los métodos de datos (`save`, `discard`, `load`) a
	 * propósito: estos comandos son de **interfaz** y siempre pasan por la hoja
	 * para que la cuadrícula quede repintada. Los métodos de datos son la
	 * primitiva que usa el propio componente.
	 *
	 * Si la hoja aún no montó, cada comando es un no-op silencioso: un clic
	 * prematuro no debe reventar.
	 */
	readonly commands = {
		copy: (cut = false) => this.sheetCommands?.copy(cut),
		copyRows: () => this.sheetCommands?.copyRows(),
		paste: () => this.sheetCommands?.paste(),
		addRow: () => this.sheetCommands?.addRow(),
		deleteSelection: () => this.sheetCommands?.deleteSelection(),
		reload: () => this.sheetCommands?.reload(),
		save: () => this.sheetCommands?.save(),
		discard: () => this.sheetCommands?.discard(),
		undo: () => this.sheetCommands?.undo(),
		redo: () => this.sheetCommands?.redo()
	};

	constructor(config: GridConfig) {
		this.config = config;
		this.columns = config.columns;
		this.idField = config.idField ?? 'id';
		this.remote = isRemoteSource(config.dataSource) ? config.dataSource : null;
		// Las columnas no cambian en vida del controlador: se indexan una vez.
		this.columnIndex = new Map(this.columns.map((c, i) => [c.field, i]));
		this.hasRowValidators = this.columns.some((c) => !!c.validate);
	}

	/**
	 * Fila por clave, esté en la ventana o retenida fuera de ella.
	 *
	 * Es la puerta única para todo lo que parte de una clave —panel de cambios,
	 * changeset, validación, historial—. Con fuente local equivale a `rows`.
	 */
	getRow(key: string): GridRow | undefined {
		const at = this.rowIndex.get(key);
		return at === undefined ? this.detached.get(key) : this.rows[at];
	}

	/**
	 * Posición global, 0-based, de una fila cargada o retenida. `null` si no se
	 * conoce o si es una fila nueva de una fuente remota: aún no tiene posición
	 * en el servidor.
	 */
	positionOf(key: string): number | null {
		const at = this.rowIndex.get(key);
		if (at !== undefined) return at < this.lead ? null : this.windowOffset + at - this.lead;
		return this.detachedAt.get(key) ?? null;
	}

	/** Reconstruye el índice de filas. O(n), solo tras alterar orden o cantidad. */
	private reindexRows(): void {
		this.rowIndex.clear();
		for (let i = 0; i < this.rows.length; i++) this.rowIndex.set(this.rows[i].__key, i);
	}

	/** Posición de una fila por su clave, o `null` si ya no está en la hoja. */
	indexOfRow(rowKey: string): number | null {
		const at = this.rowIndex.get(rowKey);
		return at === undefined ? null : at;
	}

	// -- lecturas reactivas -------------------------------------------------

	get dirtyCount(): number {
		this.version;
		return this.dirtyCells.size;
	}

	get createdCount(): number {
		this.version;
		return this.createdKeys.size;
	}

	get deletedCount(): number {
		this.version;
		return this.deletedRows.length + this.deletedKeys.size;
	}

	get errorCount(): number {
		this.version;
		return this.errors.size;
	}

	get rowCount(): number {
		this.version;
		return this.rows.length;
	}

	get hasPendingChanges(): boolean {
		this.version;
		return (
			this.dirtyCells.size > 0 ||
			this.createdKeys.size > 0 ||
			this.deletedRows.length > 0 ||
			this.deletedKeys.size > 0
		);
	}

	get errorList(): GridIssue[] {
		this.version;
		const out: GridIssue[] = [];
		for (const [id, message] of this.errors) {
			const [key, field] = splitCellId(id);
			const position = this.positionOf(key);
			const x = this.columnIndex.get(field) ?? -1;
			// Una nueva remota no tiene posición, pero sus errores cuentan: `row` 0 = «nueva».
			if ((position === null && !this.createdKeys.has(key)) || x < 0) continue;
			out.push({
				id,
				rowKey: key,
				x,
				y: this.rowIndex.get(key) ?? -1,
				row: position === null ? 0 : position + 1,
				field,
				label: this.columns[x].label,
				message
			});
		}
		// Por posición global: una fila retenida fuera de la ventana se ordena en su sitio real.
		return out.sort((a, b) => a.row - b.row || a.x - b.x);
	}

	isDirtyCell(rowKey: string, field: string): boolean {
		return this.dirtyCells.has(cellId(rowKey, field));
	}

	isInvalidCell(rowKey: string, field: string): boolean {
		return this.errors.has(cellId(rowKey, field));
	}

	isCreatedRow(rowKey: string): boolean {
		return this.createdKeys.has(rowKey);
	}

	cellError(rowKey: string, field: string): string | undefined {
		return this.errors.get(cellId(rowKey, field));
	}

	// -- registro de cambios por fila ---------------------------------------

	/**
	 * Campos sucios y con error agrupados por fila, memoizado por `version`.
	 *
	 * Un solo recorrido de O(celdas sucias + celdas con error) —proporcional a los
	 * cambios, nunca a las filas— sirve a todos los lectores de una misma versión.
	 * Sin la memoria, cada badge del módulo de cambios repetiría el recorrido.
	 *
	 * Es seguro memoizar por `version` porque toda mutación la incrementa.
	 */
	private groupCache: {
		version: number;
		dirty: Map<string, Set<string>>;
		errors: Map<string, Set<string>>;
		summary?: RowSummary;
	} | null = null;

	private grouped() {
		const version = this.version;
		if (this.groupCache?.version === version) return this.groupCache;

		const group = (ids: Iterable<string>) => {
			const out = new Map<string, Set<string>>();
			for (const id of ids) {
				const [key, field] = splitCellId(id);
				let fields = out.get(key);
				if (!fields) out.set(key, (fields = new Set()));
				fields.add(field);
			}
			return out;
		};

		this.groupCache = {
			version,
			dirty: group(this.dirtyCells),
			errors: group(this.errors.keys())
		};
		return this.groupCache;
	}

	/** Contadores por fila para los badges. O(cambios), memoizado por versión. */
	get rowSummary(): RowSummary {
		const cache = this.grouped();
		if (cache.summary) return cache.summary;
		const { dirty, errors } = cache;
		// Unión de filas vivas afectadas. Las eliminadas se suman aparte porque sus
		// celdas ya no figuran en `dirtyCells` ni en `errors`.
		const live = new Set<string>(this.createdKeys);
		for (const key of dirty.keys()) live.add(key);
		for (const key of errors.keys()) live.add(key);
		cache.summary = {
			created: this.createdKeys.size,
			updated: dirty.size,
			deleted: this.deletedRows.length + this.deletedKeys.size,
			withErrors: errors.size,
			conflicts: this.conflicts.size,
			total: live.size + this.deletedRows.length + this.deletedKeys.size
		};
		return cache.summary;
	}

	/** Vista del conflicto de una fila para el panel, ya formateada. */
	private conflictView(key: string): RowConflictView | undefined {
		const conflict = this.conflicts.get(key);
		if (!conflict) return undefined;
		return {
			op: conflict.op,
			reason: conflict.reason,
			fields: conflict.fields.map((f) => {
				const column = this.columns[this.columnIndex.get(f.field) ?? -1];
				const text = (v: unknown) => (column ? this.formatValue(column, v as CellValue) : String(v ?? ''));
				return {
					field: f.field,
					label: column?.label ?? f.field,
					originalText: text(f.from),
					yoursText: text(f.yours),
					remoteText: text(f.remote),
					choice: f.choice
				};
			})
		};
	}

	/**
	 * Registro de cambios agrupado por fila, en el orden de la hoja y con las
	 * eliminadas al final.
	 *
	 * Coste O(K·m + K log K), con K = filas afectadas: nunca recorre las filas
	 * intactas. Aun así **no es gratis**: formatea cada celda listada y medido con
	 * 5 000 filas afectadas cuesta ~20 ms, más de un fotograma. Por eso solo debe
	 * leerse con el panel abierto; los badges usan `rowSummary`, que sí es barato.
	 * Ver `07-anexo-datagrid-engine.md` §9.
	 *
	 * Qué celdas se listan en cada fila:
	 *   - editada   → las tocadas y las inválidas.
	 *   - nueva     → las que tienen valor y las inválidas. Listar las catorce
	 *                 columnas de una fila recién creada sería ruido.
	 *   - eliminada → las que tenían valor, para confirmar qué se va a borrar.
	 *   - intacta   → solo las inválidas: es la única razón de que aparezca.
	 */
	get changeLog(): RowChange[] {
		const { dirty, errors } = this.grouped();
		const keys = new Set<string>(this.createdKeys);
		for (const key of dirty.keys()) keys.add(key);
		for (const key of errors.keys()) keys.add(key);

		const live: RowChange[] = [];
		for (const key of keys) {
			// Cargada o retenida fuera de la ventana: el registro no depende de lo visible.
			const row = this.getRow(key);
			if (!row) continue;
			const at = this.rowIndex.get(key);
			const created = this.createdKeys.has(key);
			const dirtyFields = dirty.get(key);
			const errorFields = errors.get(key);
			const base = created ? undefined : this.baseline.get(key);

			const cells: CellChange[] = [];
			for (const column of this.columns) {
				const field = column.field;
				const isError = errorFields?.has(field) ?? false;
				const current = (row[field] ?? null) as CellValue;
				const relevant =
					isError || (created ? !isEmpty(current) : (dirtyFields?.has(field) ?? false));
				if (!relevant) continue;
				cells.push({
					field,
					label: column.label,
					previousText: base ? this.formatValue(column, base[field] as CellValue) : '',
					currentText: this.formatValue(column, current),
					state: isError ? 'error' : 'changed',
					message: isError ? this.errors.get(cellId(key, field)) : undefined
				});
			}

			const errorCells = cells.filter((c) => c.state === 'error').length;
			live.push({
				key,
				id: row[this.idField] ?? null,
				rowIndex: at ?? null,
				position: this.positionOf(key),
				state: created ? 'created' : dirtyFields ? 'updated' : 'unchanged',
				okCells: cells.length - errorCells,
				errorCells,
				cells,
				conflict: this.conflictView(key)
			});
		}
		// Las nuevas remotas no tienen posición: van primero, como en la hoja.
		live.sort((a, b) => (a.position ?? -1) - (b.position ?? -1));

		// Bajas: las locales ya salieron de la hoja; las remotas siguen en ella, marcadas.
		const removed = [
			...this.deletedRows,
			...[...this.deletedKeys].flatMap((key) => {
				const row = this.getRow(key);
				return row ? [{ key, id: row[this.idField] ?? null, row }] : [];
			})
		];
		const deleted: RowChange[] = removed.map(({ key, id, row }) => {
			const cells: CellChange[] = [];
			for (const column of this.columns) {
				const value = (row[column.field] ?? null) as CellValue;
				if (isEmpty(value)) continue;
				cells.push({
					field: column.field,
					label: column.label,
					previousText: this.formatValue(column, value),
					currentText: '',
					state: 'changed'
				});
			}
			const marked = this.deletedKeys.has(key);
			return {
				key,
				id,
				rowIndex: marked ? (this.rowIndex.get(key) ?? null) : null,
				position: marked ? this.positionOf(key) : null,
				state: 'deleted',
				conflict: this.conflictView(key),
				okCells: cells.length,
				errorCells: 0,
				cells
			};
		});
		const last = Number.MAX_SAFE_INTEGER;
		deleted.sort((a, b) => (a.position ?? last) - (b.position ?? last));

		return [...live, ...deleted];
	}

	/**
	 * Contexto de formato para el registro. `requestRepaint` es deliberadamente
	 * inerte: formatear para un listado no debe provocar repintados de la hoja.
	 */
	private readonly formatContext: CellTypeContext = {
		labelCache: this.labelCache,
		requestRepaint: () => {}
	};

	/** Texto de un valor tal como lo mostraría la hoja: etiquetas, no códigos. */
	private formatValue(column: ColumnDef, value: CellValue): string {
		if (isEmpty(value)) return '';
		return getCellType(column.type).format(value, column, this.formatContext);
	}

	private touch() {
		this.version++;
		this.schedulePersist();
	}

	// -- carga --------------------------------------------------------------

	async load(): Promise<void> {
		this.loading = true;
		this.loadError = null;
		try {
			const source = this.config.dataSource;
			if (isRemoteSource(source)) {
				/*
					Con fuente remota, recargar **no** descarta el trabajo: trae datos
					frescos del servidor y vuelve a poner encima el borrador (G-9). Se
					escribe antes lo último pendiente para no perder los 300 ms del
					agrupado. Las páginas en vuelo se invalidan: traerían datos de antes.
				*/
				await this.flushDraftNow();
				this.cancelWindowRequests();
				const [page, draft] = await Promise.all([
					this.fetchPage({ offset: 0, limit: this.pageSize }),
					this.draftEnabled ? loadDraft(this.config.id).catch(() => null) : null
				]);
				if (!page) return;
				this.total = page.total;
				this.windowOffset = 0;
				this.adoptServerRows(page.rows);
				// Sin borrador, lo guardado (si lo hubiera de otra sesión) ya no aplica.
				this.persistedSeqs.clear();
				this.persistedCursor = 0;
				if (draft) this.applyDraft(draft);
				this.draftReady = true;
				this.restoredFromStorage = !!draft && draft.rows.length > 0;
			} else {
				const raw = await source.load();
				this.total = raw.length;
				this.adoptServerRows(raw);
				this.restoredFromStorage = false;
				this.clearStorage();
			}
		} catch (err) {
			this.loadError = err instanceof Error ? err.message : 'Error al cargar los datos';
		} finally {
			this.loading = false;
			this.version++;
		}
	}

	// -- ventana remota -------------------------------------------------------
	//
	// Con una fuente remota, `rows` deja de ser el dataset: es una **ventana**
	// de él, que empieza en la posición global `windowOffset`. La hoja pide
	// ampliarla al acercarse a un borde (`extendWindow`) y el controlador
	// descarta filas del extremo contrario para no pasar de `windowSize`.
	// Diseño y decisiones: `07-anexo-datagrid-engine.md` §11.
	//
	// **R1 es de solo lectura.** Descartar una fila con cambios pendientes los
	// perdería: el registro de cambios aún vive en `rows`. Completarlo para que
	// sobreviva a la ventana es la fase 6 (R2).

	readonly remote: RemoteDataSource | null;

	/** Posición global de `rows[0]`. Siempre 0 con una fuente local. */
	windowOffset = $state(0);

	/** Filas totales en el servidor. Con fuente local, igual a `rows.length`. */
	total = $state(0);

	/** Borde que se está cargando, o `null`. Una sola petición de ventana a la vez. */
	windowLoading = $state<'up' | 'down' | null>(null);

	/**
	 * Época de la ventana. Sube al recargar: una página pedida antes llega
	 * con datos de otra consulta y se descarta al comparar su época.
	 */
	private windowEpoch = 0;
	private inflight = new Set<AbortController>();

	/*
		Valores por defecto medidos (anexo §11.9): cada desplazamiento reconstruye
		la ventana entera en jspreadsheet, con un coste proporcional a su tamaño.
		300 filas costaban ~60 ms por página —un tirón visible—; 180 cuestan
		~37 ms y quedan por debajo del umbral de tarea larga (50 ms).
	*/
	private get pageSize(): number {
		return this.remote?.pageSize ?? 60;
	}

	private get windowSize(): number {
		return Math.max(this.remote?.windowSize ?? 180, this.pageSize * 2);
	}

	get hasMoreAbove(): boolean {
		this.version;
		return this.windowOffset > 0;
	}

	get hasMoreBelow(): boolean {
		this.version;
		return this.remote !== null && this.windowOffset + this.rows.length - this.lead < this.total;
	}

	private cancelWindowRequests(): void {
		this.windowEpoch++;
		for (const controller of this.inflight) controller.abort();
		this.inflight.clear();
	}

	/** Pide un tramo. `null` si se canceló o quedó obsoleto por una recarga. */
	private async fetchPage(request: { offset: number; limit: number }) {
		const epoch = this.windowEpoch;
		const abort = new AbortController();
		this.inflight.add(abort);
		try {
			const page = await this.remote!.loadPage(request, abort.signal);
			return epoch === this.windowEpoch ? page : null;
		} catch (err) {
			if (abort.signal.aborted) return null;
			throw err;
		} finally {
			this.inflight.delete(abort);
		}
	}

	/**
	 * Amplía la ventana por un borde y recorta el contrario.
	 *
	 * Devuelve cuántas filas entraron y salieron para que la hoja compense el
	 * scroll: si se descartan 100 filas de arriba, el contenido sube 100 filas y
	 * hay que restar su alto a `scrollTop`, o la vista saltaría.
	 *
	 * `null` si no hay nada que cargar, ya hay una carga en curso o la
	 * respuesta llegó obsoleta.
	 */
	async extendWindow(direction: 'up' | 'down'): Promise<WindowShift | null> {
		if (!this.remote || this.windowLoading || this.loading) return null;

		let offset: number;
		let limit: number;
		if (direction === 'down') {
			// Solo cuentan las filas del servidor: las nuevas no ocupan posición.
			offset = this.windowOffset + this.rows.length - this.lead;
			if (offset >= this.total) return null;
			limit = this.pageSize;
		} else {
			if (this.windowOffset === 0) return null;
			offset = Math.max(0, this.windowOffset - this.pageSize);
			limit = this.windowOffset - offset;
		}

		this.windowLoading = direction;
		try {
			const page = await this.fetchPage({ offset, limit });
			if (!page) return null;
			this.total = page.total;

			/*
				Si el servidor cambió entre dos páginas —altas o bajas de otro
				usuario—, los offsets se desplazan y una fila puede llegar dos
				veces. Se descarta la repetida: tenerla dos veces en la ventana
				rompería el índice por clave.
			*/
			const incoming = this.adoptIncoming(page.rows);
			const previousLead = this.rows.slice(0, this.lead);
			const server = this.rows.slice(this.lead);

			let added = 0;
			let removed = 0;
			if (direction === 'down') {
				server.push(...incoming);
				removed = Math.max(0, server.length - this.windowSize);
				const start = this.windowOffset;
				if (removed) server.splice(0, removed).forEach((row, i) => this.releaseRow(row, start + i));
				this.windowOffset += removed;
			} else {
				server.unshift(...incoming);
				this.windowOffset = offset;
				added = incoming.length;
				const trim = Math.max(0, server.length - this.windowSize);
				const first = server.length - trim;
				if (trim) {
					server.splice(first, trim).forEach((row, i) => this.releaseRow(row, this.windowOffset + first + i));
				}
			}

			// Las nuevas entran o salen por arriba según la ventana llegue o deje el inicio.
			const leadDelta = this.composeWindow(server, previousLead);
			this.version++;
			return direction === 'down'
				? { direction, added: 0, removed: removed - leadDelta }
				: { direction, added: added + leadDelta, removed: 0 };
		} catch (err) {
			this.loadError = err instanceof Error ? err.message : 'Error al cargar más filas';
			return null;
		} finally {
			this.windowLoading = null;
		}
	}

	// -- filas retenidas fuera de la ventana (R2, fase 6) -------------------
	//
	// El registro de cambios es por clave: `dirtyCells` dice qué celdas
	// cambiaron y `baseline` el valor anterior. Faltaba el valor nuevo, que vive
	// en la fila; y la fila desaparecía al recortar la ventana. Ahora una fila
	// que aún importa se **retiene** aparte en lugar de descartarse, y al volver
	// a la ventana se reutiliza en vez de la copia del servidor. Así los
	// cambios sobreviven al scroll, y deshacer, rehacer, el panel, la
	// validación y el changeset funcionan sin cargarla. Ver anexo §11.3.

	/** Filas fuera de la ventana con cambios pendientes o referenciadas por el historial. */
	private detached = new Map<string, GridRow>();
	/** Última posición global conocida de cada retenida, para numerarla y volver a ella. */
	private detachedAt = new Map<string, number>();

	// -- altas y bajas con fuente remota (§11.11) ---------------------------

	/** Filas del servidor marcadas como eliminadas: siguen en su posición, tachadas, hasta guardar. */
	private deletedKeys = new Set<string>();

	/**
	 * Filas nuevas, en su orden de la hoja. No ocupan posición del servidor: se
	 * pintan antes de la primera fila cuando la ventana está al inicio.
	 */
	private createdOrder: string[] = [];

	/** Cuántas de las primeras filas de `rows` son nuevas. 0 si la ventana no está al inicio. */
	private lead = 0;

	/** Fila marcada como eliminada (fuente remota): se pinta tachada y no se edita. */
	isDeletedRow(rowKey: string): boolean {
		return this.deletedKeys.has(rowKey);
	}

	/** Fila nueva sin posición en el servidor (fuente remota): se numera con «+». */
	get leadCount(): number {
		this.version;
		return this.lead;
	}

	/**
	 * Recompone `rows` = nuevas (si la ventana está al inicio) + filas del servidor.
	 *
	 * La ventana solo cuenta filas del servidor; las nuevas van aparte para no
	 * descuadrar los offsets. Lejos del inicio, las nuevas quedan retenidas y
	 * vuelven al regresar arriba. Devuelve cuántas nuevas entraron (+) o
	 * salieron (−) por arriba, para compensar el scroll.
	 */
	private composeWindow(
		server: GridRow[] = this.rows.slice(this.lead),
		previousLead: GridRow[] = this.rows.slice(0, this.lead)
	): number {
		const before = previousLead.length;
		const pool = new Map(previousLead.map((r) => [r.__key, r]));
		let lead: GridRow[] = [];
		if (this.windowOffset === 0) {
			for (const key of this.createdOrder) {
				const row = pool.get(key) ?? this.detached.get(key);
				if (!row) continue;
				this.detached.delete(key);
				lead.push(row);
			}
		} else {
			for (const key of this.createdOrder) {
				const row = pool.get(key);
				if (row) this.detached.set(key, row);
			}
			lead = [];
		}
		this.rows = [...lead, ...server];
		this.lead = lead.length;
		this.reindexRows();
		return lead.length - before;
	}

	/** Filas retenidas fuera de la ventana. Solo para depuración y el banco. */
	get detachedCount(): number {
		this.version;
		return this.detached.size;
	}

	/**
	 * Si una fila que sale de la ventana debe retenerse: tiene cambios, es
	 * nueva, o el historial la menciona —deshacer necesita su fila y su valor
	 * original aunque hoy esté limpia—.
	 */
	private mustRetain(key: string): boolean {
		if (this.createdKeys.has(key) || this.deletedKeys.has(key) || this.conflicts.has(key)) return true;
		for (const column of this.columns) if (this.dirtyCells.has(cellId(key, column.field))) return true;
		return this.historyMentions(key);
	}

	/** Saca una fila de la ventana: la retiene si importa y, si no, olvida su estado. */
	private releaseRow(row: GridRow, position: number): void {
		const key = row.__key;
		if (this.mustRetain(key)) {
			this.detached.set(key, row);
			if (!this.createdKeys.has(key)) this.detachedAt.set(key, position);
			return;
		}
		this.baseline.delete(key);
		for (const column of this.columns) this.errors.delete(cellId(key, column.field));
	}

	/**
	 * Convierte una página del servidor en filas de la ventana.
	 *
	 * Si una fila estaba retenida, vuelve **la retenida**, con los cambios del
	 * usuario, no la del servidor. Descarta repetidas (el servidor cambió entre
	 * dos páginas) para no romper el índice por clave.
	 */
	private adoptIncoming(page: Record<string, unknown>[]): GridRow[] {
		const out: GridRow[] = [];
		const seen = new Set<string>();
		for (const raw of page) {
			const fresh = this.toGridRow(raw);
			const key = fresh.__key;
			if (this.rowIndex.has(key) || seen.has(key)) continue;
			seen.add(key);
			const kept = this.detached.get(key);
			if (kept) {
				this.detached.delete(key);
				this.detachedAt.delete(key);
				// Vuelve con cambios pendientes: ¿cambió el remoto mientras tanto?
				this.reconcile(kept, fresh);
				out.push(kept);
			} else {
				this.baseline.set(key, structuredClone(fresh));
				out.push(fresh);
			}
		}
		return out;
	}

	/**
	 * Carga la ventana alrededor de una fila y devuelve su índice en la hoja.
	 *
	 * Para «Ir a la fila» del panel cuando la fila no está cargada (G-1). La
	 * posición sale de `locate()` si la fuente lo implementa —el servidor sabe
	 * dónde está hoy— y si no, de la última posición conocida.
	 */
	async revealRow(key: string): Promise<number | null> {
		const loaded = this.rowIndex.get(key);
		if (loaded !== undefined || !this.remote) return loaded ?? null;
		if (this.windowLoading || this.loading) return null;

		const row = this.detached.get(key);
		// Una fila nueva vive al inicio: basta con llevar la ventana a la posición 0.
		const created = this.createdKeys.has(key);
		let position = created ? 0 : (this.detachedAt.get(key) ?? null);
		const id = row?.[this.idField];
		this.windowLoading = 'down';
		try {
			if (!created && this.remote.locate && id != null) {
				const abort = new AbortController();
				position = (await this.remote.locate(id, abort.signal)) ?? position;
			}
			if (position === null) return null;

			const limit = this.windowSize;
			const offset = Math.max(0, Math.min(position - Math.floor(limit / 2), this.total - limit));
			const page = await this.fetchPage({ offset, limit });
			if (!page) return null;
			this.total = page.total;

			// La ventana actual sale entera; lo que importe queda retenido.
			const previousLead = this.rows.slice(0, this.lead);
			const previous = this.rows.slice(this.lead);
			const previousOffset = this.windowOffset;
			this.rows = [];
			this.rowIndex.clear();
			previous.forEach((r, i) => this.releaseRow(r, previousOffset + i));
			const server = this.adoptIncoming(page.rows);
			this.windowOffset = offset;
			this.composeWindow(server, previousLead);
			this.version++;
			return this.rowIndex.get(key) ?? null;
		} catch (err) {
			this.loadError = err instanceof Error ? err.message : 'No se pudo cargar la fila';
			return null;
		} finally {
			this.windowLoading = null;
		}
	}

	// -- borrador remoto en IndexedDB (G-8, G-9) -----------------------------
	//
	// Con fuente remota el borrador no es una foto de la hoja sino el delta: las
	// filas con algo pendiente, el registro de acciones y su puntero. Se escribe
	// solo lo que cambió desde la última escritura y dura hasta que el usuario
	// guarda o descarta (§11.11).

	/** Filas tocadas desde la última escritura del borrador. */
	private draftKeys = new Set<string>();
	/** `seq` de las acciones que ya están en IndexedDB. */
	private persistedSeqs = new Set<number>();
	/** Escrituras encadenadas: nunca dos transacciones del mismo grid a la vez. */
	private draftWriting: Promise<void> = Promise.resolve();
	/** Puntero de deshacer tal como está en IndexedDB. */
	private persistedCursor = 0;
	/**
	 * Ya se leyó el borrador guardado. Antes de eso no se escribe nada: un
	 * controlador recién creado pisaría el borrador con su estado vacío.
	 */
	private draftReady = false;

	private get draftEnabled(): boolean {
		return this.remote !== null && (this.config.persist ?? 'session') !== 'none';
	}

	/** Qué tiene pendiente una fila, o `null` si nada (su entrada se borra del borrador). */
	private draftStateOf(key: string): DraftRowState | null {
		if (this.deletedKeys.has(key)) return 'deleted';
		if (this.createdKeys.has(key)) return 'created';
		for (const column of this.columns) if (this.dirtyCells.has(cellId(key, column.field))) return 'updated';
		return null;
	}

	// -- contraseñas fuera del borrador (SB-22) ---------------------------------
	//
	// Una contraseña escrita y no guardada no se persiste en el navegador: en su
	// lugar va lo que había (la marca del servidor, o nada en una fila nueva).
	// Al recargar, esa celda vuelve a su estado anterior y hay que escribirla
	// otra vez. Deshacer y rehacer sobre ella, tras recargar, no la cambian.

	private get secretFields(): string[] {
		return this.columns.filter((c) => c.type === 'password').map((c) => c.field);
	}

	private scrubRow(row: GridRow): GridRow {
		const secrets = this.secretFields;
		if (secrets.length === 0) return row;
		const original = this.baseline.get(row.__key);
		const out: GridRow = { ...row };
		for (const field of secrets) out[field] = (original?.[field] ?? null) as CellValue;
		return out;
	}

	private scrubChange(change: HistoryChange): HistoryChange {
		if (change.kind === 'cell') {
			if (!this.secretFields.includes(change.field)) return change;
			const kept = (this.baseline.get(change.rowKey)?.[change.field] ?? null) as CellValue;
			return { ...change, before: kept, after: kept };
		}
		if (change.kind === 'insert' || change.kind === 'delete') return { ...change, row: this.scrubRow(change.row) };
		return change;
	}

	/** Escribe en IndexedDB lo que cambió desde la última vez. */
	private async flushDraft(): Promise<void> {
		if (!this.draftEnabled || !this.draftReady) return;
		const nothingNew =
			this.draftKeys.size === 0 &&
			this.cursor === this.persistedCursor &&
			this.actions.length === this.persistedSeqs.size &&
			this.actions.every((a) => this.persistedSeqs.has(a.seq));
		if (nothingNew) return;
		const gridId = this.config.id;
		const now = new Date().toISOString();

		const upsertRows: DraftRow[] = [];
		const deleteRows: string[] = [];
		for (const key of this.draftKeys) {
			const row = this.getRow(key);
			const state = this.draftStateOf(key);
			if (!row || !state) {
				deleteRows.push(key);
				continue;
			}
			const secrets = this.secretFields;
			const dirty = this.columns
				.filter((c) => this.dirtyCells.has(cellId(key, c.field)) && !secrets.includes(c.field))
				.map((c) => c.field);
			upsertRows.push({
				gridId,
				rowKey: key,
				id: row[this.idField] ?? null,
				state,
				current: this.scrubRow(row),
				original: state === 'created' ? null : (this.baseline.get(key) ?? null),
				dirty,
				rowVersion: (row.__version ?? null) as CellValue,
				position: state === 'created' ? null : this.positionOf(key),
				order: state === 'created' ? this.createdOrder.indexOf(key) : null,
				updatedAt: now
			});
		}
		this.draftKeys.clear();

		const current = new Set(this.actions.map((a) => a.seq));
		const putActions = this.actions
			.filter((a) => !this.persistedSeqs.has(a.seq))
			.map((a) => ({ gridId, seq: a.seq, changes: a.changes.map((c) => this.scrubChange(c)) }));
		const deleteActions = [...this.persistedSeqs].filter((seq) => !current.has(seq));
		this.persistedSeqs = current;
		this.persistedCursor = this.cursor;

		const write = {
			upsertRows,
			deleteRows,
			putActions,
			deleteActions,
			meta: {
				gridId,
				format: DRAFT_FORMAT,
				savedAt: now,
				cursor: this.cursor,
				labels: [...this.labelCache.entries()],
				owner: null
			}
		};
		this.draftWriting = this.draftWriting
			.then(() => writeDraft(gridId, write))
			.catch((err) => console.error('[datagrid] no se pudo guardar el borrador', err));
		await this.draftWriting;
		this.lastSavedAt = now;
	}

	/** Escribe ya lo pendiente, sin esperar al agrupado de 300 ms. */
	private async flushDraftNow(): Promise<void> {
		clearTimeout(this.persistTimer);
		await this.flushDraft();
	}

	/** Olvida el borrador en memoria y en IndexedDB: al guardar o descartar. */
	private async dropDraft(): Promise<void> {
		clearTimeout(this.persistTimer);
		this.draftKeys.clear();
		this.persistedSeqs.clear();
		this.persistedCursor = 0;
		if (!this.draftEnabled) return;
		this.draftWriting = this.draftWriting.then(() => clearDraft(this.config.id)).catch(() => {});
		await this.draftWriting;
	}

	/**
	 * Repone un borrador sobre la primera página recién cargada.
	 *
	 * Una fila del borrador que está en la página sustituye a la del servidor;
	 * la que no, queda retenida con su última posición; las nuevas vuelven a su
	 * lista. Después se recalculan sucias y errores, y se recupera el historial
	 * con su puntero: ⌘Z sigue funcionando tras el refresco.
	 */
	private applyDraft(draft: Draft): void {
		draft.meta?.labels.forEach(([k, v]) => this.labelCache.set(k, v));
		const created: DraftRow[] = [];
		// Filas del borrador que llegaron en la página: se comparan con su versión remota.
		const fresh: [GridRow, GridRow][] = [];
		for (const entry of draft.rows) {
			const key = entry.rowKey;
			if (entry.original) this.baseline.set(key, entry.original);
			if (entry.state === 'created') {
				this.createdKeys.add(key);
				this.detached.set(key, entry.current);
				created.push(entry);
				continue;
			}
			const at = this.rowIndex.get(key);
			if (at !== undefined) {
				fresh.push([entry.current, this.rows[at]]);
				this.rows[at] = entry.current;
			} else {
				this.detached.set(key, entry.current);
				if (entry.position !== null) this.detachedAt.set(key, entry.position);
			}
			if (entry.state === 'deleted') this.deletedKeys.add(key);
		}
		this.createdOrder = created.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((e) => e.rowKey);
		this.composeWindow();
		for (const entry of draft.rows) {
			const row = this.getRow(entry.rowKey);
			if (row) this.refreshRow(row);
		}
		// Misma regla que el servidor (§11.14): si otro cambió la fila, combinar o marcar conflicto.
		for (const [row, remote] of fresh) this.reconcile(row, remote);

		this.actions = draft.actions.map((a) => ({ seq: a.seq, changes: a.changes as HistoryChange[] }));
		this.cursor = Math.min(draft.meta?.cursor ?? this.actions.length, this.actions.length);
		this.actionSeq = this.actions.reduce((max, a) => Math.max(max, a.seq), 0);
		this.persistedSeqs = new Set(this.actions.map((a) => a.seq));
		this.persistedCursor = this.cursor;
		this.historyVersion++;
		this.lastSavedAt = draft.meta?.savedAt ?? null;
	}

	/** Reemplaza rows y baseline con lo que devolvió el servidor. */
	private adoptServerRows(raw: Record<string, unknown>[]) {
		this.conflicts.clear();
		this.detached.clear();
		this.detachedAt.clear();
		this.deletedKeys.clear();
		this.createdOrder = [];
		this.lead = 0;
		this.rows = raw.map((r) => this.toGridRow(r));
		this.reindexRows();
		this.baseline = new Map(this.rows.map((r) => [r.__key, structuredClone(r)]));
		this.dirtyCells.clear();
		this.createdKeys.clear();
		this.deletedRows = [];
		this.errors.clear();
		// Los datos de partida son otros: deshacer hacia el estado anterior
		// produciría filas que ya no existen en el servidor.
		this.clearHistory();
	}

	private toGridRow(raw: Record<string, unknown>): GridRow {
		const id = raw[this.idField];
		const row: GridRow = { __key: id != null ? String(id) : nextKey() };
		for (const column of this.columns) {
			const type = getCellType(column.type);
			row[column.field] = type.parse(raw[column.field], column);
		}
		row[this.idField] = id ?? null;
		// Testigo de modificación del servidor, si lo envía: lo necesitan el borrador y R3.
		if (raw.rowVersion !== undefined) row.__version = raw.rowVersion;
		return row;
	}

	/** Intenta rehidratar cambios pendientes guardados localmente. */
	tryRestore(): boolean {
		// La fuente remota restaura dentro de `load()`: necesita la primera página antes.
		if (this.remote) return false;
		const store = this.storage();
		if (!store) return false;
		const rawState = store.getItem(STORAGE_PREFIX + this.config.id);
		if (!rawState) return false;
		try {
			const parsed = JSON.parse(rawState) as PersistedState;
			if (parsed.v !== STORAGE_VERSION) return false;
			this.rows = parsed.rows;
			this.reindexRows();
			this.baseline = new Map(parsed.baseline);
			this.dirtyCells = new Set(parsed.dirty);
			this.createdKeys = new Set(parsed.created);
			this.deletedRows = parsed.deleted;
			parsed.labels.forEach(([k, v]) => this.labelCache.set(k, v));
			this.validateAll();
			this.restoredFromStorage = true;
			this.lastSavedAt = parsed.savedAt;
			this.version++;
			return true;
		} catch {
			this.clearStorage();
			return false;
		}
	}

	private storage(): Storage | null {
		const mode = this.config.persist ?? 'session';
		if (mode === 'none' || typeof window === 'undefined') return null;
		return mode === 'local' ? window.localStorage : window.sessionStorage;
	}

	private schedulePersist() {
		clearTimeout(this.persistTimer);
		this.persistTimer = setTimeout(() => {
			if (this.remote) void this.flushDraft();
			else this.persist();
		}, 300);
	}

	private persist() {
		// La fuente remota guarda su borrador en IndexedDB (`flushDraft`).
		if (this.remote) return;
		const store = this.storage();
		if (!store) return;
		if (!this.hasPendingChanges) {
			this.clearStorage();
			return;
		}
		const payload: PersistedState = {
			v: STORAGE_VERSION,
			rows: this.rows.map((r) => this.scrubRow(r)),
			baseline: [...this.baseline.entries()],
			dirty: [...this.dirtyCells],
			created: [...this.createdKeys],
			deleted: this.deletedRows,
			labels: [...this.labelCache.entries()],
			savedAt: new Date().toISOString()
		};
		try {
			store.setItem(STORAGE_PREFIX + this.config.id, JSON.stringify(payload));
			this.lastSavedAt = payload.savedAt;
		} catch {
			// Cuota agotada: no es fatal, solo se pierde la recuperación ante refresh.
		}
	}

	/** Borra el borrador guardado: `sessionStorage`/`localStorage` en local, IndexedDB en remota. */
	clearStorage() {
		if (this.remote) void this.dropDraft();
		else this.storage()?.removeItem(STORAGE_PREFIX + this.config.id);
		this.lastSavedAt = null;
	}

	// -- edición ------------------------------------------------------------

	/** Aplica el valor crudo que produjo jspreadsheet en una celda. */
	setCellValue(rowIndex: number, field: string, rawValue: unknown): void {
		const row = this.rows[rowIndex];
		if (row) this.setRowValue(row, field, rawValue);
	}

	/**
	 * Igual que `setCellValue`, pero por clave: sirve para una fila retenida
	 * fuera de la ventana, que no tiene índice en la hoja. Lo usa el panel de
	 * cambios para editar sin tener que cargar la fila.
	 */
	setCellValueByKey(rowKey: string, field: string, rawValue: unknown): void {
		const row = this.getRow(rowKey);
		if (row) this.setRowValue(row, field, rawValue);
	}

	private setRowValue(row: GridRow, field: string, rawValue: unknown): void {
		const at = this.columnIndex.get(field);
		const column = at === undefined ? undefined : this.columns[at];
		// Una fila eliminada o en conflicto no se edita: ni teclado, ni pegar, ni borrar rangos.
		if (!column || this.deletedKeys.has(row.__key) || this.conflicts.has(row.__key)) return;

		const value = getCellType(column.type).parse(rawValue, column);
		this.record({
			kind: 'cell',
			rowKey: row.__key,
			field,
			before: (row[field] ?? null) as CellValue,
			after: value
		});
		row[field] = value;
		this.refreshDirty(row, column);
		/*
			Un validador a nivel de fila (`column.validate` recibe la fila entera) ve
			otras celdas: con él, validar solo la celda editada dejaría a las demás
			desactualizadas al editar una de las relacionadas.
		*/
		if (this.hasRowValidators) this.validateRow(row);
		else this.validateCell(row, column);
		this.touch();
	}

	/**
	 * Recalcula si una celda está sucia: su valor contra el del servidor.
	 *
	 * Es la única regla de «sucio», y por eso deshacer no necesita guardar qué
	 * celdas lo estaban: tras reponer el valor se vuelve a preguntar. En una fila
	 * nueva no hay baseline: la fila entera cuenta como creada, no como editada.
	 */
	private refreshDirty(row: GridRow, column: ColumnDef): void {
		const id = cellId(row.__key, column.field);
		const base = this.baseline.get(row.__key);
		const type = getCellType(column.type);
		const equals = type.equals ?? ((a, b) => a === b);
		const value = (row[column.field] ?? null) as never;
		if (this.createdKeys.has(row.__key) || !base || equals(value, (base[column.field] ?? null) as never)) {
			this.dirtyCells.delete(id);
		} else {
			this.dirtyCells.add(id);
		}
	}

	/** Estado derivado de una fila completa: sucias y, después, errores. */
	private refreshRow(row: GridRow): void {
		for (const column of this.columns) this.refreshDirty(row, column);
		// Validar después de marcar sucias: la validación distingue lo intacto del servidor.
		this.validateRow(row);
	}

	insertRows(atIndex: number, count = 1): GridRow[] {
		if (this.remote) return this.insertRemoteRows(count);
		const created: GridRow[] = [];
		const start = Math.max(0, Math.min(atIndex, this.rows.length));
		// Varias filas de una vez son una sola acción: un ⌘Z las quita todas.
		this.transaction(() => {
			for (let i = 0; i < count; i++) {
				const row: GridRow = { __key: nextKey() };
				for (const column of this.columns) {
					const dv = column.defaultValue;
					row[column.field] = typeof dv === 'function' ? dv() : (dv ?? null);
				}
				row[this.idField] = null;
				created.push(row);
				this.createdKeys.add(row.__key);
				this.record({ kind: 'insert', rowKey: row.__key, at: start + i, row: { ...row } });
			}
		});
		this.rows.splice(start, 0, ...created);
		// Insertar desplaza a todas las filas posteriores: el índice caduca entero.
		this.reindexRows();
		created.forEach((row) => this.validateRow(row));
		this.touch();
		return created;
	}

	private newRow(): GridRow {
		const row: GridRow = { __key: nextKey() };
		for (const column of this.columns) {
			const dv = column.defaultValue;
			row[column.field] = typeof dv === 'function' ? dv() : (dv ?? null);
		}
		row[this.idField] = null;
		return row;
	}

	/**
	 * Altas con fuente remota: siempre al inicio de la hoja (G-2), en la lista
	 * de nuevas y no en la ventana, para no descuadrar sus offsets (§11.11). Si
	 * la ventana está lejos del inicio quedan retenidas; la hoja lleva al
	 * usuario arriba para que las rellene.
	 */
	private insertRemoteRows(count: number): GridRow[] {
		const created: GridRow[] = [];
		this.transaction(() => {
			for (let i = 0; i < count; i++) {
				const row = this.newRow();
				created.push(row);
				this.createdKeys.add(row.__key);
				this.createdOrder.splice(i, 0, row.__key);
				this.detached.set(row.__key, row);
				this.record({ kind: 'insert', rowKey: row.__key, at: i, row: { ...row } });
			}
		});
		this.composeWindow();
		created.forEach((row) => this.validateRow(row));
		this.touch();
		return created;
	}

	/**
	 * Bajas con fuente remota. Una fila nueva desaparece; una del servidor se
	 * **marca** y sigue en su posición, tachada, hasta guardar (G-7). Antes de
	 * marcarla se revierten sus ediciones —lo que se va a guardar es el borrado,
	 * no los cambios—; deshacer la baja las repone.
	 */
	private removeRemoteRows(indexes: number[]): void {
		const targets = [...new Set(indexes)].map((i) => this.rows[i]).filter((r): r is GridRow => !!r);
		// Nuevas de mayor a menor posición en su lista: cada `at` sigue siendo válido al quitarlas.
		const created = targets
			.filter((r) => this.createdKeys.has(r.__key))
			.sort((a, b) => this.createdOrder.indexOf(b.__key) - this.createdOrder.indexOf(a.__key));
		const server = targets.filter((r) => !this.createdKeys.has(r.__key) && !this.deletedKeys.has(r.__key));

		this.transaction(() => {
			for (const row of created) {
				const key = row.__key;
				const at = this.createdOrder.indexOf(key);
				this.record({ kind: 'delete', rowKey: key, at, row: { ...row }, created: true });
				this.createdOrder.splice(at, 1);
				this.createdKeys.delete(key);
				this.forgetRowState(key);
			}
			for (const row of server) {
				const key = row.__key;
				const base = this.baseline.get(key);
				for (const column of this.columns) {
					if (!base || !this.dirtyCells.has(cellId(key, column.field))) continue;
					const original = (base[column.field] ?? null) as CellValue;
					this.record({ kind: 'cell', rowKey: key, field: column.field, before: (row[column.field] ?? null) as CellValue, after: original });
					row[column.field] = original;
				}
				this.record({ kind: 'mark', rowKey: key, before: false, after: true });
				this.deletedKeys.add(key);
				this.forgetRowState(key);
			}
		});
		if (created.length) this.composeWindow();
		this.touch();
	}

	removeRowsAt(indexes: number[]): void {
		if (this.remote) return this.removeRemoteRows(indexes);
		/*
			De mayor a menor: así cada índice sigue siendo válido tras borrar los
			posteriores, y cada baja registra la posición exacta en que estaba.
			Deshacer las repone al revés —de menor a mayor— y el orden queda igual.
		*/
		const sorted = [...indexes].sort((a, b) => b - a);
		this.transaction(() => {
			for (const index of sorted) {
				const row = this.rows[index];
				if (!row) continue;
				const created = this.createdKeys.has(row.__key);
				this.record({ kind: 'delete', rowKey: row.__key, at: index, row: { ...row }, created });
				// Una fila creada y borrada antes de guardar simplemente desaparece.
				if (created) this.createdKeys.delete(row.__key);
				else this.deletedRows.push({ key: row.__key, id: row[this.idField] ?? null, row });
				this.forgetRowState(row.__key);
				this.rows.splice(index, 1);
			}
		});
		this.reindexRows();
		this.touch();
	}

	// -- validación ---------------------------------------------------------

	private validateCell(row: GridRow, column: ColumnDef): void {
		const type = getCellType(column.type);
		const value = (row[column.field] ?? null) as never;
		const id = cellId(row.__key, column.field);

		// Una celda intacta de una fila existente conserva el valor que envió
		// el servidor: se considera confiable aunque el cliente no pueda
		// resolverlo contra su catálogo local.
		const ctx: ValidationContext = {
			labelCache: this.labelCache,
			fromServer: !this.dirtyCells.has(id) && !this.createdKeys.has(row.__key)
		};

		const message =
			type.validate(value, column, row, ctx) ?? column.validate?.(value, row, column) ?? null;
		if (message) this.errors.set(id, message);
		else this.errors.delete(id);
	}

	private validateRow(row: GridRow): void {
		// Una fila marcada como eliminada no se va a guardar: no puede bloquear el guardado.
		if (this.deletedKeys.has(row.__key)) return this.forgetRowState(row.__key);
		this.columns.forEach((column) => this.validateCell(row, column));
	}

	validateAll(): void {
		this.errors.clear();
		this.rows.forEach((row) => this.validateRow(row));
		// Las retenidas fuera de la ventana también se guardan: deben validarse.
		this.detached.forEach((row) => this.validateRow(row));
		this.version++;
	}

	// -- persistencia remota ------------------------------------------------

	buildChangeSet(): ChangeSet {
		// `__key` es identidad interna del grid: no debe viajar al backend.
		const strip = (row: GridRow): GridRow => {
			const { __key, ...rest } = row;
			return rest as GridRow;
		};

		const creates = [...this.rows, ...this.detached.values()]
			.filter((r) => this.createdKeys.has(r.__key))
			.map(strip);

		const updates: ChangeSet['updates'] = [];
		const touchedKeys = new Set([...this.dirtyCells].map((id) => splitCellId(id)[0]));
		for (const key of touchedKeys) {
			const row = this.getRow(key);
			if (!row) continue;
			const changes: Record<string, never> = {};
			for (const column of this.columns) {
				if (this.dirtyCells.has(cellId(key, column.field))) {
					changes[column.field] = (row[column.field] ?? null) as never;
				}
			}
			updates.push({ key, id: row[this.idField] ?? null, changes, row: { ...row } });
		}

		const marked = [...this.deletedKeys].flatMap((key) => {
			const row = this.getRow(key);
			return row ? [{ key, id: row[this.idField] ?? null, row: { ...row } }] : [];
		});
		return { creates, updates, deletes: [...this.deletedRows, ...marked] };
	}

	async save(): Promise<SaveResult> {
		this.validateAll();
		if (this.errors.size > 0) {
			return { status: 'invalid', issues: this.errorList };
		}
		const source = this.config.dataSource;
		if (isRemoteSource(source)) return this.saveRemote();
		if (!source.save) {
			return { status: 'error', message: 'Esta grilla no tiene una operación de guardado configurada.' };
		}
		if (!this.hasPendingChanges) {
			return { status: 'noop' };
		}

		const changeSet = this.buildChangeSet();
		const summary = {
			creates: changeSet.creates.length,
			updates: changeSet.updates.length,
			deletes: changeSet.deletes.length
		};

		this.saving = true;
		try {
			await source.save(changeSet);
			// Rebase: lo que hay en pantalla se vuelve la nueva verdad.
			await this.load();
			return { status: 'ok', summary };
		} catch (err) {
			return {
				status: 'error',
				message: err instanceof Error ? err.message : 'Error desconocido al guardar'
			};
		} finally {
			this.saving = false;
			this.version++;
		}
	}

	// -- guardado remoto (R3, §11.13–§11.14) ---------------------------------

	/**
	 * Filas en conflicto tras guardar, por clave. Esperan que el usuario decida
	 * y **no se reenvían** hasta entonces: con la versión vieja volverían a
	 * chocar. Mientras tanto son de solo lectura.
	 */
	private conflicts = new Map<
		string,
		{
			op: 'update' | 'delete';
			reason: ConflictReason;
			fields: { field: string; from: unknown; yours: unknown; remote: unknown; choice?: 'mine' | 'remote' }[];
			remote: GridRow | null;
		}
	>();

	/**
	 * Último intento fallido por red o servidor: su lote y su llave. Si el
	 * siguiente Guardar manda el mismo lote, reutiliza la llave (G-12) y el
	 * servidor no lo aplica dos veces aunque el primero sí hubiera llegado.
	 */
	private failedAttempt: { body: string; key: string } | null = null;

	/**
	 * Avisos del último guardado: filas combinadas con cambios ajenos en otros
	 * campos. Los muestra el modal del guardado; el siguiente guardado los reemplaza.
	 */
	lastMerges = $state<MergeNotice[]>([]);

	/**
	 * Celdas que acaban de llegar del remoto al combinar, para resaltarlas un
	 * momento en la hoja: el usuario debe ver qué cambió sin buscarlo.
	 */
	private mergedCells = new Set<string>();
	/** Combinadas del último guardado, esperando a que el usuario cierre el modal para resaltarlas. */
	private pendingMerged = new Set<string>();
	private mergedTimer: ReturnType<typeof setTimeout> | undefined;
	/** Cuánto dura el resaltado de lo combinado. */
	static readonly MERGE_HIGHLIGHT_MS = 6000;

	isMergedCell(rowKey: string, field: string): boolean {
		return this.mergedCells.has(cellId(rowKey, field));
	}

	/**
	 * Enciende el resaltado de lo combinado. Se llama al cerrar el modal del
	 * guardado, no al guardar: si empezara antes, se apagaría detrás del modal
	 * sin que el usuario lo viera.
	 */
	revealMerges(): void {
		if (this.pendingMerged.size === 0) return;
		clearTimeout(this.mergedTimer);
		this.mergedCells = this.pendingMerged;
		this.pendingMerged = new Set();
		this.mergedTimer = setTimeout(() => {
			this.mergedCells.clear();
			this.version++;
		}, GridController.MERGE_HIGHLIGHT_MS);
		this.version++;
	}

	isConflictRow(rowKey: string): boolean {
		return this.conflicts.has(rowKey);
	}

	/** Conflicto de una celda concreta: para marcarla en la hoja con su tooltip. */
	cellConflict(rowKey: string, field: string): { yours: string; remote: string } | null {
		const conflict = this.conflicts.get(rowKey);
		if (!conflict) return null;
		const column = this.columns[this.columnIndex.get(field) ?? -1];
		if (!column) return null;
		if (conflict.reason !== 'field_conflict') return { yours: '', remote: '' };
		const f = conflict.fields.find((c) => c.field === field);
		if (!f) return null;
		return {
			yours: this.formatValue(column, f.yours as CellValue),
			remote: this.formatValue(column, f.remote as CellValue)
		};
	}

	get conflictCount(): number {
		this.version;
		return this.conflicts.size;
	}

	/** Columnas que el servidor acepta del cliente: ni de solo lectura ni de acción. */
	private get writableColumns(): ColumnDef[] {
		return this.columns.filter((c) => !c.readOnly && c.type !== 'action' && c.field !== this.idField);
	}

	/** Arma el lote con lo pendiente, sin las filas en conflicto. */
	private buildBatch(): BatchRequest {
		const pending = (key: string) => !this.conflicts.has(key);
		const creates = this.createdOrder
			.filter((key) => this.createdKeys.has(key) && pending(key))
			.flatMap((key) => {
				const row = this.getRow(key);
				if (!row) return [];
				const values = Object.fromEntries(this.writableColumns.map((c) => [c.field, row[c.field] ?? null]));
				return [{ key, values }];
			});
		// Fuente remota sin lista de nuevas (no debería pasar): cualquier creada pendiente.
		for (const key of this.createdKeys) {
			if (!pending(key) || creates.some((c) => c.key === key)) continue;
			const row = this.getRow(key);
			if (row) creates.push({ key, values: Object.fromEntries(this.writableColumns.map((c) => [c.field, row[c.field] ?? null])) });
		}

		const updates: BatchRequest['updates'] = [];
		for (const key of this.grouped().dirty.keys()) {
			if (!pending(key) || this.createdKeys.has(key) || this.deletedKeys.has(key)) continue;
			const row = this.getRow(key);
			const base = this.baseline.get(key);
			if (!row || !base) continue;
			const changes: BatchRequest['updates'][number]['changes'] = {};
			// Lo que se leyó en las escribibles que no se tocaron: con esto el
			// servidor sabe qué cambió otro usuario (avisos de `merge`, SB-16).
			const untouched: Record<string, unknown> = {};
			for (const column of this.writableColumns) {
				if (this.dirtyCells.has(cellId(key, column.field))) {
					changes[column.field] = { from: base[column.field] ?? null, to: row[column.field] ?? null };
				} else {
					untouched[column.field] = base[column.field] ?? null;
				}
			}
			updates.push({ id: row[this.idField], rowVersion: row.__version ?? null, changes, base: untouched });
		}

		const deletes = [...this.deletedKeys].filter(pending).flatMap((key) => {
			const row = this.getRow(key);
			return row ? [{ id: row[this.idField], rowVersion: row.__version ?? null }] : [];
		});
		return { creates, updates, deletes };
	}

	/** Log de depuración (`config.debug`): un grupo plegable por evento en la consola. */
	private debug(title: string, details: Record<string, unknown>): void {
		if (!this.config.debug) return;
		console.groupCollapsed(`[datagrid:${this.config.id}] ${title}`);
		for (const [label, value] of Object.entries(details)) console.log(label, value);
		console.groupEnd();
	}

	private async saveRemote(): Promise<SaveResult> {
		const remote = this.remote!;
		if (!remote.saveBatch) {
			return { status: 'error', message: 'Esta grilla no tiene una operación de guardado configurada.' };
		}
		const batch = this.buildBatch();
		if (batch.creates.length + batch.updates.length + batch.deletes.length === 0) {
			return this.conflicts.size > 0
				? { status: 'error', message: 'Solo quedan filas en conflicto: resuélvelas en el panel de cambios antes de guardar.' }
				: { status: 'noop' };
		}

		const body = JSON.stringify(batch);
		const reused = this.failedAttempt?.body === body;
		const key = reused ? this.failedAttempt!.key : crypto.randomUUID();
		this.debug(`guardar → ${batch.updates.length} edit · ${batch.creates.length} alta · ${batch.deletes.length} baja`, {
			'Idempotency-Key': `${key}${reused ? ' (reutilizada: reintento del mismo lote)' : ''}`,
			ediciones: batch.updates.map((u) => ({ id: u.id, leida: `v${u.rowVersion}`, cambios: u.changes })),
			altas: batch.creates,
			bajas: batch.deletes,
			'en conflicto (no se envían)': [...this.conflicts.keys()]
		});
		this.saving = true;
		try {
			const response = await remote.saveBatch(batch, key);
			// El detalle de avisos y conflictos va en el título: visible sin desplegar el grupo.
			const merged = response.notices.map((n) => `${n.id}: ${n.fields.join(', ')}`).join(' · ');
			const clashed = response.conflicts.map((c) => `${c.id} (${c.reason})`).join(' · ');
			this.debug(
				`respuesta ← ${response.updated.length} aplicada · ${response.created.length} creada · ${response.deleted.length} eliminada` +
					(merged ? ` · COMBINADA con cambios ajenos → ${merged}` : '') +
					(clashed ? ` · CONFLICTO → ${clashed}` : ''),
				{
					aplicadas: response.updated.map((r) => `${r[this.idField]} → v${r.rowVersion}`),
					creadas: response.created.map((c) => `${c.key} → ${c.row[this.idField]}`),
					eliminadas: response.deleted,
					'avisos (otro cambió otros campos; se conservan)': response.notices,
					conflictos: response.conflicts,
					respuesta: response
				}
			);
			this.failedAttempt = null;
			this.applyBatch(batch, response);
			return {
				status: 'ok',
				summary: {
					creates: response.created.length,
					updates: response.updated.length,
					deletes: response.deleted.length,
					conflicts: response.conflicts.length,
					notices: response.notices.length
				}
			};
		} catch (err) {
			// Red o servidor: el mismo lote reintentará con la misma llave.
			this.failedAttempt = { body, key };
			this.debug('guardar falló (el reintento usará la misma llave)', { error: err, key });
			return { status: 'error', message: err instanceof Error ? err.message : 'Error desconocido al guardar' };
		} finally {
			this.saving = false;
			this.version++;
		}
	}

	/**
	 * Aplica la respuesta del servidor **sin recargar** (G-13): las filas
	 * guardadas toman lo que devolvió el servidor como nueva verdad, las
	 * eliminadas salen de la hoja, las nuevas reciben su id real y lo que entró
	 * en conflicto queda marcado para resolver. Scroll, selección y ventana no
	 * se tocan.
	 *
	 * Si el usuario siguió editando mientras la petición viajaba, esas ediciones
	 * se respetan: solo se sobrescribe un campo si sigue teniendo el valor que
	 * se envió, o si nadie lo tocó.
	 */
	private applyBatch(sent: BatchRequest, response: BatchResponse): void {
		const sentUpdates = new Map(sent.updates.map((u) => [String(u.id), u.changes]));

		for (const { key, row: raw } of response.created) {
			const local = this.getRow(key);
			const fresh = this.toGridRow(raw);
			const newKey = fresh.__key;
			this.createdKeys.delete(key);
			this.forgetRowState(key);
			this.draftKeys.add(key);
			if (!local) continue;
			// La fila en pantalla pasa a ser la del servidor: mismo objeto, clave e id reales.
			Object.assign(local, fresh);
			this.createdOrder = this.createdOrder.map((k) => (k === key ? newKey : k));
			if (this.detached.delete(key)) this.detached.set(newKey, local);
			this.baseline.set(newKey, structuredClone(fresh));
			this.total++;
		}

		for (const raw of response.updated) {
			const fresh = this.toGridRow(raw);
			const key = fresh.__key;
			const row = this.getRow(key);
			const oldBase = this.baseline.get(key);
			if (!row) continue;
			const sentChanges = sentUpdates.get(key) ?? {};
			for (const column of this.columns) {
				const field = column.field;
				const sentChange = sentChanges[field];
				const untouched = sentChange ? same(row[field], sentChange.to) : same(row[field], oldBase?.[field]);
				if (untouched) row[field] = fresh[field];
			}
			row.__version = fresh.__version;
			this.baseline.set(key, structuredClone(fresh));
			this.refreshRow(row);
			this.draftKeys.add(key);
		}

		for (const id of response.deleted) {
			const key = String(id);
			const at = this.rowIndex.get(key);
			// Sale de la hoja: el servidor ya no la tiene, así que las posiciones siguientes bajan una.
			if (at !== undefined) this.rows.splice(at, 1);
			this.detached.delete(key);
			this.detachedAt.delete(key);
			this.deletedKeys.delete(key);
			this.baseline.delete(key);
			this.forgetRowState(key);
			this.draftKeys.add(key);
			this.total = Math.max(0, this.total - 1);
		}

		// Avisos: qué cambió el otro usuario, ya con el valor que quedó en la fila.
		this.pendingMerged = new Set();
		this.lastMerges = response.notices.flatMap((n) => {
			const key = String(n.id);
			const row = this.getRow(key);
			if (!row) return [];
			const fields = n.fields.flatMap((field) => {
				const column = this.columns[this.columnIndex.get(field) ?? -1];
				if (!column) return [];
				this.pendingMerged.add(cellId(key, field));
				return [{ field, label: column.label, valueText: this.formatValue(column, row[field] as CellValue) }];
			});
			return [{ rowKey: key, id: n.id, position: this.positionOf(key), fields }];
		});

		for (const c of response.conflicts) {
			const key = String(c.id);
			this.conflicts.set(key, {
				op: c.op,
				reason: c.reason,
				fields: (c.fields ?? []).map((f) => ({ ...f })),
				remote: c.remote ? this.toGridRow(c.remote) : null
			});
			this.draftKeys.add(key);
		}

		this.reindexRows();
		// Lo guardado ya no se puede deshacer: sus originales cambiaron.
		this.clearHistory();
		this.touch();
	}

	/**
	 * Resuelve un conflicto (G-17). `field` limita la elección a un campo de un
	 * `field_conflict`; sin él se aplica a toda la fila. La fila vuelve a ser
	 * pendiente normal —o limpia— con la versión remota, lista para guardarse.
	 *
	 * Según el motivo, `mine` y `remote` significan:
	 * - `field_conflict`: conservar tu valor o tomar el remoto, por campo.
	 * - `version_mismatch` en edición (política estricta): rehacer tus cambios
	 *   sobre la versión remota, o descartarlos.
	 * - `version_mismatch` en baja: eliminar de todos modos, o cancelar la baja.
	 * - `not_found`: recrear la fila como nueva, o descartar tus cambios.
	 */
	resolveConflict(rowKey: string, choice: 'mine' | 'remote', field?: string): void {
		const conflict = this.conflicts.get(rowKey);
		if (!conflict) return;

		if (conflict.reason === 'field_conflict') {
			for (const f of conflict.fields) if (!field || f.field === field) f.choice = choice;
			if (conflict.fields.some((f) => !f.choice)) return this.touch();
		}
		this.conflicts.delete(rowKey);
		this.draftKeys.add(rowKey);
		const row = this.getRow(rowKey);
		const remote = conflict.remote;

		if (conflict.reason === 'not_found' || !remote) {
			if (!row) return this.touch();
			this.removeFromSheet(rowKey);
			if (choice === 'mine') {
				// Recrear: vuelve como fila nueva al inicio, sin id.
				row[this.idField] = null;
				delete row.__version;
				this.createdKeys.add(rowKey);
				this.createdOrder.unshift(rowKey);
				this.detached.set(rowKey, row);
				this.composeWindow();
				this.validateRow(row);
			}
			return this.touch();
		}

		if (!row) return this.touch();
		// Tu valor por campo: en `field_conflict`, lo elegido; en los demás, «mine» conserva lo tuyo.
		const keepMine = (field: string) => {
			if (conflict.reason === 'field_conflict') {
				const f = conflict.fields.find((c) => c.field === field);
				if (f) return f.choice === 'mine';
			}
			return choice === 'mine' && this.dirtyCells.has(cellId(rowKey, field));
		};
		if (conflict.op === 'delete') {
			if (choice === 'remote') this.deletedKeys.delete(rowKey);
			for (const column of this.columns) row[column.field] = remote[column.field];
		} else {
			for (const column of this.columns) {
				if (!keepMine(column.field)) row[column.field] = remote[column.field];
			}
		}
		row.__version = remote.__version;
		this.baseline.set(rowKey, structuredClone(remote));
		this.refreshRow(row);
		this.touch();
	}

	/** Quita una fila de la hoja y de las retenidas (el servidor ya no la tiene). */
	private removeFromSheet(key: string): void {
		const at = this.rowIndex.get(key);
		if (at !== undefined && at >= this.lead) {
			this.rows.splice(at, 1);
			this.total = Math.max(0, this.total - 1);
		}
		this.detached.delete(key);
		this.detachedAt.delete(key);
		this.deletedKeys.delete(key);
		this.baseline.delete(key);
		this.forgetRowState(key);
		this.reindexRows();
	}

	/**
	 * Reconciliación con la versión remota de una fila con cambios (§11.14,
	 * «al recargar, en el front»). La misma regla que aplica el servidor: un
	 * campo que cambiaste y que el remoto también cambió, a otro valor, es
	 * conflicto; un campo que solo cambió el remoto se adopta y tu cambio sigue
	 * pendiente sobre la versión nueva.
	 */
	private reconcile(row: GridRow, fresh: GridRow): void {
		const key = row.__key;
		if (fresh.__version === undefined || fresh.__version === row.__version) return;
		if (this.createdKeys.has(key)) return;
		const base = this.baseline.get(key);
		if (!base) return;

		if (this.deletedKeys.has(key)) {
			this.conflicts.set(key, { op: 'delete', reason: 'version_mismatch', fields: [], remote: fresh });
			this.debug(`reconciliar ${key}: CONFLICTO (eliminada aquí, editada remota)`, {
				tuya: `v${row.__version}`,
				remota: `v${fresh.__version}`
			});
			return;
		}
		const adopted: string[] = [];
		const clashes: { field: string; from: unknown; yours: unknown; remote: unknown }[] = [];
		for (const column of this.columns) {
			const field = column.field;
			const mine = this.dirtyCells.has(cellId(key, field));
			const remoteChanged = !same(fresh[field], base[field]);
			if (!remoteChanged) continue;
			if (mine && !same(fresh[field], row[field])) {
				clashes.push({ field, from: base[field] ?? null, yours: row[field] ?? null, remote: fresh[field] ?? null });
			} else if (!mine) {
				row[field] = fresh[field];
				adopted.push(field);
			}
		}
		this.debug(
			`reconciliar ${key}: ${clashes.length ? 'CONFLICTO' : 'combinada'} (tuya v${row.__version}, remota v${fresh.__version})`,
			{ 'adoptados del remoto': adopted, conflictos: clashes }
		);
		if (clashes.length > 0) {
			this.conflicts.set(key, { op: 'update', reason: 'field_conflict', fields: clashes, remote: fresh });
			return;
		}
		row.__version = fresh.__version;
		this.baseline.set(key, structuredClone(fresh));
		this.refreshRow(row);
		this.draftKeys.add(key);
	}

	/** Descarta todo lo pendiente y vuelve al baseline confirmado. */
	discard(): void {
		if (this.remote) {
			/*
				Con ventana, `baseline` tiene la ventana más las retenidas: volcarlo
				entero metería en la hoja filas de otras posiciones. Se restaura cada
				fila de la ventana a su original y se sueltan las retenidas.
			*/
			this.rows = this.rows
				.filter((r) => !this.createdKeys.has(r.__key))
				.map((r) => structuredClone(this.baseline.get(r.__key) ?? r));
			for (const key of this.detached.keys()) this.baseline.delete(key);
			this.detached.clear();
			this.detachedAt.clear();
			this.deletedKeys.clear();
			this.conflicts.clear();
			this.failedAttempt = null;
			this.createdOrder = [];
			this.lead = 0;
		} else {
			this.rows = [...this.baseline.values()].map((r) => structuredClone(r));
		}
		this.reindexRows();
		this.dirtyCells.clear();
		this.createdKeys.clear();
		this.deletedRows = [];
		this.errors.clear();
		this.restoredFromStorage = false;
		this.clearStorage();
		this.clearHistory();
		this.version++;
	}

	/** Matriz de valores en el orden de las columnas, para alimentar jspreadsheet. */
	toMatrix(): unknown[][] {
		return this.rows.map((row) => this.columns.map((column) => row[column.field] ?? ''));
	}

	dispose(): void {
		clearTimeout(this.persistTimer);
	}
}
