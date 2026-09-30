<!--
	FiltersPanel — los filtros y el orden vigentes de la hoja (SB-33).

	Se ponen desde el encabezado de cada columna; aquí se ven juntos, en
	palabras, y se quitan uno por uno o todos.
-->
<script lang="ts">
	import ListFilter from '@lucide/svelte/icons/list-filter';
	import ArrowUpNarrowWide from '@lucide/svelte/icons/arrow-up-narrow-wide';
	import ArrowDownWideNarrow from '@lucide/svelte/icons/arrow-down-wide-narrow';
	import X from '@lucide/svelte/icons/x';
	import SidePanel from './SidePanel.svelte';
	import type { GridController } from './GridController.svelte';

	interface Props {
		controller: GridController;
		onclose: () => void;
	}

	let { controller, onclose }: Props = $props();

	const sortColumn = $derived(controller.sort ? controller.columns.find((c) => c.field === controller.sort!.field) : null);
	const subtitle = $derived(
		controller.activeFilterCount === 0
			? 'Sin filtros: se ven todas las filas'
			: `${controller.activeFilterCount} ${controller.activeFilterCount === 1 ? 'filtro' : 'filtros'} · ${controller.total} ${controller.total === 1 ? 'fila' : 'filas'}`
	);
</script>

<SidePanel title="Filtros" {subtitle} {onclose}>
	{#if !controller.queryable}
		<div class="flex flex-col items-center gap-2 px-6 py-12 text-center">
			<ListFilter size={24} class="text-base-content/50" aria-hidden="true" />
			<p class="text-xs text-base-content/70">Esta hoja no se filtra: sus datos no vienen de un servidor de SpreadBase.</p>
		</div>
	{:else}
		<div class="flex flex-col gap-3 p-4">
			{#if controller.activeFilterCount === 0 && !sortColumn}
				<div class="flex flex-col items-center gap-2 px-2 py-8 text-center">
					<ListFilter size={24} class="text-base-content/50" aria-hidden="true" />
					<p class="font-semibold">Sin filtros</p>
					<p class="text-xs text-base-content/70">
						Abre el menú ⌄ del encabezado de una columna para ordenar o filtrar por valores o por una condición.
					</p>
				</div>
			{/if}

			{#if controller.activeFilterCount > 0}
				<ul class="flex flex-col gap-2" aria-label="Filtros activos">
					{#each controller.where as filter (filter.field)}
						<li class="card card-border border-base-300 bg-base-100 flex-row items-center gap-2 px-3 py-2">
							<ListFilter size={14} class="shrink-0" aria-hidden="true" />
							<span class="min-w-0 flex-1">{controller.describeFilter(filter)}</span>
							<button
								type="button"
								class="btn btn-ghost btn-square btn-xs"
								aria-label={`Quitar filtro: ${controller.describeFilter(filter)}`}
								onclick={() => controller.setFilter(filter.field, null)}
							>
								<X size={14} aria-hidden="true" />
							</button>
						</li>
					{/each}
				</ul>
				<button type="button" class="btn btn-ghost btn-sm self-start" onclick={() => controller.clearFilters()}>Quitar todos los filtros</button>
			{/if}

			{#if sortColumn && controller.sort}
				<div class="card card-border border-base-300 bg-base-100 flex-row items-center gap-2 px-3 py-2">
					{#if controller.sort.dir === 'asc'}
						<ArrowUpNarrowWide size={14} class="shrink-0" aria-hidden="true" />
					{:else}
						<ArrowDownWideNarrow size={14} class="shrink-0" aria-hidden="true" />
					{/if}
					<span class="min-w-0 flex-1">Ordenada por {sortColumn.label}, {controller.sort.dir === 'asc' ? 'ascendente' : 'descendente'}</span>
					<button type="button" class="btn btn-ghost btn-square btn-xs" aria-label="Quitar orden" onclick={() => controller.setSort(null)}>
						<X size={14} aria-hidden="true" />
					</button>
				</div>
			{/if}
		</div>
	{/if}
</SidePanel>
