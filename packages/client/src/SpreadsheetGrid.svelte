<!--
@component
DataGrid tipo hoja de cálculo sobre jspreadsheet-ce.

Responsabilidades:
  - Renderiza columnas tipadas (ver `cellTypes.ts`) con sus validadores.
  - Marca visualmente celdas editadas, filas nuevas y celdas inválidas.
  - Acumula los cambios en un changeset y los persiste en storage local.
  - Nada se envía al servidor hasta pulsar "Guardar".

Uso:
  <SpreadsheetGrid {config} title="Cargos" />
-->
<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import jspreadsheet from 'jspreadsheet-ce';
	import 'jspreadsheet-ce/dist/jspreadsheet.css';
	import 'jsuites/dist/jsuites.css';
	import './datagrid.css';

	import GitMerge from '@lucide/svelte/icons/git-merge';
	import Modal from './internal/Modal.svelte';
	import ChangesPanel from './ChangesPanel.svelte';
	import RestoreNotice from './RestoreNotice.svelte';
	import FiltersPanel from './FiltersPanel.svelte';
	import ColumnMenu from './ColumnMenu.svelte';
	import GroupsPanel from './GroupsPanel.svelte';
	import { grow, swap } from './internal/motion';
	import Toolbar from './Toolbar.svelte';
	import { GridController } from './GridController.svelte';
	import { getCellType, lookupKey, resolveLookupText } from './cellTypes';
	import { fromTsv, toTsv } from './clipboard';
	import { destroySheet } from './jss';
	import type {
		CellTypeContext,
		CellValue,
		ColumnDef,
		DataGridTheme,
		GridConfig,
		GridToolbarConfig,
		SaveResult
	} from './types';

	interface Props {
		config: GridConfig;
		title?: string;
		description?: string;
		/**
		 * La hoja ocupa la altura disponible del contenedor en vez de una altura
		 * fija en píxeles.
		 *
		 * Existe porque `tableHeight` de jspreadsheet es un string CSS que se fija
		 * al construir la grilla: con `'460px'` la hoja mide lo mismo en un
		 * portátil que en un monitor de 27", desperdiciando media pantalla. En modo
		 * `fill` se le pasa `100%` y el alto lo resuelve el flex del contenedor,
		 * así que se adapta al redimensionar sin números mágicos.
		 *
		 * Es el modo de las vistas que **son** una hoja (`/cases`, `/customers`),
		 * frente a una página donde la grilla es un bloque entre otros.
		 */
		fill?: boolean;
		/**
		 * Controlador creado por el contenedor.
		 *
		 * Se pasa cuando la página necesita leer el estado de la hoja —filas,
		 * celdas editadas, errores— o disparar sus acciones desde fuera, típicamente
		 * para montar su propia toolbar.
		 *
		 * Es opcional porque el caso común no lo necesita: si se omite, el
		 * componente crea el suyo y sigue siendo autosuficiente.
		 *
		 * Elevar el controlador y no exponer métodos vía `bind:this` es deliberado:
		 * `bind:this` es `undefined` hasta que el componente monta, así que una
		 * toolbar externa no podría leer contadores en su primer render. El
		 * controlador, en cambio, existe antes de que este componente se monte.
		 *
		 * Los comandos sí quedan disponibles solo tras el montaje, y por eso el
		 * controlador publica `sheetReady`: el estado se lee desde el principio,
		 * las acciones se habilitan cuando la hoja puede atenderlas.
		 */
		controller?: GridController;
		/**
		 * Barra de herramientas propia del componente.
		 *
		 * `true` (default) la muestra completa, `false` la oculta —para cuando el
		 * contenedor monta la suya con `controller.commands`— y un objeto permite
		 * elegir qué botones aparecen y cómo se agrupan.
		 */
		toolbar?: boolean | GridToolbarConfig;
		/**
		 * Tema de esta instancia. Sobrescribe solo las claves indicadas; el resto
		 * sale del tema global (ver `datagrid.css` y su adaptador).
		 */
		theme?: DataGridTheme;
	}

	let {
		config,
		title = '',
		description = '',
		fill = false,
		controller: externalController,
		toolbar = true,
		theme
	}: Props = $props();

	/** `{ headerBg: 'red' }` → `--dg-header-bg: red;` para el `style` del contenedor. */
	const themeStyle = $derived(
		Object.entries(theme ?? {})
			.filter(([, value]) => value != null && value !== '')
			.map(([key, value]) => `--dg-${key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}: ${value}`)
			.join('; ')
	);

	// La grilla se construye una sola vez a partir de la configuración inicial:
	// el controlador es dueño del estado y no debe reiniciarse en cada render.
	// svelte-ignore state_referenced_locally
	const controller = externalController ?? new GridController(config);

	let container: HTMLDivElement;
	let worksheet: any = null;
	let selection = $state<{ from: number; to: number } | null>(null);

	/**
	 * Último rango que el usuario seleccionó, con columnas incluidas.
	 *
	 * Existe porque jspreadsheet **limpia su selección** cuando se hace clic
	 * fuera de la tabla, y un botón de la toolbar es «fuera de la tabla». Sin
	 * este respaldo, `getSelection()` devuelve vacío justo en el instante en que
	 * la acción necesita saber sobre qué operar, y Copiar o Pegar contestaban
	 * «selecciona primero…» aunque hubiera una selección visible.
	 */
	let lastRange = $state<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

	/**
	 * Rango copiado, para dibujarlo en punteado.
	 *
	 * Se guarda aparte de la selección porque son cosas distintas: tras copiar,
	 * el usuario mueve el cursor al destino y la selección cambia, pero el origen
	 * debe seguir marcado hasta que pegue o pulse Escape.
	 */
	let copiedRange = $state<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

	/**
	 * Resultado del último intento de guardado. Se muestra en modal porque es
	 * una interrupción deliberada: el usuario acaba de pedir una acción y
	 * necesita enterarse del desenlace antes de seguir editando.
	 */
	let saveResult = $state<SaveResult | null>(null);

	/** Aviso de portapapeles: permisos denegados, selección vacía, etc. */
	let clipboardNotice = $state<string | null>(null);

	/** Textos pegados que se están resolviendo en el servidor (columnas lookup). */
	let pasteResolving = $state<number | null>(null);

	/**
	 * Lo último que se copió de esta hoja: el texto que fue al portapapeles y los
	 * valores reales detrás. Si se pega ese mismo texto, se usan los valores y no
	 * se interpreta nada: un lookup copiado lleva su id, no su nombre (SB-21).
	 */
	let lastCopy: { text: string; cells: { field: string; value: unknown }[][] } | null = null;
	const sameClip = (a: string, b: string) => {
		const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
		return norm(a) === norm(b);
	};

	/**
	 * Dirección del cambio entre paneles, según el orden de sus botones en la
	 * toolbar: ir a uno que está a la izquierda lo hace entrar desde la
	 * izquierda, empujando al actual hacia la derecha.
	 *
	 * Se calcula en `$effect.pre`, antes de que el DOM cambie, para que las
	 * transiciones de entrada y salida la lean ya actualizada.
	 */
	const PANEL_ORDER = ['filters', 'groups', 'changes'] as const;
	let swapFrom = $state<'left' | 'right'>('right');
	let previousPanel: typeof controller.sidePanel = null;

	$effect.pre(() => {
		const current = controller.sidePanel;
		if (previousPanel && current && previousPanel !== current) {
			swapFrom = PANEL_ORDER.indexOf(current) < PANEL_ORDER.indexOf(previousPanel) ? 'left' : 'right';
		}
		previousPanel = current;
	});

	const cellTypeContext: CellTypeContext = {
		labelCache: controller.labelCache,
		requestRepaint: () => paintStates(),
		rowAt: (y) => controller.rows[y]
	};

	// -- construcción de la grilla -----------------------------------------

	function buildColumns() {
		return config.columns.map((column) => {
			const type = getCellType(column.type);
			return {
				// Con título vacío jspreadsheet pone la letra de columna («A»).
				title: column.label || ' ',
				width: column.width ?? 160,
				readOnly: column.readOnly ?? false,
				wordWrap: false,
				...type.toColumn(column, cellTypeContext)
			};
		});
	}

	function destroyGrid() {
		detachWindowScroll();
		if (!worksheet || !container) return;
		destroySheet(container, worksheet);
		worksheet = null;
	}

	function createGrid() {
		if (!container) return;
		destroyGrid();

		const instances = jspreadsheet(container, {
			worksheets: [
				{
					data: controller.toMatrix() as never,
					columns: buildColumns() as never,
					minDimensions: [config.columns.length, 0],
					columnResize: true,
					// tableOverflow necesita AMBAS dimensiones acotadas: sin tableWidth
					// la tabla crece y se desborda en lugar de generar scroll horizontal.
					tableOverflow: true,
					tableWidth: '100%',
					// En modo `fill` el alto lo decide el contenedor, no la configuración.
					tableHeight: config.height ?? (fill ? '100%' : '460px'),
					// Las altas y bajas pasan por el controlador, nunca por jss
					// directamente, para que el changeset nunca se desincronice.
					allowInsertRow: false,
					allowDeleteRow: false,
					allowInsertColumn: false,
					allowDeleteColumn: false,
					allowRenameColumn: false,
					columnSorting: false,
					search: false,
					wordWrap: false
				}
			],
			toolbar: false,
			about: false,
			contextMenu: buildContextMenu,
			onchange: handleChange,
			// Los desplazamientos de las columnas fijas dependen de sus anchos.
			onresizecolumn: () => applyFrozenColumns(),
			onselection: (_i: any, x1: number, y1: number, x2: number, y2: number) => {
				selection = { from: Math.min(y1, y2), to: Math.max(y1, y2) };
				lastRange = {
					x1: Math.min(x1, x2),
					y1: Math.min(y1, y2),
					x2: Math.max(x1, x2),
					y2: Math.max(y1, y2)
				};
			}
		});

		worksheet = instances[0];
		paintStates(true);
		applyFrozenColumns();
		decorateHeaders();
		attachWindowScroll();
	}

	// -- menú de columna (SB-33) --------------------------------------------

	/** El menú abierto: su columna y el encabezado donde se ancla. */
	let columnMenu = $state<{ column: ColumnDef; anchor: HTMLElement } | null>(null);

	const svg = (paths: string) =>
		`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
	const ICON_MENU = svg('<path d="m6 9 6 6 6-6"/>');
	const ICON_FILTER = svg(
		'<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>'
	);
	const ICON_ASC = svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>');
	const ICON_DESC = svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>');

	/**
	 * Un botón en el encabezado de cada columna que se puede ordenar y filtrar.
	 * Muestra el estado: embudo si filtra, flecha si ordena; si no, una flecha
	 * discreta que aparece al pasar el mouse. jspreadsheet no rehace el
	 * encabezado al repintar filas, así que basta con decorarlo al crear la hoja
	 * y cuando cambia la consulta.
	 */
	function decorateHeaders() {
		if (!container) return;
		const cells = container.querySelectorAll<HTMLElement>('.jss_worksheet > thead > tr:last-child > td');
		config.columns.forEach((column, i) => {
			const td = cells[i + 1];
			if (!td) return;
			let button = td.querySelector<HTMLButtonElement>(':scope > .oc-colmenu');
			if (!controller.queryable || !column.filterable) {
				button?.remove();
				td.classList.remove('oc-th--menu');
				return;
			}
			if (!button) {
				button = document.createElement('button');
				button.type = 'button';
				button.className = 'oc-colmenu';
				// Un clic aquí no selecciona la columna (jspreadsheet escucha mousedown).
				button.addEventListener('mousedown', (e) => {
					e.stopPropagation();
					e.preventDefault();
				});
				button.addEventListener('click', (e) => {
					e.stopPropagation();
					columnMenu = columnMenu?.column.field === column.field ? null : { column, anchor: td };
				});
				td.appendChild(button);
				td.classList.add('oc-th--menu');
			}
			const filtered = !!controller.filterOf(column.field);
			const dir = controller.sort?.field === column.field ? controller.sort.dir : null;
			button.innerHTML = (dir === 'asc' ? ICON_ASC : dir === 'desc' ? ICON_DESC : '') + (filtered ? ICON_FILTER : '') || ICON_MENU;
			button.classList.toggle('is-active', filtered || !!dir);
			const state = [filtered ? 'filtrada' : '', dir === 'asc' ? 'orden ascendente' : dir === 'desc' ? 'orden descendente' : ''].filter(Boolean);
			button.setAttribute('aria-label', `Ordenar y filtrar «${column.label}»${state.length ? ` (${state.join(', ')})` : ''}`);
			button.title = state.length ? `${column.label}: ${state.join(', ')}` : `Ordenar y filtrar «${column.label}»`;
		});
	}

	// El estado de cada encabezado sigue a la consulta.
	$effect(() => {
		void controller.sort;
		void controller.where;
		decorateHeaders();
	});

	function buildContextMenu(_instance: any, _colIndex: unknown, rowIndex: unknown) {
		const y = Number(rowIndex);
		const items: Record<string, unknown>[] = [];
		if (Number.isNaN(y)) return items as never;

		// Si el clic cae fuera de la selección vigente, el menú opera sobre la
		// fila señalada; si cae dentro, opera sobre todo lo seleccionado.
		const inSelection = selection && y >= selection.from && y <= selection.to;
		const targetRows = inSelection && selection ? rangeToIndexes(selection) : [y];
		const plural = targetRows.length > 1;

		items.push({ title: 'Copiar', shortcut: '⌘C', onclick: () => copySelection(false) });
		items.push({ title: 'Cortar', shortcut: '⌘X', onclick: () => copySelection(true) });
		items.push({ title: 'Pegar', shortcut: '⌘V', onclick: () => pasteFromToolbar() });
		items.push({ type: 'line' });
		items.push({
			title: plural ? `Copiar ${targetRows.length} filas completas` : 'Copiar fila completa',
			onclick: () => copyRows(targetRows)
		});

		if (config.allowInsert !== false) {
			items.push({ type: 'line' });
			if (controller.remote) {
				// Con fuente remota las nuevas solo existen al inicio (G-2): no hay «arriba/abajo».
				items.push({ title: 'Agregar fila nueva (al inicio)', onclick: () => addRows(0, 1) });
			} else {
				items.push({ title: 'Insertar fila arriba', onclick: () => addRows(y, 1) });
				items.push({ title: 'Insertar fila abajo', onclick: () => addRows(y + 1, 1) });
			}
		}
		if (config.allowDelete !== false) {
			items.push({ type: 'line' });
			items.push({
				title: plural ? `Eliminar ${targetRows.length} filas` : 'Eliminar fila',
				onclick: () => deleteRows(targetRows)
			});
		}
		return items as never;
	}

	// -- sincronización controlador ↔ jspreadsheet -------------------------

	/** Evita reentrar en handleChange al reescribir el valor normalizado. */
	let normalizing = false;

	function handleChange(
		_instance: unknown,
		_cell: HTMLTableCellElement,
		colIndex: string | number,
		rowIndex: string | number,
		newValue: unknown
	) {
		if (normalizing) return;
		const x = Number(colIndex);
		const y = Number(rowIndex);
		const column = config.columns[x];
		if (!column) return;

		controller.setCellValue(y, column.field, newValue);

		// Algunos tipos (ej. número tecleado como "1,234.50") guardan un valor
		// canónico distinto al texto crudo: se devuelve a la hoja para que lo
		// mostrado y lo almacenado no diverjan.
		const type = getCellType(column.type);
		if (type.normalizeInSheet && worksheet) {
			const canonical = controller.rows[y]?.[column.field] ?? '';
			if (String(canonical) !== String(newValue ?? '')) {
				normalizing = true;
				try {
					worksheet.setValueFromCoords(x, y, canonical as never);
				} finally {
					normalizing = false;
				}
			}
		}

		/*
			Solo esta celda. `setCellValue` valida únicamente la celda editada, así
			que ninguna otra puede haber cambiado de estado: repintar la hoja completa
			no arreglaría nada y cuesta `filas × columnas` accesos al DOM.
		*/
		paintCell(x, y);
	}

	/**
	 * Vuelca la matriz del controlador a la hoja y repinta. Conserva el scroll:
	 * tras guardar (G-13) o resolver un conflicto el usuario sigue donde estaba.
	 */
	async function syncToSheet() {
		if (!worksheet) return;
		const top = scroller?.scrollTop ?? 0;
		const left = scroller?.scrollLeft ?? 0;
		worksheet.setData(controller.toMatrix() as never);
		if (scroller) {
			scroller.scrollTop = top;
			scroller.scrollLeft = left;
		}
		await tick();
		paintStates(true);
		renumberRows();
	}

	// -- ventana remota ------------------------------------------------------
	//
	// Con una fuente remota la hoja solo contiene la ventana del controlador.
	// Al acercarse el scroll a un borde se pide ampliarla; al volver, se vuelca
	// la ventana nueva y se corrige `scrollTop` para que el usuario siga viendo
	// las mismas filas. Es el patrón de la tabla de operación de Aggy
	// (`07-anexo-datagrid-engine.md` §11.1), sobre jspreadsheet.

	/** Filas de margen antes del borde a las que se pide la página siguiente. */
	const EDGE_ROWS = 20;

	let scroller: HTMLElement | null = null;
	let edgeFrame = 0;

	/**
	 * Numera las filas con su posición **global**. jspreadsheet las numera de 1
	 * a N dentro de su matriz, que aquí es solo la ventana: sin esto, la fila
	 * 12 480 aparecería como la 180.
	 */
	function renumberRows() {
		if (!controller.remote || !container) return;
		const offset = controller.windowOffset;
		/*
			Las nuevas van primero y no tienen posición en el servidor: «+» (§11.11).
			Una nueva ya guardada sigue arriba hasta recargar, con «✓»: se guardó,
			pero su posición real está en otro tramo.
		*/
		const lead = controller.leadCount;
		const cells = container.querySelectorAll<HTMLElement>('.jss_worksheet > tbody > tr > td.jss_row');
		cells.forEach((td, y) => {
			if (y >= lead) td.textContent = String(offset + y - lead + 1);
			else td.textContent = controller.isCreatedRow(controller.rows[y]?.__key ?? '') ? '+' : '✓';
		});
	}

	function rowHeight(): number {
		return container?.querySelector<HTMLElement>('.jss_worksheet > tbody > tr')?.offsetHeight || 25;
	}

	/**
	 * Hay un salto programático en curso («Ir a la fila» del panel). Mientras
	 * dura no se cargan páginas por los bordes: si la ventana se desplazara a
	 * mitad de la animación, el scroll terminaría en otra fila.
	 */
	let jumping = false;

	/** Comprueba en el siguiente fotograma si el scroll quedó cerca de un borde. */
	function checkEdges() {
		cancelAnimationFrame(edgeFrame);
		edgeFrame = requestAnimationFrame(() => {
			if (!scroller || controller.windowLoading || jumping) return;
			const margin = rowHeight() * EDGE_ROWS;
			const { scrollTop, scrollHeight, clientHeight } = scroller;
			if (scrollHeight - scrollTop - clientHeight < margin && controller.hasMoreBelow) {
				void shiftWindow('down');
			} else if (scrollTop < margin && controller.hasMoreAbove) {
				void shiftWindow('up');
			}
		});
	}

	async function shiftWindow(direction: 'up' | 'down') {
		const shift = await controller.extendWindow(direction);
		if (!shift || !worksheet || !scroller) return;

		/*
			Compensación del salto. Descartar filas de arriba sube todo el
			contenido; añadirlas arriba lo baja. Se corrige `scrollTop` en el
			mismo alto para que las filas bajo la vista del usuario no se muevan.
			Mismo cálculo que `Table.svelte` de Aggy.
		*/
		const height = rowHeight();
		const moved = direction === 'down' ? -shift.removed : shift.added;
		const scrollTop = scroller.scrollTop;
		const range = lastRange;

		// Medidas visibles en el panel Performance de DevTools y en el banco.
		performance.mark('dg:shift:start');
		worksheet.setData(controller.toMatrix() as never);
		performance.mark('dg:shift:setData');
		paintStates(true);
		renumberRows();
		performance.mark('dg:shift:paint');
		// Escribir `scrollTop` fuerza el layout de la tabla nueva: se mide aparte.
		scroller.scrollTop = scrollTop + moved * height;
		performance.mark('dg:shift:layout');
		performance.measure('dg:shift:setData', 'dg:shift:start', 'dg:shift:setData');
		performance.measure('dg:shift:paint', 'dg:shift:setData', 'dg:shift:paint');
		performance.measure('dg:shift:layout', 'dg:shift:paint', 'dg:shift:layout');
		performance.measure('dg:shift', 'dg:shift:start', 'dg:shift:layout');

		/*
			`setData` reconstruye la tabla y borra la selección. Se repone
			desplazada, o navegar con las flechas se cortaría en cada borde de
			página. Si la fila seleccionada salió de la ventana, se suelta.
		*/
		if (range) {
			const y1 = range.y1 + moved;
			const y2 = range.y2 + moved;
			if (y1 >= 0 && y2 < controller.rows.length) {
				worksheet.updateSelectionFromCoords(range.x1, y1, range.x2, y2);
			} else {
				lastRange = null;
				selection = null;
			}
		}

		// El usuario pudo seguir bajando mientras llegaba la página.
		checkEdges();
	}

	function attachWindowScroll() {
		if (!controller.remote || !container) return;
		scroller = container.querySelector<HTMLElement>('.jss_content');
		scroller?.addEventListener('scroll', checkEdges, { passive: true });
		renumberRows();
	}

	function detachWindowScroll() {
		// `onDestroy` también corre en SSR, donde no hay scroller ni rAF.
		if (!scroller) return;
		cancelAnimationFrame(edgeFrame);
		scroller.removeEventListener('scroll', checkEdges);
		scroller = null;
	}

	/**
	 * Pinta el estado de **una** celda sobre el DOM.
	 *
	 * Es la unidad del repintado. Existe separada porque confirmar una celda solo
	 * puede alterar esa celda: repintar la hoja entera por ello costaba
	 * `filas × columnas` accesos al DOM —140 000 con 10 000 filas— para cambiar
	 * una clase. Ver `07-anexo-datagrid-engine.md` §2.0.
	 */
	function paintCell(x: number, y: number, fresh = false) {
		if (!worksheet) return;
		const row = controller.rows[y];
		const column = config.columns[x];
		if (!row || !column) return;
		const isNew = controller.isCreatedRow(row.__key);

		let td: HTMLTableCellElement | undefined;
		try {
			td = worksheet.getCellFromCoords(x, y);
		} catch {
			return;
		}
		if (!td) return;

		/*
			Una celda recién creada por `setData` no tiene ninguna de estas
			clases: basta con añadir las que tocan. Con miles de celdas limpias,
			ahorrarse los `toggle(…, false)` es la mayor parte del coste de
			repintar la ventana remota al desplazarla.
		*/
		const set = fresh
			? (cls: string, on: boolean) => on && td.classList.add(cls)
			: (cls: string, on: boolean) => td.classList.toggle(cls, on);

		set('oc-cell-dirty', controller.isDirtyCell(row.__key, column.field));
		set('oc-cell-invalid', controller.isInvalidCell(row.__key, column.field));
		set('oc-cell-new', isNew);

		// Fila marcada como eliminada (fuente remota, G-7): tachada, atenuada y de solo lectura.
		const deleted = controller.isDeletedRow(row.__key);
		set('oc-row-deleted', deleted);

		// Recién combinada con un cambio ajeno: se resalta unos segundos y se desvanece sola.
		set('oc-cell-merged', controller.isMergedCell(row.__key, column.field));

		// En conflicto tras guardar (§11.14): borde naranja y de solo lectura hasta resolver.
		const conflict = controller.cellConflict(row.__key, column.field);
		set('oc-cell-conflict', !!conflict);
		if (deleted || controller.isConflictRow(row.__key)) worksheet.setReadOnly(td, true);

		// Borde punteado del rango copiado. Se marca solo el perímetro: cada
		// celda aporta únicamente los lados que caen en el borde del rango, de
		// modo que el conjunto se lea como un recuadro y no como una rejilla.
		const cr = copiedRange;
		const inCopy = !!cr && x >= cr.x1 && x <= cr.x2 && y >= cr.y1 && y <= cr.y2;
		if (inCopy || !fresh) {
			set('oc-copy', inCopy);
			set('oc-copy-t', inCopy && y === cr!.y1);
			set('oc-copy-b', inCopy && y === cr!.y2);
			set('oc-copy-l', inCopy && x === cr!.x1);
			set('oc-copy-r', inCopy && x === cr!.x2);
		}

		/*
			Recupera el texto que la librería descarta.

			El `dropdown` nativo resuelve el valor contra su `source` y, si no
			lo encuentra, devuelve cadena vacía —en su código,
			`o[l[e]] && n.push(o[l[e]])` no empuja nada—. Así, un valor pegado
			fuera de catálogo quedaba **invisible** aunque el validador lo
			marcara: la celda se veía vacía y en rojo, sin pista de qué
			contenía ni de qué corregir. Y pegar cualquier valor mostrándolo
			como error es justamente el comportamiento acordado.

			`format()` sí sabe representarlo (cae a `String(value)`), así que se
			reescribe el texto solo cuando la celda quedó vacía teniendo valor.
			El guardia sobre `children` protege a los tipos que renderizan
			elementos, como la imagen, cuyo `textContent` también es vacío.
		*/
		// El índice de `GridRow` es `unknown`; el tipo real lo fija la columna.
		const raw = row[column.field] as CellValue;
		if (
			raw !== null &&
			raw !== undefined &&
			raw !== '' &&
			td.textContent === '' &&
			td.children.length === 0
		) {
			td.textContent = getCellType(column.type).format(raw, column, cellTypeContext);
		}

		const message = conflict?.yours || conflict?.remote
			? `Conflicto · Tuyo: ${conflict.yours || '—'} · Remoto: ${conflict.remote || '—'}`
			: controller.cellError(row.__key, column.field);
		if (message) td.setAttribute('title', message);
		else if (!fresh) td.removeAttribute('title');
	}

	/**
	 * Repinta la hoja completa. Necesario cuando jspreadsheet reconstruye los
	 * `<td>` (`setData`) o cuando cambia algo transversal a muchas celdas, como
	 * el rango copiado. Para una edición puntual se usa `paintCell`.
	 *
	 * `fresh`: las `<td>` acaban de crearse y no llevan estado previo. Solo es
	 * válido justo después de `setData` o de construir la hoja.
	 */
	function paintStates(fresh = false) {
		if (!worksheet) return;
		for (let y = 0; y < controller.rows.length; y++) {
			for (let x = 0; x < config.columns.length; x++) paintCell(x, y, fresh);
		}
	}

	// -- acciones de la barra de herramientas ------------------------------

	async function addRows(atIndex: number, count = 1) {
		const index = Math.max(0, Math.min(atIndex, controller.rows.length));
		const created = controller.insertRows(index, count);
		if (controller.remote && created[0]) {
			// Las nuevas van al inicio: si la ventana está lejos, se lleva al usuario allí.
			const firstEditable = Math.max(0, config.columns.findIndex((c) => !c.readOnly && c.type !== 'action'));
			if (controller.indexOfRow(created[0].__key) === null) {
				await jumpToKey(firstEditable, created[0].__key);
				return;
			}
			await syncToSheet();
			if (scroller) scroller.scrollTop = 0;
			goToCell(firstEditable, 0);
			return;
		}
		await syncToSheet();
	}

	async function appendRow() {
		await addRows(controller.rows.length, 1);
	}

	async function deleteRows(indexes: number[]) {
		if (indexes.length === 0) return;
		controller.removeRowsAt(indexes);
		selection = null;
		await syncToSheet();
	}

	async function deleteSelection() {
		if (!selection) return;
		await deleteRows(rangeToIndexes(selection));
	}

	async function handleSave() {
		const result = await controller.save();
		saveResult = result;
		// Solo se repinta la hoja si el guardado alteró los datos.
		if (result.status === 'ok') await syncToSheet();
		else paintStates();
	}

	async function handleDiscard() {
		controller.discard();
		saveResult = null;
		await syncToSheet();
	}

	async function handleReload() {
		await controller.load();
		saveResult = null;
		await syncToSheet();
		// Con ventana remota, recargar vuelve al inicio: la ventana es la primera página.
		if (scroller) scroller.scrollTop = 0;
	}

	async function handleUndo() {
		if (!controller.undo()) return;
		await syncToSheet();
	}

	async function handleRedo() {
		if (!controller.redo()) return;
		await syncToSheet();
	}

	// -- portapapeles -------------------------------------------------------

	/**
	 * El portapapeles se maneja aquí y no se delega a jspreadsheet por una
	 * razón concreta: las columnas de catálogo muestran una etiqueta pero
	 * almacenan un id. La copia nativa de la librería se lleva la etiqueta y
	 * al pegarla no encuentra a qué id corresponde, así que descarta el valor
	 * en silencio. Interceptando el ciclo, cada tipo de celda decide cómo se
	 * serializa y cómo se resuelve de vuelta.
	 */

	type Range = { x1: number; y1: number; x2: number; y2: number };

	/** Selección viva de la hoja, o `null` si jspreadsheet ya la descartó. */
	function liveRange(): Range | null {
		if (!worksheet) return null;
		const sel = worksheet.getSelection?.();
		if (!sel || sel.length !== 4 || sel.some((n: unknown) => typeof n !== 'number')) return null;
		return {
			x1: Math.min(sel[0], sel[2]),
			y1: Math.min(sel[1], sel[3]),
			x2: Math.max(sel[0], sel[2]),
			y2: Math.max(sel[1], sel[3])
		};
	}

	/**
	 * Rango sobre el que actúa una acción.
	 *
	 * **`lastRange` tiene prioridad sobre la lectura viva**, y el orden importa.
	 * Al pulsar un botón de la toolbar, jspreadsheet no deja su selección en
	 * `null`: la **colapsa en la celda ancla**. `getSelection()` devuelve
	 * entonces un rango de 1×1 perfectamente válido, así que un respaldo por
	 * `??` nunca se activaba y Copiar operaba sobre una sola celda.
	 *
	 * `lastRange` se captura en `onselection`, que la librería despacha con el
	 * rango ya normalizado, y no lo toca nadie después. Es la única fuente que
	 * sigue siendo cierta en el instante en que se ejecuta la acción.
	 *
	 * La lectura viva queda como respaldo para el caso contrario: una selección
	 * hecha por la propia librería que no haya pasado por `onselection`.
	 */
	function currentRange(): Range | null {
		return lastRange ?? liveRange();
	}

	function serializeRange(range: Range): string {
		const matrix: string[][] = [];
		const values: { field: string; value: unknown }[][] = [];
		for (let y = range.y1; y <= range.y2; y++) {
			const row = controller.rows[y];
			if (!row) continue;
			const cells: string[] = [];
			const raw: { field: string; value: unknown }[] = [];
			for (let x = range.x1; x <= range.x2; x++) {
				const column = config.columns[x];
				if (!column) continue;
				const type = getCellType(column.type);
				const value = (row[column.field] ?? null) as never;
				cells.push(
					type.toClipboard
						? type.toClipboard(value, column, cellTypeContext)
						: type.format(value, column, cellTypeContext)
				);
				raw.push({ field: column.field, value });
			}
			matrix.push(cells);
			values.push(raw);
		}
		const text = toTsv(matrix);
		lastCopy = { text, cells: values };
		return text;
	}

	/**
	 * Antes de pegar en columnas lookup: los textos que la hoja no sabe resolver
	 * se consultan al servidor **una vez**, sin duplicados y en tramos de 500.
	 * Las filas que vuelven entran a la caché de nombres, y `fromClipboard` ya
	 * las encuentra. Si la red falla, se pega el texto tal cual y queda marcado.
	 */
	async function resolveLookupsForPaste(
		matrix: string[][],
		at: { x: number; y: number },
		copied: { field: string; value: unknown }[][] | null
	) {
		const pending = new Map<ColumnDef, Set<string>>();
		matrix.forEach((cells, dy) =>
			cells.forEach((raw, dx) => {
				const column = config.columns[at.x + dx];
				if (!column || column.readOnly || column.type !== 'lookup' || !column.lookup?.resolve) return;
				if (copied?.[dy]?.[dx]?.field === column.field) return;
				const text = raw.trim();
				if (!text || resolveLookupText(text, column, controller.labelCache) !== null) return;
				const set = pending.get(column) ?? new Set<string>();
				set.add(text);
				pending.set(column, set);
			})
		);
		const count = [...pending.values()].reduce((n, s) => n + s.size, 0);
		if (count === 0) return;

		pasteResolving = count;
		try {
			for (const [column, texts] of pending) {
				const lookup = column.lookup!;
				const all = [...texts];
				for (let i = 0; i < all.length; i += 500) {
					const matches = await lookup.resolve!(all.slice(i, i + 500));
					for (const [text, rows] of Object.entries(matches)) {
						for (const row of rows) {
							controller.labelCache.set(lookupKey(column.field, row[lookup.value]), String(row[lookup.display] ?? ''));
						}
						const needle = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
						if (rows.length > 1) lookup.ambiguous?.set(needle, rows.length);
						else lookup.ambiguous?.delete(needle);
					}
				}
			}
		} catch {
			// Sin red: se pega el texto y el validador lo marca. No se pierde nada.
		} finally {
			pasteResolving = null;
		}
	}

	/** Vacía el rango seleccionado, respetando las columnas de solo lectura. */
	function clearRange(range: Range) {
		// Una transacción: borrar un bloque es una acción, no una por celda.
		controller.transaction(() => {
			for (let y = range.y1; y <= range.y2; y++) {
				for (let x = range.x1; x <= range.x2; x++) {
					const column = config.columns[x];
					if (!column || column.readOnly) continue;
					controller.setCellValue(y, column.field, null);
				}
			}
		});
	}

	async function applyPaste(text: string, at: { x: number; y: number }) {
		const matrix = fromTsv(text);
		if (matrix.length === 0) return;

		// Si lo pegado excede las filas existentes, la grilla crece para
		// recibirlo. De lo contrario el pegado se truncaría sin avisar.
		const overflow = at.y + matrix.length - controller.rows.length;
		if (overflow > 0 && config.allowInsert === false) {
			clipboardNotice =
				'Lo que intentas pegar tiene más filas que la grilla, y esta tabla no admite altas.';
			return;
		}

		// Pegar lo que se copió de esta misma hoja usa los valores reales, sin reinterpretar.
		const copied = lastCopy && sameClip(lastCopy.text, text) ? lastCopy.cells : null;
		// Se espera a resolver los lookups y luego se aplica todo como un solo paso del historial.
		await resolveLookupsForPaste(matrix, at, copied);

		/*
			Las filas que crecen y las celdas que se rellenan van en la **misma**
			transacción. Separarlas haría que deshacer el pegado dejara atrás las
			filas vacías creadas para alojarlo: un estado que el usuario nunca pidió
			y que además seguiría contando como altas pendientes.
		*/
		controller.transaction(() => {
			if (overflow > 0) controller.insertRows(controller.rows.length, overflow);

			matrix.forEach((cells: string[], dy: number) => {
				cells.forEach((raw: string, dx: number) => {
					const x = at.x + dx;
					const y = at.y + dy;
					const column = config.columns[x];
					if (!column || column.readOnly) return;
					if (y >= controller.rows.length) return;
					const source = copied?.[dy]?.[dx];
					if (source && source.field === column.field) {
						controller.setCellValue(y, column.field, source.value as CellValue);
						return;
					}
					const type = getCellType(column.type);
					const value = type.fromClipboard
						? type.fromClipboard(raw, column, cellTypeContext)
						: type.parse(raw, column);
					controller.setCellValue(y, column.field, value);
				});
			});
		});

		// El punteado del origen se retira al pegar: ya cumplió su cometido, que
		// era recordar de dónde venía lo que estaba en el portapapeles.
		copiedRange = null;

		await syncToSheet();
		worksheet?.updateSelectionFromCoords(
			at.x,
			at.y,
			Math.min(at.x + (matrix[0]?.length ?? 1) - 1, config.columns.length - 1),
			Math.min(at.y + matrix.length - 1, controller.rows.length - 1)
		);
	}

	// -- columnas fijas -------------------------------------------------------

	/** Identifica esta hoja para acotar las reglas de columnas fijas. */
	const gridUid = `oc-grid-${Math.random().toString(36).slice(2, 9)}`;
	let frozenStyle: HTMLStyleElement | null = null;

	/**
	 * Fija el número de fila y las primeras `config.frozenColumns` columnas.
	 *
	 * No se usa `freezeColumns` de jspreadsheet: en la edición CE reposiciona las
	 * celdas con JS en cada evento de scroll (con retraso visible), solo actúa
	 * pasados 50 px, supone 50 px de ancho para el número de fila y no fija ese
	 * número. Aquí se usa `position: sticky`, que resuelve el navegador sin JS.
	 *
	 * El desplazamiento `left` de cada columna depende de los anchos reales de
	 * las anteriores, así que las reglas se generan midiendo el encabezado y se
	 * regeneran al redimensionar una columna. Van en una hoja de estilo propia,
	 * acotado a esta hoja por su `data-grid-uid`, en lugar de escribir `left` en
	 * miles de celdas.
	 */
	function applyFrozenColumns() {
		if (!container) return;
		const headerCells = container.querySelectorAll<HTMLElement>('.jss_worksheet > thead > tr:last-child > td');
		if (headerCells.length === 0) return;

		// Celda 1 = número de fila; luego, las columnas de datos fijadas.
		const count = 1 + Math.max(0, config.frozenColumns ?? 0);
		const scope = `[data-grid-uid="${gridUid}"] .jss_worksheet`;
		const rules: string[] = [];
		let left = 0;
		for (let i = 1; i <= count && i <= headerCells.length; i++) {
			const last = i === count;
			const cell = `> tbody > tr > td:nth-child(${i})`;
			const head = `> thead > tr > td:nth-child(${i})`;
			rules.push(
				`${scope} ${cell}, ${scope} ${head} { position: sticky; left: ${left}px; }`,
				`${scope} ${cell} { z-index: 1; background-color: var(--dg-bg); }`,
				`${scope} ${head} { z-index: 3; }`,
				// La selección es translúcida: sobre una celda fija se vería el
				// contenido que pasa por debajo. Se pinta como capa sobre el fondo.
				`${scope} ${cell}.highlight { background-color: var(--dg-bg); background-image: linear-gradient(var(--dg-selection-bg), var(--dg-selection-bg)); }`
			);
			if (i === 1) rules.push(`${scope} ${cell} { background-color: var(--dg-header-bg); }`);
			if (last) {
				// Borde de separación con la zona que se desplaza.
				rules.push(`${scope} ${cell}, ${scope} ${head} { box-shadow: inset -1px 0 0 var(--dg-frozen-edge); }`);
			}
			left += headerCells[i - 1].offsetWidth;
		}

		frozenStyle ??= document.createElement('style');
		frozenStyle.textContent = rules.join('\n');
		if (!frozenStyle.isConnected) container.appendChild(frozenStyle);
	}

	/**
	 * Abre el selector al pulsar el chevron.
	 *
	 * jspreadsheet solo abre el editor con doble clic o al teclear, y un botón de
	 * expansión que exige doble clic no se comporta como un botón. El doble clic
	 * sobre el resto de la celda sigue funcionando como siempre, porque lo atiende
	 * la librería.
	 */
	function handleSheetClick(event: MouseEvent) {
		const target = event.target as HTMLElement | null;

		// Botón de una columna de acción: se resuelve la fila por las coordenadas
		// que jspreadsheet deja en el `<td>` y se entrega la fila actual.
		const actionButton = target?.closest?.('.oc-action');
		if (actionButton) {
			const td = actionButton.closest('td');
			const x = Number(td?.dataset.x);
			const y = Number(td?.dataset.y);
			const row = controller.rows[y];
			const action = config.columns[x]?.action;
			if (action && row) {
				event.preventDefault();
				event.stopPropagation();
				action.onclick(row, y);
			}
			return;
		}

		// Casilla: un clic la alterna, como en cualquier hoja de cálculo.
		if (target?.matches?.('input.oc-bool')) {
			event.preventDefault();
			const td = target.closest('td');
			if (td && worksheet && !target.hasAttribute('disabled')) worksheet.openEditor(td);
			return;
		}

		const chevron = target?.closest?.('.oc-picker__chevron');
		if (!chevron || !worksheet) return;
		const td = chevron.closest('td');
		if (!td) return;
		event.preventDefault();
		event.stopPropagation();
		worksheet.openEditor(td);
	}

	/**
	 * True si el evento es para esta grilla.
	 *
	 * No basta con mirar si nació dentro del contenedor: tras confirmar una
	 * celda con Enter el editor desaparece y el foco queda en `<body>`. Ahí
	 * jspreadsheet sigue atendiendo el teclado —lo enruta a
	 * `jspreadsheet.current`, la última hoja pulsada—, así que un evento del
	 * documento con esta hoja activa también es nuestro. Sin esto, ⌘Z tras
	 * Enter lo resolvía el historial nativo de la librería: revertía la celda en
	 * pantalla y el controlador seguía creyéndola editada.
	 */
	function isOwnEvent(event: Event): boolean {
		const target = event.target as Node | null;
		if (!target || !container) return false;
		if (container.contains(target)) return true;
		const fromDocument = target === document.body || target === document.documentElement;
		return fromDocument && !!worksheet && (jspreadsheet as any).current === worksheet;
	}

	function handleNativeCopy(event: ClipboardEvent, cut: boolean) {
		if (!isOwnEvent(event)) return;
		// Si el foco está en un editor de celda, el navegador debe hacer lo suyo.
		if ((event.target as HTMLElement)?.closest?.('.oc-cell-editor')) return;
		const range = currentRange();
		if (!range) return;

		event.preventDefault();
		event.stopPropagation();
		event.clipboardData?.setData('text/plain', serializeRange(range));
		if (cut) {
			copiedRange = null;
			clearRange(range);
		} else {
			copiedRange = range;
		}
		paintStates();
	}

	function handleNativePaste(event: ClipboardEvent) {
		if (!isOwnEvent(event)) return;
		if ((event.target as HTMLElement)?.closest?.('.oc-cell-editor')) return;
		const range = currentRange();
		const text = event.clipboardData?.getData('text/plain');
		if (!range || !text) return;

		event.preventDefault();
		event.stopPropagation();
		applyPaste(text, { x: range.x1, y: range.y1 });
	}

	// -- acciones explícitas de portapapeles (toolbar y menú contextual) ----

	async function copySelection(cut = false) {
		const range = currentRange();
		if (!range) {
			clipboardNotice = 'Selecciona primero las celdas que quieres copiar.';
			return;
		}
		try {
			await navigator.clipboard.writeText(serializeRange(range));
			if (cut) {
				copiedRange = null;
				clearRange(range);
				await syncToSheet();
			} else {
				// Al cortar no se marca: el origen va a quedar vacío, y señalar con
				// punteado unas celdas que ya no tienen contenido no informa de nada.
				copiedRange = range;
				paintStates();
			}
		} catch {
			clipboardNotice =
				'El navegador bloqueó el acceso al portapapeles. Usa ⌘C / Ctrl+C sobre la selección.';
		}
	}

	/** Amplía la selección a filas completas antes de copiar. */
	async function copyRows(indexes?: number[]) {
		const rows = indexes ?? (selection ? rangeToIndexes(selection) : []);
		if (rows.length === 0) {
			clipboardNotice = 'Selecciona primero las filas que quieres copiar.';
			return;
		}
		const lastColumn = config.columns.length - 1;
		worksheet?.updateSelectionFromCoords(0, rows[0], lastColumn, rows[rows.length - 1]);
		await copySelection(false);
	}

	async function pasteFromToolbar() {
		const range = currentRange();
		if (!range) {
			clipboardNotice = 'Selecciona primero la celda donde quieres pegar.';
			return;
		}
		try {
			const text = await navigator.clipboard.readText();
			if (!text) {
				clipboardNotice = 'El portapapeles está vacío.';
				return;
			}
			await applyPaste(text, { x: range.x1, y: range.y1 });
		} catch {
			clipboardNotice =
				'El navegador no permite leer el portapapeles sin tu permiso. Usa ⌘V / Ctrl+V sobre la celda destino.';
		}
	}

	/**
	 * jspreadsheet resuelve ⌘C / ⌘X dentro de su manejador de `keydown`, no en
	 * el evento `copy`. Si no se corta ahí, su serialización se impone sobre la
	 * nuestra y volvemos al problema original. ⌘V sí se deja pasar: el evento
	 * `paste` entrega el contenido sin pedir permisos, a diferencia de
	 * `readText()`, y `handleNativePaste` lo intercepta después.
	 */
	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			// Escape retira el punteado, igual que en Sheets y Excel.
			if (copiedRange) {
				copiedRange = null;
				paintStates();
			}
			return;
		}
		if (!event.metaKey && !event.ctrlKey) return;
		if (!isOwnEvent(event)) return;
		if ((event.target as HTMLElement)?.closest?.('.oc-cell-editor')) return;

		const key = event.key.toLowerCase();

		/*
			⌘Z / ⌘⇧Z / ⌘Y se interceptan para **desactivar el historial nativo de
			jspreadsheet**, no solo para añadir un atajo.

			La librería mantiene su propio historial de valores de celda, que no sabe
			nada del changeset. Si se le dejara atender ⌘Z, revertiría la celda en
			pantalla mientras el controlador sigue creyendo que está editada, y el
			guardado enviaría un valor que el usuario ya deshizo.
		*/
		if (key === 'z' || key === 'y') {
			event.preventDefault();
			event.stopPropagation();
			if (key === 'y' || event.shiftKey) handleRedo();
			else handleUndo();
			return;
		}

		if (key !== 'c' && key !== 'x') return;

		event.preventDefault();
		event.stopPropagation();
		copySelection(key === 'x');
	}

	function rangeToIndexes(sel: { from: number; to: number }): number[] {
		const out: number[] = [];
		for (let y = sel.from; y <= sel.to; y++) out.push(y);
		return out;
	}

	/**
	 * Selecciona una celda y la trae al viewport.
	 *
	 * `smooth: false` la coloca al instante: es lo que se usa tras cargar una
	 * ventana nueva, donde no hay nada que animar —el contenido es otro— y una
	 * animación larga solo daría tiempo a que se disparen cargas por los bordes.
	 */
	function goToCell(x: number, y: number, smooth = true) {
		if (!worksheet) return;
		try {
			worksheet.updateSelectionFromCoords(x, y, x, y);
			worksheet
				.getCellFromCoords(x, y)
				?.scrollIntoView({ block: 'center', inline: 'center', behavior: smooth ? 'smooth' : 'instant' });
		} catch {
			// La celda pudo desaparecer si la fila se eliminó entre tanto.
		}
	}

	/** Espera a que termine el scroll: `scrollend` si el navegador lo emite, o un tope. */
	function scrollSettled(smooth: boolean): Promise<void> {
		if (!scroller) return Promise.resolve();
		if (!smooth) return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
		const target = scroller;
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				target.removeEventListener('scrollend', done);
				resolve();
			};
			const timer = setTimeout(done, 900);
			target.addEventListener('scrollend', done, { once: true });
		});
	}

	/**
	 * Salta a una celda por clave de fila.
	 *
	 * Con fuente remota la fila puede estar fuera de la ventana: con `reveal`,
	 * se carga la ventana a su alrededor y se salta (G-1: el panel de cambios es
	 * el punto de navegación a lo modificado). Sin `reveal` solo salta si ya está
	 * cargada.
	 *
	 * Durante el salto se suspende la carga por los bordes (`jumping`). Sin eso,
	 * tras revelar una fila lejana la hoja quedaba con el scroll arriba, el
	 * scroll suave hacia la fila pasaba cerca del borde superior, se pedía la
	 * página anterior y, al llegar, la ventana se movía a mitad de la animación:
	 * se aterrizaba decenas de filas antes de la buscada.
	 */
	async function jumpToKey(x: number, rowKey: string, reveal = true) {
		let y = controller.indexOfRow(rowKey);
		let revealed = false;
		jumping = true;
		try {
			if (y === null && reveal && controller.remote) {
				y = await controller.revealRow(rowKey);
				if (y === null) return;
				await syncToSheet();
				revealed = true;
			}
			if (y === null) return;
			// Ventana nueva: al instante. Fila ya cargada: con animación, que orienta.
			goToCell(x, y, !revealed);
			await scrollSettled(!revealed);
		} finally {
			jumping = false;
			checkEdges();
		}
	}

	/**
	 * Escribe un valor editado desde el panel de cambios.
	 *
	 * Si la fila está en la hoja pasa por `setValueFromCoords`, el mismo camino
	 * que una edición en la celda: `handleChange` actualiza el controlador,
	 * normaliza y repinta. Si está retenida fuera de la ventana, va directo al
	 * controlador: no hay celda que pintar.
	 */
	function editFromPanel(x: number, rowKey: string, value: CellValue) {
		if (!worksheet) return;
		const y = controller.indexOfRow(rowKey);
		if (y === null) {
			const column = config.columns[x];
			if (column) controller.setCellValueByKey(rowKey, column.field, value);
			return;
		}
		worksheet.setValueFromCoords(x, y, (value ?? '') as never);
		goToCell(x, y);
	}

	/** Resuelve un conflicto desde el panel y repinta: la fila cambia de valores y de estado. */
	async function resolveFromPanel(rowKey: string, choice: 'mine' | 'remote', field?: string) {
		controller.resolveConflict(rowKey, choice, field);
		await syncToSheet();
	}

	/** Cierra el modal del guardado y enciende el resaltado de lo combinado, ahora visible. */
	function closeSaveResult() {
		saveResult = null;
		controller.revealMerges();
		paintStates();
	}

	/** Cierra el modal del guardado y abre el panel en «Conflictos». */
	function reviewConflicts() {
		closeSaveResult();
		controller.openChanges('conflicts');
	}

	/** Cierra el modal y abre el panel en «Con error» para que el usuario corrija. */
	function reviewIssues() {
		saveResult = null;
		controller.openChanges('errors');
		const first = controller.errorList[0];
		if (first) void jumpToKey(first.x, first.rowKey);
	}

	// -- ciclo de vida ------------------------------------------------------

	/** Baja del registro de comandos. Se asigna al montar. */
	let detachSheet: (() => void) | null = null;

	// La selección se refleja en el controlador en lugar de moverla allí: la
	// escriben media docena de manejadores de jspreadsheet, y un espejo en un
	// solo punto es más fácil de seguir que reescribirlos todos.
	$effect(() => {
		controller.selection = selection;
	});

	onMount(async () => {
		// Etiquetas conocidas de antemano: evitan mostrar IDs crudos en las
		// columnas de fuente externa mientras el usuario no abra el buscador.
		for (const column of config.columns) {
			column.preloadLabels?.forEach(([value, label]) => controller.labelCache.set(value, label));
		}
		const restored = controller.tryRestore();
		if (!restored) await controller.load();
		createGrid();

		/*
			Los comandos que dependen de jspreadsheet se publican **después** de
			`createGrid()`, por dos razones.

			Una de corrección: registrarlos durante la inicialización escribiría
			estado que el contenedor ya leyó en ese mismo render —su toolbar se
			pinta antes que este componente— y Svelte lo rechaza como mutación
			insegura.

			Otra de honestidad: así `sheetReady` significa «los comandos funcionan»
			y no «el componente existe». Copiar o pegar antes de que la hoja esté
			construida no tendría a qué aplicarse.

			`save` y `discard` se registran aunque el controlador ya sepa guardar:
			estas versiones además repintan la hoja y abren el diálogo de resultado.
		*/
		detachSheet = controller.attachSheet({
			copy: (cut = false) => copySelection(cut),
			copyRows: () => copyRows(),
			paste: () => pasteFromToolbar(),
			addRow: () => appendRow(),
			deleteSelection: () => deleteSelection(),
			reload: () => handleReload(),
			save: () => handleSave(),
			discard: () => handleDiscard(),
			undo: () => handleUndo(),
			redo: () => handleRedo(),
			// Escribir desde fuera (SB-27): los datos en una sola acción y la hoja repintada.
			setValues: async (changes) => {
				controller.writeValues(changes);
				await syncToSheet();
			}
		});
	});

	onDestroy(() => {
		detachSheet?.();
		controller.dispose();
		destroyGrid();
	});

	/** `null` si la barra propia está oculta; si no, su configuración. */
	const toolbarSettings = $derived.by((): GridToolbarConfig | null => {
		if (toolbar === false) return null;
		const cfg: GridToolbarConfig = toolbar === true ? {} : toolbar;
		return cfg.enabled === false ? null : cfg;
	});
</script>

<section class="oc-grid" class:is-fill={fill} style={themeStyle || undefined}>
	{#if title || description}
		<header class="oc-grid__header">
			<div>
				{#if title}<h2>{title}</h2>{/if}
				{#if description}<p>{description}</p>{/if}
			</div>
		</header>
	{/if}

	{#if toolbarSettings}
		<!-- La barra es transparente; el marco lo pone la hoja cuando la embebe. -->
		<div class="oc-grid__toolbar">
			<Toolbar {controller} toolbarConfig={toolbarSettings} />
		</div>
	{/if}

	<div class="oc-grid__body">
		<!--
			El `onclick` es delegación, no interactividad propia: el contenido lo crea
			jspreadsheet y un único listener aquí sirve a todas las celdas y sobrevive a
			los repintados que reconstruyen los `<td>`. El equivalente por teclado ya
			existe —Enter y doble clic abren el editor—, así que la regla de a11y no
			aporta en este caso.
		-->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="oc-grid__sheet"
			data-grid-uid={gridUid}
			bind:this={container}
			onclick={handleSheetClick}
		></div>

		<!--
			Un solo hueco animado para todos los paneles: al abrir crece desde el
			borde derecho y la hoja se encoge a la par; al cerrar, al revés.

			Pasar de un panel a otro no toca el hueco: dentro, el contenido nuevo
			entra por un lado y empuja al anterior hacia el otro. Los dos se apilan
			en la misma celda del grid mientras dura el cambio, así que el ancho no
			se duplica. Las transiciones de `{#key}` son locales: no se disparan al
			abrir o cerrar el hueco, solo al cambiar de panel.
		-->
		{#if controller.sidePanel}
			<div
				class="grid min-h-0 shrink-0 grid-rows-[minmax(0,1fr)] justify-items-end overflow-hidden pl-1"
				transition:grow
			>
				{#key controller.sidePanel}
					<div
						class="col-start-1 row-start-1 flex min-h-0"
						in:swap={{ from: swapFrom }}
						out:swap={{ from: swapFrom, leaving: true }}
					>
						{#if controller.sidePanel === 'changes'}
							<ChangesPanel
								{controller}
								onjump={jumpToKey}
								onresolve={resolveFromPanel}
								onedit={editFromPanel}
								onclose={() => controller.closeSidePanel()}
							/>
						{:else if controller.sidePanel === 'groups'}
							<GroupsPanel onclose={() => controller.closeSidePanel()} />
						{:else}
							<FiltersPanel {controller} onclose={() => controller.closeSidePanel()} />
						{/if}
					</div>
				{/key}
			</div>
		{/if}
	</div>

	<footer class="oc-grid__legend">
		<span><i class="swatch swatch--dirty"></i> Celda editada sin guardar</span>
		<span><i class="swatch swatch--new"></i> Fila nueva</span>
		<span><i class="swatch swatch--invalid"></i> Valor inválido</span>
		{#if pasteResolving}
			<span class="oc-grid__resolving">
				<span class="loading loading-spinner loading-xs"></span>
				Resolviendo {pasteResolving.toLocaleString('es-MX')}
				{pasteResolving === 1 ? 'nombre' : 'nombres'}…
			</span>
		{/if}
		{#if controller.remote}
			<span><i class="swatch swatch--deleted"></i> Fila eliminada</span>
			{#if controller.conflictCount > 0}
				<span><i class="swatch swatch--conflict"></i> Conflicto</span>
			{/if}
			<!-- Qué tramo del servidor hay en memoria. Hace visible la ventana deslizante. -->
			<span class="tabular-nums ml-auto">
				{#if controller.windowLoading}
					<span class="loading loading-spinner loading-xs"></span>
					Cargando {controller.windowLoading === 'down' ? 'siguientes' : 'anteriores'}…
				{/if}
				<!-- Solo filas del servidor: las nuevas (con «+») aún no tienen posición. -->
				Filas {(controller.windowOffset + 1).toLocaleString('es-MX')}–{(
					controller.windowOffset + controller.rowCount - controller.leadCount
				).toLocaleString('es-MX')} de {controller.total.toLocaleString('es-MX')}
			</span>
		{/if}
		{#if controller.lastSavedAt}
			<span class="oc-grid__autosave">
				Borrador local guardado {new Date(controller.lastSavedAt).toLocaleTimeString('es-MX')}
			</span>
		{/if}
	</footer>

	<!-- Con `each` y no `if`: el menú conserva su columna mientras se desmonta (al cerrar, `columnMenu` ya es null). -->
	{#each columnMenu ? [columnMenu] : [] as open (open.column.field)}
		<ColumnMenu {controller} column={open.column} anchor={open.anchor} onclose={() => (columnMenu = null)} />
	{/each}
</section>

<!--
	Los eventos de portapapeles se atienden en fase de captura para adelantarse
	al manejador que jspreadsheet registra en el documento: así este corre
	primero y puede detener la propagación antes de que la librería intervenga.
-->
<svelte:window
	onkeydowncapture={handleKeydown}
	oncopycapture={(e) => handleNativeCopy(e, false)}
	oncutcapture={(e) => handleNativeCopy(e, true)}
	onpastecapture={handleNativePaste}
/>

<RestoreNotice active={controller.restoredFromStorage} ondiscard={handleDiscard} />

{#if clipboardNotice}
	<Modal open tone="info" title="Portapapeles" onclose={() => (clipboardNotice = null)}>
		<p>{clipboardNotice}</p>
		{#snippet footer()}
			<button type="button" class="btn btn-sm btn-primary" onclick={() => (clipboardNotice = null)}>
				Entendido
			</button>
		{/snippet}
	</Modal>
{/if}

{#if saveResult?.status === 'invalid'}
	<Modal
		open
		tone="warning"
		title="No se guardó: hay datos inválidos"
		subtitle="El cambio no se envió. Ninguna modificación se perdió: sigue todo en pantalla."
		onclose={() => (saveResult = null)}
	>
		<p>
			{saveResult.issues.length}
			{saveResult.issues.length === 1 ? 'celda requiere' : 'celdas requieren'} corrección antes de
			poder guardar.
		</p>
		<ul class="list mt-3 rounded-box border border-base-300">
			{#each saveResult.issues as issue (issue.id)}
				<li class="list-row items-center gap-3 py-2">
					<span class="status status-warning" aria-hidden="true"></span>
					<div class="min-w-0">
						<div class="tabular-nums text-xs font-semibold">
							{issue.row === 0 ? 'Fila nueva' : `Fila ${issue.row.toLocaleString('es-MX')}`} · {issue.label}
						</div>
						<div class="text-xs text-base-content/70">{issue.message}</div>
					</div>
				</li>
			{/each}
		</ul>

		{#snippet footer()}
			<button type="button" class="btn btn-sm btn-ghost" onclick={() => (saveResult = null)}>Cerrar</button>
			<button type="button" class="btn btn-sm btn-primary" onclick={reviewIssues}>Ir al primer error</button>
		{/snippet}
	</Modal>
{/if}

{#if saveResult?.status === 'error'}
	<Modal
		open
		tone="error"
		title="El guardado falló"
		subtitle="Tus cambios siguen intactos en pantalla. Puedes corregir y reintentar."
		onclose={() => (saveResult = null)}
	>
		<p>{saveResult.message}</p>
		{#snippet footer()}
			<button type="button" class="btn btn-sm btn-ghost" onclick={() => (saveResult = null)}>Cerrar</button>
			<button
				type="button"
				class="btn btn-sm btn-primary"
				onclick={() => {
					saveResult = null;
					handleSave();
				}}
			>
				Reintentar
			</button>
		{/snippet}
	</Modal>
{/if}

{#if saveResult?.status === 'ok'}
	{@const conflicts = saveResult.summary.conflicts ?? 0}
	<Modal
		open
		tone={conflicts > 0 ? 'warning' : 'success'}
		title={conflicts > 0 ? 'Guardado con conflictos' : 'Cambios guardados'}
		subtitle={conflicts > 0
			? `${conflicts} ${conflicts === 1 ? 'fila no se guardó: otro usuario la cambió o la eliminó' : 'filas no se guardaron: otros usuarios las cambiaron o eliminaron'}. El resto sí.`
			: undefined}
		onclose={closeSaveResult}
	>
		<div class="stats w-full border border-base-300">
			<div class="stat px-4 py-3">
				<div class="stat-title text-xs">Filas creadas</div>
				<div class="stat-value tabular-nums text-2xl">{saveResult.summary.creates}</div>
			</div>
			<div class="stat px-4 py-3">
				<div class="stat-title text-xs">Actualizadas</div>
				<div class="stat-value tabular-nums text-2xl">{saveResult.summary.updates}</div>
			</div>
			<div class="stat px-4 py-3">
				<div class="stat-title text-xs">Eliminadas</div>
				<div class="stat-value tabular-nums text-2xl">{saveResult.summary.deletes}</div>
			</div>
		</div>
		{#if controller.remote && controller.lastMerges.length > 0}
			{@const merges = controller.lastMerges}
			<!--
				Combinadas (G-15): ya están guardadas, no hay nada que decidir; pero
				el usuario debe saber que en esas filas hay datos que no escribió él.
			-->
			<div role="alert" class="alert alert-info alert-soft mt-3 items-start">
				<GitMerge size={18} class="mt-0.5 shrink-0" aria-hidden="true" />
				<div class="min-w-0 flex-1">
					<p class="text-sm font-semibold">
						{merges.length === 1
							? 'Una fila se combinó con cambios de otro usuario'
							: `${merges.length} filas se combinaron con cambios de otros usuarios`}
					</p>
					<p class="text-xs opacity-80">
						Se guardó lo tuyo y se conservó lo suyo en otros campos. Están resaltadas en la hoja.
					</p>
					<ul class="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto">
						{#each merges as m (m.rowKey)}
							<li class="flex items-center gap-2 text-xs">
								<span class="tabular-nums shrink-0 font-semibold">
									{m.position === null ? 'Fila nueva' : `Fila ${(m.position + 1).toLocaleString('es-MX')}`}
								</span>
								<span class="min-w-0 flex-1 truncate">
									{#each m.fields as f, i (f.field)}{i > 0 ? ' · ' : ''}{f.label}: <strong>{f.valueText || '—'}</strong>{/each}
								</span>
								<button
									type="button"
									class="btn btn-ghost btn-xs"
									onclick={() => {
										closeSaveResult();
										const x = config.columns.findIndex((c) => c.field === m.fields[0]?.field);
										void jumpToKey(Math.max(0, x), m.rowKey);
									}}
								>
									Ir
								</button>
							</li>
						{/each}
					</ul>
				</div>
			</div>
		{/if}
		<p class="mt-3 text-xs text-base-content/70">
			{#if controller.remote}
				Lo guardado ya refleja la versión del servidor; tu posición en la hoja no cambió.
			{:else}
				Los datos se recargaron desde la fuente y el borrador local se limpió.
			{/if}
		</p>
		{#snippet footer()}
			{#if conflicts > 0}
				<button type="button" class="btn btn-sm btn-ghost" onclick={closeSaveResult}>Cerrar</button>
				<button type="button" class="btn btn-sm btn-primary" onclick={reviewConflicts}>Revisar conflictos</button>
			{:else}
				<button type="button" class="btn btn-sm btn-primary" onclick={closeSaveResult}>Entendido</button>
			{/if}
		{/snippet}
	</Modal>
{/if}

{#if saveResult?.status === 'noop'}
	<Modal open tone="info" title="No hay nada que guardar" onclose={() => (saveResult = null)}>
		<p>No se detectaron cambios pendientes respecto a los datos cargados.</p>
		{#snippet footer()}
			<button type="button" class="btn btn-sm btn-primary" onclick={() => (saveResult = null)}>Entendido</button>
		{/snippet}
	</Modal>
{/if}

{#if controller.loadError}
	<Modal
		open
		tone="error"
		title="No se pudieron cargar los datos"
		onclose={() => (controller.loadError = null)}
	>
		<p>{controller.loadError}</p>
		{#snippet footer()}
			<button type="button" class="btn btn-sm btn-ghost" onclick={() => (controller.loadError = null)}>Cerrar</button>
			<button type="button" class="btn btn-sm btn-primary" onclick={handleReload}>Reintentar</button>
		{/snippet}
	</Modal>
{/if}

<style>
	/* El interior de la hoja se tematiza en `datagrid.css` con variables `--dg-*`. */
	.oc-grid {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		font-family: var(--dg-font-family);
		color: var(--dg-fg);
	}

	/*
		Modo `fill`. `min-height: 0` en la hoja es obligatorio: sin él el hijo
		flexible crece con su contenido en lugar de scrollear, y la hoja empuja el
		pie fuera del contenedor.
	*/
	.oc-grid.is-fill {
		height: 100%;
	}

	.oc-grid.is-fill .oc-grid__body {
		flex: 1;
		min-height: 0;
	}

	/*
		Hoja y panel lado a lado. El panel se estira a la altura de la hoja
		(`stretch`) y scrollea por dentro, así que abrirlo nunca empuja el pie ni
		cambia la altura de la vista: solo le quita ancho a la hoja, que ya
		scrollea en horizontal.
	*/
	/* Sin `gap`: la separación con el panel es padding de su hueco, que se anima
	   con él. Un `gap` aparecería de golpe al montar el panel. */
	.oc-grid__body {
		display: flex;
		align-items: stretch;
		min-width: 0;
	}

	.oc-grid__body .oc-grid__sheet {
		flex: 1;
	}

	.oc-grid__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.oc-grid__header h2 {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 650;
	}

	.oc-grid__header p {
		margin: 0.2rem 0 0;
		font-size: 0.82rem;
		color: var(--dg-fg-muted);
		max-width: 60ch;
	}

	/* Marco de la barra embebida. Fuera de la hoja, lo pone su contenedor. */
	.oc-grid__toolbar {
		display: flex;
		align-items: center;
		padding: 0.25rem 0.35rem;
		border: 1px solid var(--color-base-300);
		border-radius: 8px;
		background: var(--color-base-100);
	}

	/* Marco de la hoja: la rejilla queda contenida y con las esquinas del tema. */
	.oc-grid__sheet {
		width: 100%;
		min-width: 0;
		overflow: hidden;
		border: 1px solid var(--dg-grid-line);
		border-radius: var(--dg-radius);
		background-color: var(--dg-bg);
	}

	/* jspreadsheet monta el contenedor de scroll en .jss_content. Las barras
	   delgadas vienen de la regla global de `app.css`. */
	:global(.oc-grid__sheet .jss_content) {
		width: 100% !important;
		max-width: 100%;
		overflow: auto !important;
	}

	/*
		Modo `fill`: la hoja ocupa el alto del contenedor y scrollea por dentro,
		con el encabezado de columnas fijo.

		`tableHeight: '100%'` se traduce en `max-height: 100%` sobre `.jss_content`,
		pero entre él y la hoja hay dos envoltorios de alto automático
		(`.jtabs-content` de jSuites y `.jss_container`), así que ese porcentaje no
		se resolvía: la tabla crecía con sus filas y el scroll pasaba a `<main>`,
		llevándose el encabezado. Se encadena un flex en columna con `min-height: 0`
		en cada eslabón — lo mismo que hace el modo pantalla completa de la
		librería — y el alto queda acotado. `flex: 0 1 auto` en vez de `1`: con
		pocas filas la hoja mide lo que su contenido, sin hueco vacío debajo.
	*/
	.oc-grid.is-fill .oc-grid__sheet {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	:global(.oc-grid.is-fill .oc-grid__sheet .jtabs-content),
	:global(.oc-grid.is-fill .oc-grid__sheet .jss_container) {
		display: flex;
		flex-direction: column;
		flex: 0 1 auto;
		min-height: 0;
	}

	:global(.oc-grid.is-fill .oc-grid__sheet .jss_content) {
		flex: 0 1 auto;
		min-height: 0;
		max-height: none !important;
	}

	.oc-grid__legend {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		align-items: center;
		font-size: 0.72rem;
		color: var(--dg-fg-muted);
	}

	.oc-grid__legend span {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.oc-grid__autosave {
		margin-left: auto;
		font-style: italic;
	}
</style>
