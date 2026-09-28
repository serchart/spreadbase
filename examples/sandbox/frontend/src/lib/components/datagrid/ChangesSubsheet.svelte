<!--
	ChangesSubsheet — detalle editable de una fila del registro de cambios.

	Es una instancia propia de jspreadsheet, no otro DataGrid: no tiene
	controlador, historial ni toolbar. Su única fuente de verdad es la hoja
	principal; cuando el usuario edita «Nuevo», el valor viaja por `onedit` y
	entra por el mismo camino que una edición en la celda. El registro se
	recalcula y esta tabla se vuelve a llenar desde él.

	Una fila por campo: `Estado · Campo · Anterior · Nuevo · Mensaje`. «Nuevo»
	cambia de tipo en cada fila, así que usa `buildRowTypedEditor`, que delega
	en el editor real del campo.
-->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import jspreadsheet from 'jspreadsheet-ce';
	import { buildRowTypedEditor, clampedTextCell } from './cellTypes';
	import { attachClampPopover } from './clampPopover';
	import { destroySheet } from './jss';
	import type { GridController } from './GridController.svelte';
	import type { CellTypeContext, CellValue, ColumnDef, RowChange } from './types';

	interface Props {
		controller: GridController;
		row: RowChange;
		onjump: (field: string, rowKey: string) => void;
		onedit: (field: string, rowKey: string, value: CellValue) => void;
	}

	let { controller, row, onjump, onedit }: Props = $props();

	const COL_NEW = 3;

	type Mark = 'created' | 'changed' | 'deleted' | 'error';

	// Atributos en el propio SVG: sin ellos el tamaño y el trazo dependerían de
	// que una regla CSS alcance un nodo creado fuera de Svelte.
	const svg = (body: string) =>
		`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

	const ICONS: Record<Mark, string> = {
		created: svg('<path d="M12 5v14M5 12h14"/>'),
		changed: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
		deleted: svg('<path d="M5 12h14"/>'),
		error: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>')
	};

	const MARK_LABEL: Record<Mark, string> = {
		created: 'Nuevo',
		changed: 'Editado',
		deleted: 'Eliminado',
		error: 'Error'
	};

	let host: HTMLDivElement;
	let worksheet: any = null;

	const columnsByField = $derived(new Map(controller.columns.map((c) => [c.field, c])));

	/*
		El editor resuelve la columna por índice de fila en cada llamada. Lee de
		una referencia mutable y no de `row` directamente porque jspreadsheet
		guarda el objeto de tipo al construir la tabla, y las filas de la
		subtabla cambian después sin reconstruirla.
	*/
	// svelte-ignore state_referenced_locally
	let current = row;

	// svelte-ignore state_referenced_locally
	const ctx: CellTypeContext = {
		labelCache: controller.labelCache,
		requestRepaint: () => refresh()
	};

	const newValueEditor = buildRowTypedEditor(
		(y) => columnsByField.get(current.cells[y]?.field ?? '') ?? null,
		ctx
	);

	const markCell = {
		createCell(cell: HTMLTableCellElement, value: CellValue) {
			paintMark(cell, value as Mark);
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue) {
			paintMark(cell, value as Mark);
			return value;
		}
	};

	function paintMark(cell: HTMLTableCellElement, mark: Mark) {
		cell.classList.add('oc-sub__mark');
		cell.dataset.mark = mark;
		cell.title = MARK_LABEL[mark] ?? '';
		cell.innerHTML = ICONS[mark] ?? '';
	}

	function markOf(r: RowChange, state: 'changed' | 'error'): Mark {
		if (state === 'error') return 'error';
		if (r.state === 'deleted') return 'deleted';
		if (r.state === 'created') return 'created';
		return 'changed';
	}

	function toMatrix(r: RowChange): unknown[][] {
		// Por clave: la fila puede estar retenida fuera de la ventana.
		const live = r.state === 'deleted' ? null : controller.getRow(r.key);
		return r.cells.map((c) => [
			markOf(r, c.state),
			c.label,
			r.state === 'created' ? '' : c.previousText,
			live ? ((live[c.field] as CellValue) ?? '') : '',
			c.message ?? ''
		]);
	}

	/** Solo lectura por celda y marca de error en «Nuevo». */
	function decorate(r: RowChange) {
		if (!worksheet) return;
		r.cells.forEach((c, y) => {
			const td = worksheet.getCellFromCoords(COL_NEW, y) as HTMLTableCellElement | null;
			if (!td) return;
			const column = columnsByField.get(c.field);
			const locked = r.state === 'deleted' || !column || !!column.readOnly;
			worksheet.setReadOnly(td, locked);
			td.classList.toggle('is-error', c.state === 'error');
		});
	}

	const MARK_WIDTH = 28;
	/**
	 * Reparto del ancho restante entre Campo, Anterior, Nuevo y Mensaje.
	 * Mensaje se lleva la parte mayor: es el texto más largo y el que explica
	 * qué corregir. Campo, Anterior y Mensaje ajustan a dos líneas; Nuevo
	 * queda en una, con su editor.
	 */
	const SHARES = [0.18, 0.2, 0.24, 0.38];
	const MIN_WIDTHS = [64, 120, 120, 160];

	/** Campo, Anterior y Mensaje: hasta dos líneas y, si no cabe, globo al pasar el mouse. */
	const clampCell = clampedTextCell(2);
	let detachPopover: (() => void) | null = null;

	/**
	 * Anchos a la medida del panel. Con anchos fijos la subtabla desbordaba en
	 * cuanto el panel se estrechaba y aparecía un scroll horizontal dentro de
	 * cada tarjeta. Por debajo de los mínimos sí scrollea: truncar «Nuevo» a
	 * nada sería peor.
	 */
	function columnWidths(available: number): number[] {
		// Un píxel de borde por celda más el de cierre de la tabla.
		const rest = Math.max(0, available - MARK_WIDTH - 6);
		return SHARES.map((share, i) => Math.max(MIN_WIDTHS[i], Math.floor(rest * share)));
	}

	let applying = false;

	/** Un clic en el chevron abre el selector, igual que en la hoja principal. */
	function handleClick(event: MouseEvent) {
		const chevron = (event.target as HTMLElement | null)?.closest?.('.oc-picker__chevron');
		const td = chevron?.closest('td');
		if (!td || !worksheet) return;
		event.preventDefault();
		event.stopPropagation();
		worksheet.openEditor(td);
	}

	function refresh() {
		// No se pisa un editor abierto: el siguiente cambio volverá a llenar la tabla.
		if (!worksheet || worksheet.edition) return;
		applying = true;
		try {
			worksheet.setData(toMatrix(current) as never);
		} finally {
			applying = false;
		}
		decorate(current);
	}

	onMount(() => {
		const widths = columnWidths(host.clientWidth);
		const instances = jspreadsheet(host, {
			worksheets: [
				{
					data: toMatrix(current) as never,
					columns: [
						{ title: ' ', width: MARK_WIDTH, readOnly: true, type: markCell as never, align: 'center' },
						{ title: 'Campo', width: widths[0], readOnly: true, type: clampCell as never, align: 'left' },
						{ title: 'Anterior', width: widths[1], readOnly: true, type: clampCell as never, align: 'left' },
						{ title: 'Nuevo', width: widths[2], type: newValueEditor as never, align: 'left' },
						{ title: 'Mensaje', width: widths[3], readOnly: true, type: clampCell as never, align: 'left' }
					] as never,
					minDimensions: [5, 0],
					allowInsertRow: false,
					allowDeleteRow: false,
					allowInsertColumn: false,
					allowDeleteColumn: false,
					allowRenameColumn: false,
					allowComments: false,
					columnSorting: false,
					columnDrag: false,
					rowDrag: false,
					rowResize: false,
					selectionCopy: false,
					search: false,
					wordWrap: false
				}
			],
			toolbar: false,
			about: false,
			contextMenu: () => [] as never,
			onchange: (_i: unknown, _cell: unknown, x: unknown, y: unknown, value: unknown) => {
				if (applying || Number(x) !== COL_NEW) return;
				const cell = current.cells[Number(y)];
				if (!cell || current.state === 'deleted') return;
				onedit(cell.field, current.key, value as CellValue);
			},
			onselection: (_i: unknown, _x1: number, y1: number) => {
				const cell = current.cells[y1];
				if (cell && current.state !== 'deleted') onjump(cell.field, current.key);
			}
		});
		worksheet = instances[0];
		worksheet.hideIndex?.();
		decorate(current);
		detachPopover = attachClampPopover(host);
	});

	// Cada versión del controlador produce un `RowChange` nuevo; se vuelca a la tabla.
	$effect(() => {
		current = row;
		toMatrix(row);
		refresh();
	});

	onDestroy(() => {
		detachPopover?.();
		if (worksheet && host) destroySheet(host, worksheet);
		worksheet = null;
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="oc-sub overflow-x-auto rounded-field"
	bind:this={host}
	onclick={handleClick}
></div>

<style>
	/* Colores del tema del DataGrid (`datagrid.css`): la subtabla es otra hoja. */
	.oc-sub :global(td.oc-sub__mark) {
		padding: 0 !important;
		text-align: center;
	}

	.oc-sub :global(td.oc-sub__mark svg) {
		vertical-align: middle;
	}

	.oc-sub :global(td.oc-sub__mark[data-mark='created']) {
		color: var(--dg-new-accent);
	}
	.oc-sub :global(td.oc-sub__mark[data-mark='changed']) {
		color: var(--dg-dirty-accent);
	}
	.oc-sub :global(td.oc-sub__mark[data-mark='deleted']),
	.oc-sub :global(td.oc-sub__mark[data-mark='error']) {
		color: var(--dg-invalid-accent);
	}

	.oc-sub :global(td.is-error) {
		background-color: var(--dg-invalid-bg);
	}
</style>
