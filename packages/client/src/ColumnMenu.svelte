<!--
	ColumnMenu — el menú del encabezado de una columna (SB-33), como el de Excel:
	ordenar, filtrar por condición y filtrar por valores (lista con casillas y
	buscador). Una sola forma de filtro por columna: al aplicar gana la
	condición si hay una; si no, la lista, si no está completa.

	Flota junto al encabezado (`position: fixed`, `positionFloating`). Se cierra
	con Esc, con un clic fuera o al aplicar.
-->
<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import ArrowUpNarrowWide from '@lucide/svelte/icons/arrow-up-narrow-wide';
	import ArrowDownWideNarrow from '@lucide/svelte/icons/arrow-down-wide-narrow';
	import Search from '@lucide/svelte/icons/search';
	import { filterKind, filterOpLabel, filterOps, needsValue, type FilterOp } from '@spreadbase/core';
	import type { GridController } from './GridController.svelte';
	import type { ColumnDef, ColumnFilter, ValuesResult } from './types';
	import { positionFloating } from './internal/floating';

	interface Props {
		controller: GridController;
		column: ColumnDef;
		anchor: HTMLElement;
		onclose: () => void;
	}

	let { controller, column, anchor, onclose }: Props = $props();

	const kind = $derived(filterKind(column.type as never) ?? 'text');
	/** Condiciones del tipo (sin la lista de valores, que tiene su sección). */
	const conditionOps = $derived(filterOps(column.type as never).filter((op) => op !== 'in'));
	const current = $derived(controller.filterOf(column.field));
	const sortDir = $derived(controller.sort?.field === column.field ? controller.sort.dir : null);

	const sortLabels = $derived(
		kind === 'number'
			? ['De menor a mayor', 'De mayor a menor']
			: kind === 'date'
				? ['Más antiguo primero', 'Más reciente primero']
				: ['De la A a la Z', 'De la Z a la A']
	);

	// -- condición ----------------------------------------------------------
	// El formulario arranca con el filtro vigente; después es de la persona.
	const initial = untrack(() => controller.filterOf(column.field));
	let op = $state<FilterOp | ''>(initial && initial.op !== 'in' ? initial.op : '');
	// Un `<input type="number">` enlazado da número (o null): se lee siempre con `text()`.
	let value = $state<string | number | null>(initial?.value ?? '');
	let value2 = $state<string | number | null>(initial?.value2 ?? '');
	const text = (v: string | number | null) => (v === null || v === undefined ? '' : String(v).trim());
	const inputType = $derived(kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text');

	// -- valores ------------------------------------------------------------
	const NULL_KEY = '\u0000';
	const keyOf = (v: unknown) => (v === null || v === undefined ? NULL_KEY : String(v));
	let values = $state<ValuesResult | null>(null);
	let valuesError = $state<string | null>(null);
	/** El servidor no monta `GET /values/:field` (rutas a mano sin ella): solo condiciones. */
	let valuesUnavailable = $state(false);
	let search = $state('');
	/** Marcados. `null` = todos (sin filtro de lista). */
	let checked = $state<Set<string> | null>(initial?.op === 'in' ? new Set((initial.values ?? []).map(keyOf)) : null);

	const items = $derived.by(() => {
		const list = (values?.values ?? []).map((v) => ({ key: keyOf(v.value), value: v.value, count: v.count, label: controller.describeValue(column, v.value) }));
		// Un catálogo o un lookup se ordena por lo que se ve, no por el código; las vacías, primero.
		if (column.type === 'select' || column.type === 'lookup') {
			list.sort((a, b) => (a.value === null ? -1 : b.value === null ? 1 : a.label.localeCompare(b.label, 'es', { sensitivity: 'base' })));
		}
		return list;
	});
	const visible = $derived.by(() => {
		const needle = fold(search.trim());
		return needle ? items.filter((i) => fold(i.label).includes(needle)) : items;
	});
	const isChecked = (key: string) => checked === null || checked.has(key);
	const allVisibleChecked = $derived(visible.length > 0 && visible.every((i) => isChecked(i.key)));

	function fold(s: string) {
		return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
	}

	function toggle(key: string) {
		const next = new Set(checked ?? items.map((i) => i.key));
		if (next.has(key)) next.delete(key);
		else next.add(key);
		checked = next.size === items.length && !values?.truncated ? null : next;
		op = '';
	}

	function toggleVisible() {
		const next = new Set(checked ?? items.map((i) => i.key));
		const on = !allVisibleChecked;
		for (const i of visible) {
			if (on) next.add(i.key);
			else next.delete(i.key);
		}
		checked = next.size === items.length && !values?.truncated ? null : next;
		op = '';
	}

	// -- aplicar ------------------------------------------------------------
	let panel = $state<HTMLDivElement>();
	let error = $state<string | null>(null);

	function build(): ColumnFilter | null | undefined {
		if (op) {
			if (!needsValue(op)) return { field: column.field, op };
			if (text(value) === '' || (op === 'between' && text(value2) === '')) {
				error = 'Escribe el valor de la condición';
				return undefined;
			}
			const cast = (v: string | number | null) => (kind === 'number' ? Number(text(v)) : text(v));
			return op === 'between'
				? { field: column.field, op, value: cast(value), value2: cast(value2) }
				: { field: column.field, op, value: cast(value) };
		}
		if (checked === null) return null;
		const chosen = items.filter((i) => checked!.has(i.key)).map((i) => i.value);
		return { field: column.field, op: 'in', values: chosen };
	}

	async function apply() {
		error = null;
		const filter = build();
		if (filter === undefined) return;
		onclose();
		await controller.setFilter(column.field, filter);
	}

	async function clear() {
		onclose();
		await controller.setFilter(column.field, null);
	}

	async function sortBy(dir: 'asc' | 'desc' | null) {
		onclose();
		await controller.setSort(dir ? { field: column.field, dir } : null);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onclose();
		} else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') {
			e.preventDefault();
			void apply();
		}
	}

	const place = () => panel && positionFloating(panel, anchor, { placement: 'bottom-start', gap: 2 });

	onMount(() => {
		const abort = new AbortController();
		const request = controller.loadValues(column.field, abort.signal);
		if (request) {
			request
				.then((result) => {
					values = result;
					// Una lista guardada con valores que ya no existen: se conservan los que siguen.
					tick().then(place);
				})
				.catch((err) => {
					if (abort.signal.aborted) return;
					if ((err as { status?: number }).status === 404) valuesUnavailable = true;
					else valuesError = err instanceof Error ? err.message : 'No se pudieron cargar los valores';
				});
		}
		tick().then(() => {
			place();
			panel?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
		});
		const outside = (e: PointerEvent) => {
			const target = e.target as Node;
			if (panel?.contains(target) || anchor.contains(target)) return;
			onclose();
		};
		window.addEventListener('pointerdown', outside, true);
		window.addEventListener('resize', place);
		/*
			jspreadsheet escucha el teclado en todo el documento: con una celda
			activa, cada tecla escrita aquí la editaría y el foco se iría a la hoja.
			Las teclas del menú no salen de él. Nativo y no con `onkeydown`: Svelte
			delega ese evento y la hoja lo vería antes.
		*/
		const keep = (e: Event) => {
			e.stopPropagation();
			if (e.type === 'keydown') onkeydown(e as KeyboardEvent);
		};
		const keys = ['keydown', 'keypress', 'keyup'] as const;
		for (const type of keys) panel?.addEventListener(type, keep);
		return () => {
			for (const type of keys) panel?.removeEventListener(type, keep);
			abort.abort();
			window.removeEventListener('pointerdown', outside, true);
			window.removeEventListener('resize', place);
		};
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	bind:this={panel}
	class="oc-colmenu-panel card card-border border-base-300 bg-base-100 w-72 text-sm shadow-lg"
	role="dialog"
	aria-label={`Ordenar y filtrar «${column.label}»`}
	tabindex="-1"
	onmousedown={(e) => e.stopPropagation()}
>
	<div class="flex flex-col gap-3 p-3">
		<section class="flex flex-col gap-1" aria-label="Ordenar">
			<button type="button" class="btn btn-ghost btn-sm justify-start" class:btn-active={sortDir === 'asc'} onclick={() => sortBy('asc')}>
				<ArrowUpNarrowWide size={16} aria-hidden="true" />
				{sortLabels[0]}
			</button>
			<button type="button" class="btn btn-ghost btn-sm justify-start" class:btn-active={sortDir === 'desc'} onclick={() => sortBy('desc')}>
				<ArrowDownWideNarrow size={16} aria-hidden="true" />
				{sortLabels[1]}
			</button>
			{#if sortDir}
				<button type="button" class="btn btn-link btn-xs self-start px-0" onclick={() => sortBy(null)}>Quitar orden</button>
			{/if}
		</section>

		<div class="border-t border-base-300"></div>

		<section class="flex flex-col gap-2" aria-label="Condición">
			<label class="text-xs font-medium text-base-content/70" for="oc-colmenu-op">Filtrar por condición</label>
			<select id="oc-colmenu-op" class="select select-sm w-full" bind:value={op} onchange={() => (error = null)}>
				<option value="">Ninguna</option>
				{#each conditionOps as o (o)}
					<option value={o}>{filterOpLabel(o, kind)}</option>
				{/each}
			</select>
			{#if op && needsValue(op)}
				<div class="flex items-center gap-2">
					<input
						class="input input-sm w-full"
						type={inputType}
						step={kind === 'number' ? 'any' : undefined}
						aria-label="Valor"
						placeholder={kind === 'text' ? 'Texto' : undefined}
						bind:value
						data-autofocus
					/>
					{#if op === 'between'}
						<span class="text-xs text-base-content/70">y</span>
						<input class="input input-sm w-full" type={inputType} step={kind === 'number' ? 'any' : undefined} aria-label="Hasta" bind:value={value2} />
					{/if}
				</div>
			{/if}
		</section>

		{#if controller.remote?.values && !valuesUnavailable}
			<div class="border-t border-base-300"></div>
			<section class="flex flex-col gap-2" aria-label="Valores">
				<span class="text-xs font-medium text-base-content/70">Filtrar por valores</span>
				<label class="input input-sm w-full">
					<Search size={14} class="opacity-60" aria-hidden="true" />
					<input type="search" placeholder="Buscar" aria-label="Buscar valores" bind:value={search} data-autofocus={op ? undefined : true} />
				</label>
				<div class="max-h-56 overflow-y-auto rounded-box border border-base-300">
					{#if valuesError}
						<p class="p-3 text-xs text-error">{valuesError}</p>
					{:else if !values}
						<p class="flex items-center gap-2 p-3 text-xs text-base-content/70">
							<span class="loading loading-spinner loading-xs"></span> Cargando valores…
						</p>
					{:else if visible.length === 0}
						<p class="p-3 text-xs text-base-content/70">Sin coincidencias</p>
					{:else}
						<label class="flex cursor-pointer items-center gap-2 border-b border-base-300 px-3 py-1.5">
							<input type="checkbox" class="checkbox checkbox-xs" checked={allVisibleChecked} onchange={toggleVisible} />
							<span class="font-medium">{search.trim() ? 'Seleccionar lo encontrado' : 'Seleccionar todo'}</span>
						</label>
						<ul class="py-1">
							{#each visible as item (item.key)}
								<li>
									<label class="flex cursor-pointer items-center gap-2 px-3 py-1 hover:bg-base-200">
										<input type="checkbox" class="checkbox checkbox-xs" checked={isChecked(item.key)} onchange={() => toggle(item.key)} />
										<span class="min-w-0 flex-1 truncate" class:italic={item.value === null}>{item.label}</span>
										<span class="tabular-nums text-xs text-base-content/60">{item.count}</span>
									</label>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
				{#if values?.truncated}
					<p class="text-xs text-base-content/70">Solo los primeros {values.values.length} valores: usa una condición para acotar.</p>
				{/if}
			</section>
		{/if}

		{#if error}
			<p role="alert" class="text-xs text-error">{error}</p>
		{/if}

		<div class="flex items-center justify-end gap-2">
			{#if current}
				<button type="button" class="btn btn-ghost btn-sm mr-auto" onclick={clear}>Quitar filtro</button>
			{/if}
			<button type="button" class="btn btn-ghost btn-sm" onclick={onclose}>Cancelar</button>
			<button type="button" class="btn btn-neutral btn-sm" onclick={apply}>Aplicar</button>
		</div>
	</div>
</div>

<style>
	.oc-colmenu-panel {
		position: fixed;
		z-index: 60;
	}
</style>
