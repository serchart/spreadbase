<!--
	Toolbar — barra de acciones del DataGrid.

	Solo habla con el controlador: lee su estado y ejecuta `controller.commands`.
	No conoce la hoja ni jspreadsheet, y por eso puede montarse en cualquier
	parte de la página. `SpreadsheetGrid` la usa por dentro cuando `toolbar` no
	es `false`, así que existe una sola implementación.

	Fondo transparente a propósito: adopta el de su contenedor. Quien la monte
	fuera decide el marco; la hoja, cuando la embebe, le pone el suyo.

	Quien necesite otra barra no está obligado a usar esta: todo lo que hace
	aquí —comandos, contadores, `sheetReady`, `openChanges()`— es API pública
	del controlador.
-->
<script lang="ts">
	import type { GridController } from './GridController.svelte';
	import type { GridToolbarAction, GridToolbarButton, GridToolbarConfig } from './types';
	import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
	import PanelButton from './PanelButton.svelte';
	import ClipboardPaste from '@lucide/svelte/icons/clipboard-paste';
	import Copy from '@lucide/svelte/icons/copy';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import ListFilter from '@lucide/svelte/icons/list-filter';
	import FolderTree from '@lucide/svelte/icons/folder-tree';
	import ListX from '@lucide/svelte/icons/list-x';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Redo2 from '@lucide/svelte/icons/redo-2';
	import Rows3 from '@lucide/svelte/icons/rows-3';
	import Save from '@lucide/svelte/icons/save';
	import Trash from '@lucide/svelte/icons/trash';
	import Undo2 from '@lucide/svelte/icons/undo-2';

	interface Props {
		controller: GridController;
		/** Qué botones aparecen, cómo se agrupan y qué contadores se muestran. */
		toolbarConfig?: GridToolbarConfig;
	}

	let { controller, toolbarConfig = {} }: Props = $props();

	/**
	 * Agrupación por defecto, ordenada como en Sheets y Office: primero el
	 * historial, luego el portapapeles, luego la estructura de filas, y al final
	 * lo que toca el servidor. `save` no se queda en su grupo: va a la sección
	 * de acciones (SB-24).
	 *
	 * El orden no es estético. Las acciones más frecuentes y más inocuas quedan a
	 * la izquierda, donde el cursor llega antes; las irreversibles —descartar,
	 * guardar— al extremo opuesto, para que no se pulsen por inercia.
	 */
	const DEFAULT_GROUPS: GridToolbarAction[][] = [
		['undo', 'redo'],
		['copy', 'copyRows', 'paste'],
		['addRow', 'deleteRow'],
		['reload'],
		['discard', 'save']
	];

	interface ToolbarButton {
		action: GridToolbarAction;
		icon: typeof Copy;
		label: string;
		hint: string;
		disabled: boolean;
		run: () => void;
		/** Se dibuja con etiqueta visible y color de acento. */
		primary?: boolean;
	}

	const settings = $derived({
		groups: toolbarConfig.groups ?? DEFAULT_GROUPS,
		status: toolbarConfig.status !== false,
		changes: toolbarConfig.changes !== false
	});

	const selectionLabel = $derived.by(() => {
		const sel = controller.selection;
		if (!sel) return null;
		return sel.from === sel.to ? `fila ${sel.from + 1}` : `filas ${sel.from + 1}–${sel.to + 1}`;
	});

	/** Descriptor de cada acción. Se recalcula con el estado del controlador. */
	const buttonFor = $derived.by(() => {
		// Hasta que la hoja monta, los comandos son no-ops: mejor no ofrecerlos.
		const off = !controller.sheetReady;
		const busy = off || controller.loading || controller.saving;
		const cmd = controller.commands;
		const map: Record<GridToolbarAction, ToolbarButton> = {
			undo: {
				action: 'undo',
				icon: Undo2,
				label: 'Deshacer',
				hint: 'Deshacer (⌘Z)',
				disabled: !controller.canUndo || busy,
				run: cmd.undo
			},
			redo: {
				action: 'redo',
				icon: Redo2,
				label: 'Rehacer',
				hint: 'Rehacer (⌘⇧Z)',
				disabled: !controller.canRedo || busy,
				run: cmd.redo
			},
			copy: {
				action: 'copy',
				icon: Copy,
				label: 'Copiar',
				hint: 'Copiar selección (⌘C)',
				disabled: off,
				run: () => cmd.copy(false)
			},
			copyRows: {
				action: 'copyRows',
				icon: Rows3,
				label: 'Copiar filas',
				hint: 'Copiar las filas seleccionadas completas',
				disabled: off || !controller.hasSelection,
				run: cmd.copyRows
			},
			paste: {
				action: 'paste',
				icon: ClipboardPaste,
				label: 'Pegar',
				hint: 'Pegar en la celda activa (⌘V)',
				disabled: off,
				run: cmd.paste
			},
			addRow: {
				action: 'addRow',
				icon: Plus,
				label: 'Agregar fila',
				hint: 'Agregar una fila al final',
				disabled: busy,
				run: cmd.addRow
			},
			deleteRow: {
				action: 'deleteRow',
				icon: Trash,
				label: 'Eliminar fila',
				hint: selectionLabel ? `Eliminar ${selectionLabel}` : 'Selecciona filas para eliminar',
				disabled: !controller.hasSelection || busy,
				run: cmd.deleteSelection
			},
			reload: {
				action: 'reload',
				icon: RefreshCw,
				label: 'Recargar',
				hint: 'Volver a cargar desde el servidor',
				disabled: busy,
				run: cmd.reload
			},
			discard: {
				action: 'discard',
				// Pareja de `ListChecks` (Cambios): la misma lista, tachada. Una
				// flecha circular se confundía con Recargar.
				icon: ListX,
				label: 'Descartar',
				hint: 'Descartar todos los cambios pendientes',
				disabled: off || !controller.hasPendingChanges || controller.saving,
				run: cmd.discard
			},
			save: {
				action: 'save',
				icon: Save,
				label: controller.saving ? 'Guardando…' : 'Guardar',
				hint: 'Guardar los cambios pendientes',
				disabled: off || !controller.hasPendingChanges || controller.saving,
				run: cmd.save,
				primary: true
			}
		};
		return map;
	});

	/**
	 * Grupos ya depurados.
	 *
	 * `allowInsert` y `allowDelete` se filtran aquí en lugar de exigir que quien
	 * configure la barra recuerde excluir esos botones: la grilla ya sabe si la
	 * operación está permitida, y ofrecer un botón que el controlador rechazaría
	 * sería mentirle al usuario. Los grupos que quedan vacíos se descartan para
	 * no dejar divisores sueltos.
	 */
	const groups = $derived.by(() => {
		const allowed = (action: GridToolbarAction) => {
			if (action === 'save') return false;
			if (action === 'addRow') return controller.config.allowInsert !== false;
			if (action === 'deleteRow') return controller.config.allowDelete !== false;
			return true;
		};
		return settings.groups
			.map((group) => group.filter(allowed).map((action) => buttonFor[action]))
			.filter((group) => group.length > 0);
	});

	/**
	 * Sección de **acciones** (SB-24): Guardar y los botones propios de la
	 * página, con texto. Nunca se ocultan en ⋮: son lo que se viene a hacer.
	 */
	const saveButton = $derived(settings.groups.some((g) => g.includes('save')) ? buttonFor.save : null);
	const customActions = $derived<GridToolbarButton[]>(toolbarConfig.actions ?? []);
	const VARIANT: Record<NonNullable<GridToolbarButton['variant']>, string> = {
		outline: 'btn-outline',
		primary: 'btn-primary',
		ghost: 'btn-ghost'
	};
	/** Ancho de la sección de acciones, para descontarlo del de edición. */
	let actionsWidth = $state(0);

	// -- desbordamiento del grupo de edición ---------------------------------

	/** Ancho de toda la barra. */
	let barWidth = $state(0);
	/** Medidas publicadas por cada botón de panel. */
	const panelWidths = $state({
		filters: { compact: 0, full: 0 },
		groups: { compact: 0, full: 0 },
		changes: { compact: 0, full: 0 }
	});
	const PANEL_GAP = 8;

	type PanelId = keyof typeof panelWidths;

	/** Botón de panel bajo el puntero o con el foco de teclado. */
	let hoveredPanel = $state<PanelId | null>(null);

	/**
	 * Solo un botón de panel expandido a la vez: el del hover si lo hay; si
	 * no, el activo. El activo comprimido conserva su color encendido.
	 */
	const expandedPanel = $derived<PanelId | null>(hoveredPanel ?? controller.sidePanel);

	function hoverPanel(id: PanelId, inside: boolean) {
		if (inside) hoveredPanel = id;
		else if (hoveredPanel === id) hoveredPanel = null;
	}

	/**
	 * Ancho para los botones de edición.
	 *
	 * Como hay un solo botón de panel expandido a la vez, el grupo nunca pasa
	 * de «todos compactos + la expansión más ancha». Se reserva ese máximo,
	 * esté quien esté expandido: el hover empuja dentro de un hueco fijo y el
	 * grupo de edición no se recalcula mientras dura la animación.
	 */
	const available = $derived.by(() => {
		if (!barWidth) return 0;
		const actions = actionsWidth ? actionsWidth + PANEL_GAP : 0;
		if (!settings.status) return barWidth - actions;
		const panels = [
			panelWidths.filters,
			panelWidths.groups,
			...(settings.changes ? [panelWidths.changes] : [])
		];
		const compact = panels.reduce((sum, w) => sum + w.compact, 0);
		const expansion = Math.max(0, ...panels.map((w) => w.full - w.compact));
		return barWidth - actions - compact - expansion - PANEL_GAP * panels.length;
	});
	/** Ancho real de cada botón, medido en una fila invisible con todos. */
	const widths = $state<Record<string, number>>({});
	let separatorWidth = $state(17);
	/** Botón ⋮ más su margen. */
	const KEBAB_WIDTH = 36;

	let overflowOpen = $state(false);
	let overflowEl = $state<HTMLElement | null>(null);

	/**
	 * Acciones que no caben y pasan al menú ⋮.
	 *
	 * Se ocultan de derecha a izquierda, como en Sheets, con una excepción: la
	 * acción primaria (Guardar) es la última en irse, porque es la que no debe
	 * quedar a un clic extra. Los divisores cuentan: un grupo que se vacía deja
	 * de aportar el suyo.
	 */
	const hidden = $derived.by(() => {
		const out = new Set<GridToolbarAction>();
		if (!available) return out;
		const flat = groups.flatMap((group, gi) => group.map((button) => ({ button, gi })));
		const total = () => {
			let width = 0;
			let lastGroup = -1;
			for (const { button, gi } of flat) {
				if (out.has(button.action)) continue;
				if (lastGroup !== -1 && gi !== lastGroup) width += separatorWidth;
				width += widths[button.action] ?? 32;
				lastGroup = gi;
			}
			return width + (out.size > 0 ? KEBAB_WIDTH : 0);
		};
		// `sort` es estable: fuera de la primaria, se conserva el orden inverso.
		const order = [...flat].reverse().sort((a, b) => Number(!!a.button.primary) - Number(!!b.button.primary));
		for (const { button } of order) {
			if (total() <= available) break;
			out.add(button.action);
		}
		return out;
	});

	const visibleGroups = $derived(
		groups.map((g) => g.filter((b) => !hidden.has(b.action))).filter((g) => g.length > 0)
	);
	const hiddenGroups = $derived(
		groups.map((g) => g.filter((b) => hidden.has(b.action))).filter((g) => g.length > 0)
	);

	$effect(() => {
		if (hidden.size === 0) overflowOpen = false;
	});

	function runFromOverflow(button: ToolbarButton) {
		overflowOpen = false;
		button.run();
	}

	function handleWindowMousedown(event: MouseEvent) {
		if (overflowOpen && overflowEl && !overflowEl.contains(event.target as Node)) overflowOpen = false;
	}
</script>

<!-- Captura: jspreadsheet detiene el `mousedown` de la hoja antes de que suba a `window`. -->
<svelte:window
	onmousedowncapture={handleWindowMousedown}
	onkeydown={(e) => e.key === 'Escape' && (overflowOpen = false)}
/>

{#snippet actionButton(button: ToolbarButton, onrun: () => void)}
	{@const Icon = button.icon}
	<!--
		`onmousedown` con `preventDefault` evita que el botón tome el foco.
		Sin eso, jspreadsheet detecta un clic fuera de la tabla y descarta su
		selección **antes** de que llegue el `click`: la acción se ejecutaba
		sin saber sobre qué celdas operar. Además deja el teclado en la hoja,
		que es donde el usuario quiere seguir tecleando.
	-->
	<button
		type="button"
		class="btn btn-sm {button.primary ? 'btn-primary' : 'btn-square btn-ghost'}"
		disabled={button.disabled}
		onmousedown={(e) => e.preventDefault()}
		onclick={onrun}
		title={button.hint}
		aria-label={button.label}
	>
		<Icon size={16} strokeWidth={1.9} aria-hidden="true" />
		{#if button.primary}
			{button.label}
		{/if}
	</button>
{/snippet}

<!-- Se pasa solo si hay grupos activos: un contenedor de badges vacío también ocupa sitio. -->
{#snippet groupBadges()}
	<span class="tabular-nums badge badge-sm badge-info">{controller.activeGroupCount}</span>
{/snippet}

{#snippet actionGroups(list: ToolbarButton[][], onrun: (b: ToolbarButton) => void)}
	{#each list as group, groupIndex (groupIndex)}
		{#if groupIndex > 0}
			<!-- Divisor de altura parcial: separa grupos sin trocear la barra. -->
			<span class="mx-2 h-5 w-px shrink-0 bg-base-300" aria-hidden="true"></span>
		{/if}
		<div class="flex shrink-0 items-center">
			{#each group as button (button.action)}
				{@render actionButton(button, () => onrun(button))}
			{/each}
		</div>
	{/each}
{/snippet}

<!--
	Dos grupos. A la izquierda, **edición**: acciones que se ejecutan al pulsar.
	Cuando no caben, las que sobran pasan a un menú ⋮ flotante sobre la hoja,
	como en Google Sheets. A la derecha, **paneles**: abren el panel lateral y
	nunca se ocultan; en su lugar se compactan a icono y badges.

	Los grupos se separan con divisores porque el agrupamiento comunica
	parentesco sin gastar una etiqueta. Los botones de edición son solo icono,
	con el nombre en `title` y en `aria-label`. Una barra de diez etiquetas de
	texto se lee palabra por palabra cada vez; una de diez iconos se reconoce
	por posición y forma, que es lo que la vuelve rápida cuando se usa a
	diario. La excepción es la acción primaria: guardar sí lleva texto, porque
	es la que no debe confundirse.
-->
<div
	class="flex min-w-0 flex-1 items-center gap-2"
	role="toolbar"
	aria-label="Acciones de la hoja"
	bind:clientWidth={barWidth}
>
	<!-- Edición: solo icono; lo que no cabe pasa a ⋮. -->
	<div class="relative flex min-w-0 items-center">
		<!--
			Fila de medición: todos los botones, invisibles, para conocer su ancho
			real. Va dentro de una caja recortada: suelta, desbordaba hacia la
			derecha y daba scroll horizontal a la página que contiene la hoja.
		-->
		<div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true" inert>
		<div class="invisible flex w-max">
			{#each groups as group, groupIndex (groupIndex)}
				{#if groupIndex === 1}
					<span class="mx-2 h-5 w-px shrink-0" bind:offsetWidth={separatorWidth}></span>
				{/if}
				{#each group as button (button.action)}
					<span class="flex" bind:offsetWidth={widths[button.action]}>
						{@render actionButton(button, () => {})}
					</span>
				{/each}
			{/each}
		</div>
		</div>

		{@render actionGroups(visibleGroups, (b) => b.run())}

		{#if hiddenGroups.length > 0}
			<div
				class="dropdown ml-1 {overflowOpen ? 'dropdown-open' : ''}"
				bind:this={overflowEl}
			>
				<button
					type="button"
					class="btn btn-square btn-ghost btn-sm {overflowOpen ? 'btn-active' : ''}"
					aria-label="Más acciones"
					aria-expanded={overflowOpen}
					title="Más acciones"
					onmousedown={(e) => e.preventDefault()}
					onclick={() => (overflowOpen = !overflowOpen)}
				>
					<EllipsisVertical size={16} aria-hidden="true" />
				</button>
				{#if overflowOpen}
					<div
						class="dropdown-content z-50 mt-2 flex w-max max-w-[calc(100vw-2rem)] flex-wrap items-center gap-y-1 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
						role="group"
						aria-label="Acciones ocultas"
					>
						{@render actionGroups(hiddenGroups, runFromOverflow)}
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Acciones: Guardar y los botones propios de la página, con texto (SB-24). -->
	{#if saveButton || customActions.length}
		<div class="flex shrink-0 items-center gap-2" role="group" aria-label="Acciones" bind:offsetWidth={actionsWidth}>
			{#if groups.length}
				<span class="mr-1 h-5 w-px shrink-0 bg-base-300" aria-hidden="true"></span>
			{/if}
			{#if saveButton}
				{@render actionButton(saveButton, saveButton.run)}
			{/if}
			{#each customActions as custom, i (i)}
				{@const Icon = custom.icon}
				<button
					type="button"
					class="btn btn-sm {VARIANT[custom.variant ?? 'outline']}"
					disabled={custom.disabled}
					onmousedown={(e) => e.preventDefault()}
					onclick={custom.onclick}
					title={custom.hint ?? custom.label}
				>
					{#if Icon}<Icon size={16} strokeWidth={1.9} aria-hidden="true" />{/if}
					{custom.label}
				</button>
			{/each}
		</div>
	{/if}

	<!-- Empuja los paneles al extremo derecho. -->
	<span class="flex-1" aria-hidden="true"></span>

	{#if settings.status}
		<!-- El hover se limpia al salir del grupo entero, no de cada botón (ver `PanelButton`). -->
		<div
			class="flex shrink-0 items-center gap-2"
			role="group"
			aria-label="Paneles"
			onpointerleave={() => (hoveredPanel = null)}
		>
			<PanelButton
				icon={ListFilter}
				label="Filtros"
				active={controller.filtersOpen}
				expanded={expandedPanel === 'filters'}
				onhover={(inside) => hoverPanel('filters', inside)}
				bind:compactWidth={panelWidths.filters.compact}
				bind:fullWidth={panelWidths.filters.full}
				onclick={() => controller.toggleFilters()}
			/>
			<!-- Grupos: carpetas virtuales. El badge solo aparece si hay alguno activo. -->
			<PanelButton
				icon={FolderTree}
				label="Grupos"
				active={controller.groupsOpen}
				expanded={expandedPanel === 'groups'}
				onhover={(inside) => hoverPanel('groups', inside)}
				bind:compactWidth={panelWidths.groups.compact}
				bind:fullWidth={panelWidths.groups.full}
				title={controller.activeGroupCount > 0
					? `${controller.activeGroupCount} ${controller.activeGroupCount === 1 ? 'grupo activo' : 'grupos activos'}`
					: undefined}
				onclick={() => controller.toggleGroups()}
				badges={controller.activeGroupCount > 0 ? groupBadges : undefined}
			/>
			{#if settings.changes}
				{@const s = controller.rowSummary}
				<!--
					Cuenta filas, no celdas: «3 filas editadas» es lo que el usuario
					revisa y guarda; «41 celdas» no dice cuánto trabajo queda. Las
					celdas siguen en el `title` para quien las necesite.
				-->
				<PanelButton
					icon={ListChecks}
					label="Cambios"
					active={controller.changesOpen}
					expanded={expandedPanel === 'changes'}
					onhover={(inside) => hoverPanel('changes', inside)}
					bind:compactWidth={panelWidths.changes.compact}
					bind:fullWidth={panelWidths.changes.full}
					title={`${s.total} ${s.total === 1 ? 'fila por guardar' : 'filas por guardar'}`}
					onclick={() => controller.toggleChanges()}
				>
					{#snippet badges(expanded: boolean)}
						<!--
							Compacto: cuántas filas quedan (neutro) y cuántos errores
							bloquean el guardado (rojo). Expandido: el desglose. Las
							eliminadas van en error «soft» para no confundirlas con los
							errores en sólido: lo urgente pesa más que lo destructivo.
						-->
						{#if !expanded}
							<span class="tabular-nums badge badge-sm badge-neutral badge-soft">{s.total}</span>
							{#if controller.errorCount > 0}
								<span class="tabular-nums badge badge-sm badge-error">{controller.errorCount}</span>
							{/if}
							<!-- Tercer badge, solo con conflictos (G-17): naranja, ni error ni editada. -->
							{#if s.conflicts > 0}
								<span class="tabular-nums badge badge-sm oc-badge-conflict">{s.conflicts}</span>
							{/if}
						{:else}
							{#if s.total === 0}
								<span class="tabular-nums badge badge-sm badge-ghost">0</span>
							{/if}
							{#if s.created > 0}
								<span class="tabular-nums badge badge-sm badge-success" title="Filas nuevas">+{s.created}</span>
							{/if}
							{#if s.updated > 0}
								<span class="tabular-nums badge badge-sm badge-warning" title="Filas editadas">~{s.updated}</span>
							{/if}
							{#if s.deleted > 0}
								<span
									class="tabular-nums badge badge-sm badge-error badge-soft"
									title="Filas eliminadas"
									>−{s.deleted}</span
								>
							{/if}
							{#if controller.errorCount > 0}
								<span
									class="tabular-nums badge badge-sm badge-error"
									title={`${controller.errorCount} ${controller.errorCount === 1 ? 'celda con error' : 'celdas con error'}`}
								>
									{controller.errorCount}
								</span>
							{/if}
							{#if s.conflicts > 0}
								<span
									class="tabular-nums badge badge-sm oc-badge-conflict"
									title={`${s.conflicts} ${s.conflicts === 1 ? 'fila en conflicto' : 'filas en conflicto'}`}
								>
									⇄ {s.conflicts}
								</span>
							{/if}
						{/if}
					{/snippet}
				</PanelButton>
			{:else}
				{#if controller.dirtyCount > 0}
					<span class="tabular-nums badge badge-soft badge-warning">{controller.dirtyCount} editadas</span>
				{/if}
				{#if controller.createdCount > 0}
					<span class="tabular-nums badge badge-soft badge-success">{controller.createdCount} nuevas</span>
				{/if}
				{#if controller.deletedCount > 0}
					<span class="tabular-nums badge badge-soft badge-error">{controller.deletedCount} eliminadas</span>
				{/if}
			{/if}
		</div>
	{/if}
</div>
