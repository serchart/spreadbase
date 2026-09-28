<!--
	ChangesPanel — registro de cambios pendientes, agrupado por fila.

	Se monta **solo mientras está abierto**, y no es un detalle de estilo: su
	fuente, `changeLog`, formatea cada celda listada y con 5 000 filas afectadas
	cuesta ~20 ms (`07-anexo-datagrid-engine.md` §9). Montado de forma permanente,
	ese coste se pagaría en cada celda confirmada. Los contadores de la toolbar
	usan `rowSummary`, que sí es barato, y no dependen de este componente.
-->
<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import GitMerge from '@lucide/svelte/icons/git-merge';
	import ChangesSubsheet from './ChangesSubsheet.svelte';
	import SidePanel from './SidePanel.svelte';
	import { expand } from './internal/motion';
	import type { GridController } from './GridController.svelte';
	import type { CellValue, ChangesFilter, RowChange, RowChangeState } from './types';

	type Filter = ChangesFilter;

	interface Props {
		controller: GridController;
		/**
		 * Lleva la selección a una celda, por columna y **clave** de fila. Con
		 * fuente remota la fila puede no estar cargada: `reveal` permite cargar la
		 * ventana a su alrededor; sin él, solo salta si ya está a la vista.
		 */
		onjump: (x: number, rowKey: string, reveal?: boolean) => void;
		/** Escribe un valor editado en la subtabla. La fila puede estar fuera de la ventana. */
		onedit: (x: number, rowKey: string, value: CellValue) => void;
		/** Resuelve un conflicto: toda la fila o un campo (G-17). */
		onresolve: (rowKey: string, choice: 'mine' | 'remote', field?: string) => void;
		onclose: () => void;
	}

	let { controller, onjump, onedit, onresolve, onclose }: Props = $props();

	/*
		Se dibuja por tramos. Calcular 5 000 filas cuesta 20 ms; crear sus nodos
		costaría bastante más, y nadie revisa 5 000 tarjetas de un vistazo. El
		tramo se amplía a petición.
	*/
	const PAGE = 100;

	const STATE_LABEL: Record<RowChangeState, string> = {
		created: 'Nueva',
		updated: 'Editada',
		deleted: 'Eliminada',
		unchanged: 'Sin cambios'
	};

	const STATE_BADGE: Record<RowChangeState, string> = {
		created: 'badge badge-soft badge-sm badge-success',
		updated: 'badge badge-soft badge-sm badge-warning',
		deleted: 'badge badge-soft badge-sm badge-error',
		unchanged: 'badge badge-soft badge-sm badge-neutral'
	};

	const filter = $derived(controller.changesFilter);
	let limit = $state(PAGE);
	const expanded = new SvelteSet<string>();

	const columnX = $derived(new Map(controller.columns.map((c, i) => [c.field, i])));

	const summary = $derived(controller.rowSummary);
	const log = $derived(controller.changeLog);

	const filters = $derived<{ id: Filter; label: string; count: number }[]>([
		{ id: 'all', label: 'Todos', count: summary.total },
		{ id: 'created', label: 'Nuevas', count: summary.created },
		{ id: 'updated', label: 'Editadas', count: summary.updated },
		{ id: 'deleted', label: 'Eliminadas', count: summary.deleted },
		{ id: 'errors', label: 'Errores', count: summary.withErrors },
		{ id: 'conflicts', label: 'Conflictos', count: summary.conflicts }
	]);

	/** Texto de las dos opciones de fila según el motivo del conflicto (G-17). */
	function conflictActions(row: RowChange): { mine: string; remote: string; hint: string } {
		const c = row.conflict!;
		if (c.reason === 'not_found') {
			return { mine: 'Recrear como nueva', remote: 'Descartar mis cambios', hint: 'Otro usuario eliminó esta fila.' };
		}
		if (c.op === 'delete') {
			return { mine: 'Eliminar de todos modos', remote: 'Cancelar eliminación', hint: 'Otro usuario editó esta fila mientras la eliminabas.' };
		}
		if (c.reason === 'version_mismatch') {
			return { mine: 'Conservar mis cambios', remote: 'Usar la versión remota', hint: 'Otro usuario cambió esta fila.' };
		}
		return { mine: 'Todo mío', remote: 'Todo remoto', hint: 'Tú y otro usuario cambiaron los mismos campos.' };
	}

	const shownFilters = $derived(
		filters.filter((f) => f.id === 'all' || f.count > 0 || f.id === filter)
	);

	const headline = $derived(
		summary.total === 0
			? 'Todo guardado'
			: `${summary.total} ${summary.total === 1 ? 'fila' : 'filas'} por guardar` +
					(summary.withErrors > 0 ? ` · ${summary.withErrors} con error` : '')
	);

	function matches(row: RowChange, f: Filter): boolean {
		if (f === 'all') return true;
		if (f === 'errors') return row.errorCells > 0;
		if (f === 'conflicts') return !!row.conflict;
		return row.state === f;
	}

	const filtered = $derived(log.filter((row) => matches(row, filter)));
	const visible = $derived(filtered.slice(0, limit));

	function selectFilter(f: Filter) {
		controller.changesFilter = f;
		limit = PAGE;
	}

	function toggle(key: string) {
		if (expanded.has(key)) expanded.delete(key);
		else expanded.add(key);
	}

	/** Salta a la primera celda con error de la fila o, si no hay, a la primera cambiada. */
	/** Se puede ir a la fila: tiene posición, o es nueva (vive al inicio de la hoja). */
	const reachable = (row: RowChange) => row.position !== null || row.state === 'created';

	function jumpToRow(row: RowChange) {
		if (!reachable(row)) return;
		const target = row.cells.find((c) => c.state === 'error') ?? row.cells[0];
		// Encabezado de la tarjeta: navegación explícita, así que carga la fila si hace falta.
		onjump(target ? (columnX.get(target.field) ?? 0) : 0, row.key, true);
	}

	/*
		Seleccionar una celda de la subtabla salta a ella solo si ya está cargada:
		disparar una carga de red en cada clic dentro de la subtabla —por ejemplo,
		al abrir su editor— movería la hoja bajo el usuario.
	*/
	function jumpToField(field: string, rowKey: string) {
		onjump(columnX.get(field) ?? 0, rowKey, false);
	}

	function editField(field: string, rowKey: string, value: CellValue) {
		const x = columnX.get(field);
		if (x !== undefined) onedit(x, rowKey, value);
	}

	function rowTitle(row: RowChange): string {
		if (row.position !== null) return `Fila ${(row.position + 1).toLocaleString('es-MX')}`;
		return row.state === 'created' ? 'Fila nueva' : 'Fuera de la hoja';
	}

	function okText(row: RowChange): string {
		const noun = row.state === 'deleted' ? 'campo' : 'cambio';
		return `${row.okCells} ${noun}${row.okCells === 1 ? '' : 's'}`;
	}
</script>

<SidePanel title="Cambios pendientes" subtitle={headline} {onclose}>
	{#snippet toolbar()}
		<!--
			Chips en vez de pestañas, al estilo de los filtros de WhatsApp: envuelven
			en lugar de desbordar, así que nunca hace falta scroll horizontal. Las
			categorías vacías no se muestran —una opción que no lleva a nada solo
			ocupa sitio—, salvo la activa, para no dejar al usuario sin referencia.
		-->
		<div
			role="tablist"
			aria-label="Filtrar cambios"
			class="flex flex-wrap gap-2"
		>
			{#each shownFilters as f (f.id)}
				{@const active = filter === f.id}
				<button
					type="button"
					role="tab"
					class="btn btn-sm rounded-selector gap-2 {active
						? 'btn-neutral'
						: 'btn-ghost border-base-300 font-normal'}"
					aria-selected={active}
					onclick={() => selectFilter(f.id)}
				>
					{#if f.id === 'errors'}
						<CircleAlert size={14} class={active ? '' : 'text-error'} aria-hidden="true" />
					{:else if f.id === 'conflicts'}
						<GitMerge size={14} class={active ? '' : 'oc-text-conflict'} aria-hidden="true" />
					{/if}
					{f.label}
					<span class="tabular-nums {active ? 'opacity-80' : 'text-base-content/70'}">{f.count}</span>
				</button>
			{/each}
		</div>
	{/snippet}

	<div role="tabpanel">
		{#if filtered.length === 0}
			<p class="py-8 text-center text-base-content/70">
				{filter === 'all' ? 'No hay cambios pendientes.' : 'Nada en esta categoría.'}
			</p>
		{:else}
			<ul class="list gap-2 p-3">
				{#each visible as row (row.key)}
					{@const open = expanded.has(row.key)}
					<li
						class="list-row grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0 border border-base-300 bg-base-100 transition-colors duration-(--oc-t-fast) ease-(--oc-ease) after:hidden hover:border-base-content/30"
					>
						<button
							type="button"
							class="btn btn-square btn-ghost btn-xs"
							aria-expanded={open}
							aria-label={open ? 'Contraer' : 'Expandir'}
							onclick={() => toggle(row.key)}
						>
							<span
								class="inline-flex transition-transform duration-(--oc-t-fast) ease-(--oc-ease)"
								class:rotate-90={open}
							>
								<ChevronRight size={14} aria-hidden="true" />
							</span>
						</button>
						<!--
							El encabezado navega y el chevron despliega: son dos intenciones
							distintas y mezclarlas en un solo clic obligaría a elegir cuál
							se pierde.
						-->
						<button
							type="button"
							class="group flex min-w-0 flex-col gap-1 text-left disabled:cursor-default"
							disabled={!reachable(row)}
							onclick={() => jumpToRow(row)}
							title={!reachable(row)
								? undefined
								: row.rowIndex === null
									? 'Ir a la fila (se cargará)'
									: 'Ir a la fila'}
						>
							<span class="flex items-center gap-2">
								{#if row.conflict}
									<span class="badge badge-sm oc-badge-conflict">Conflicto</span>
								{:else}
									<span class={STATE_BADGE[row.state]}>{STATE_LABEL[row.state]}</span>
								{/if}
								<span class="tabular-nums font-semibold group-enabled:group-hover:underline"
									>{rowTitle(row)}</span
								>
								{#if row.errorCells > 0}
									<span class="tabular-nums ml-auto badge badge-soft badge-sm badge-error">
										<CircleAlert size={12} aria-hidden="true" />
										{row.errorCells}
										{row.errorCells === 1 ? 'error' : 'errores'}
									</span>
								{/if}
							</span>
							<span class="flex min-w-0 items-center gap-2 text-xs text-base-content/70">
								<span class="ident truncate">{row.id ?? 'sin id'}</span>
								{#if row.okCells > 0}
									<span aria-hidden="true">·</span>
									<span class="tabular-nums shrink-0">{okText(row)}</span>
								{/if}
							</span>
						</button>

						{#if open}
							<div class="list-col-wrap col-span-full min-w-0 pt-3" transition:expand>
								{#if row.conflict}
									{@const actions = conflictActions(row)}
									<!--
										Resolver: Original · Tuyo · Remoto (G-17). En un conflicto de
										campos se elige por campo o toda la fila; en los demás, una de
										dos opciones para la fila entera.
									-->
									<p class="mb-2 text-xs text-base-content/70">{actions.hint}</p>
									{#if row.conflict.fields.length > 0}
										<!--
											Por campo, en vertical: el panel es estrecho y los valores
											largos no caben en columnas. El original, tenue, da el
											contexto; las dos opciones se pulsan y muestran su valor
											completo.
										-->
										<div class="flex flex-col gap-2">
											{#each row.conflict.fields as f (f.field)}
												<div class="rounded-field border border-base-300 p-2">
													<div class="flex items-baseline justify-between gap-2 text-xs">
														<span class="font-semibold">{f.label}</span>
														<span class="min-w-0 truncate text-base-content/60" title={f.originalText}>
															Original: {f.originalText || '—'}
														</span>
													</div>
													<div class="mt-1.5 grid grid-cols-2 gap-1.5">
														{#each [{ choice: 'mine', label: 'Mío', text: f.yoursText }, { choice: 'remote', label: 'Remoto', text: f.remoteText }] as option (option.choice)}
															{@const chosen = f.choice === option.choice}
															<button
																type="button"
																class="btn h-auto min-h-0 flex-col items-start gap-0.5 px-2 py-1.5 text-left font-normal btn-sm {chosen
																	? 'btn-neutral'
																	: 'btn-ghost border-base-300'}"
																aria-pressed={chosen}
																onclick={() => onresolve(row.key, option.choice as 'mine' | 'remote', f.field)}
															>
																<span class="text-[0.65rem] font-semibold tracking-wide uppercase opacity-70">
																	{option.label}
																</span>
																<span class="w-full text-xs break-words whitespace-normal">{option.text || '—'}</span>
															</button>
														{/each}
													</div>
												</div>
											{/each}
										</div>
									{/if}
									<div class="mt-2 flex flex-wrap gap-2">
										<button type="button" class="btn btn-xs" onclick={() => onresolve(row.key, 'mine')}>
											{actions.mine}
										</button>
										<button type="button" class="btn btn-xs" onclick={() => onresolve(row.key, 'remote')}>
											{actions.remote}
										</button>
									</div>
								{:else}
									<ChangesSubsheet {controller} {row} onjump={jumpToField} onedit={editField} />
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>

			{#if filtered.length > visible.length}
				<button
					type="button"
					class="btn m-3 btn-ghost btn-sm"
					onclick={() => (limit += PAGE)}
				>
					Mostrar {Math.min(PAGE, filtered.length - visible.length)} más
					<span class="tabular-nums text-base-content/70">({visible.length} de {filtered.length})</span>
				</button>
			{/if}
		{/if}
	</div>
</SidePanel>
