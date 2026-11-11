<!--
@component
Íconos tomados de los datos (SB-39). Tres vistas:

- **Casos**: `new Sheet(url)`. «Etapa» es un `lookup` con
  `avatar: { iconField: 'icon' }`: cada celda lleva el ícono de la etapa
  elegida (también en la mini tabla del buscador). «Prioridad» trae un ícono
  por opción. El botón de cada fila dice su folio (`label: (row) => …`).
- **Etapas**: la tabla de etapas; el nombre lleva el ícono de su propio campo.
- **Fuente directa**: la misma hoja de casos con un `RemoteDataSource` escrito a
  mano (`fetch`): los nombres e íconos de «Etapa» que manda el servidor
  (`labels`, `icons`) se usan igual que con `Sheet(url)`.

Backend: examples/backend/src/examples/stages/
-->
<script lang="ts">
	import { page } from '$app/state';
	import { Sheet, SpreadBase, registerIcons, type GridRow, type PageRequest } from '@spreadbase/client';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import CalendarCheck from '@lucide/svelte/icons/calendar-check';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import FileText from '@lucide/svelte/icons/file-text';
	import Hourglass from '@lucide/svelte/icons/hourglass';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Minus from '@lucide/svelte/icons/minus';
	import { API_URL } from '$lib/config';

	// El servidor nombra los íconos; la página dice cuál es cuál.
	registerIcons({
		inbox: Inbox,
		hourglass: Hourglass,
		'calendar-check': CalendarCheck,
		'circle-check': CircleCheck,
		'arrow-up': ArrowUp,
		'arrow-down': ArrowDown,
		minus: Minus
	});

	const BASE = `${API_URL}/api/stages`;
	const VIEWS = [
		{ id: 'casos', label: 'Casos' },
		{ id: 'etapas', label: 'Etapas' },
		{ id: 'directa', label: 'Fuente directa' }
	] as const;
	const view = $derived(VIEWS.find((v) => v.id === page.url.searchParams.get('view'))?.id ?? 'casos');

	let opened = $state<GridRow | null>(null);

	// El botón de cada fila dice su folio («#1001») y abre el detalle.
	const cases = new Sheet(`${BASE}/cases`, {
		actions: [{ label: (row) => `#${row.folio ?? ''}`, icon: FileText, onclick: (row) => (opened = row) }]
	});
	const stages = new Sheet(`${BASE}/stages`);

	/** Un `RemoteDataSource` a mano: solo `fetch` y el mismo protocolo. */
	async function getJson<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
		const res = await fetch(`${BASE}/cases${path}?${new URLSearchParams(params)}`, { signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return res.json();
	}
	const direct = new Sheet({
		id: 'stages.direct',
		persist: 'none',
		columns: [
			{ field: 'id', label: 'ID', type: 'text', width: 80, readOnly: true },
			{ field: 'title', label: 'Asunto', type: 'text', width: 160, readOnly: true },
			{
				field: 'stage_id',
				label: 'Etapa',
				type: 'lookup',
				width: 190,
				avatar: { iconField: 'icon', initials: true, shape: 'square' },
				lookup: {
					value: 'id',
					display: 'name',
					columns: { name: { type: 'text', label: 'Etapa', width: 200 } },
					search: (q, { offset, limit }, signal) =>
						getJson('/lookup/stage_id', { q, offset: String(offset), limit: String(limit) }, signal)
				}
			}
		],
		dataSource: {
			loadPage: ({ offset, limit }: PageRequest, signal: AbortSignal) =>
				getJson('', { offset: String(offset), limit: String(limit) }, signal),
			strategy: 'window'
		}
	});
</script>

<div data-fill class="flex min-h-0 flex-1 flex-col gap-2 p-6">
	<header class="flex flex-wrap items-end justify-between gap-2">
		<div>
			<h1 class="text-lg font-semibold tracking-tight">Etapas e íconos</h1>
			<p class="text-base-content/70 text-xs">
				Un ícono por fila tomado de un campo (<code>avatar.iconField</code>), un ícono por opción y el folio de la fila en el
				botón. Backend: <code>examples/backend/src/examples/stages/</code>.
			</p>
		</div>
		<nav class="join" aria-label="Vistas">
			{#each VIEWS as v (v.id)}
				<a href="?view={v.id}" class="btn btn-xs join-item" class:btn-active={view === v.id} data-sveltekit-replacestate>{v.label}</a>
			{/each}
		</nav>
	</header>

	{#if opened}
		<aside class="alert" data-testid="detalle">
			<span><strong>#{opened.folio}</strong> · {opened.title}</span>
			<button type="button" class="btn btn-ghost btn-xs" onclick={() => (opened = null)}>Cerrar</button>
		</aside>
	{/if}

	<div class="bg-base-100 border-base-300 rounded-box min-h-0 flex-1 border p-3">
		{#key view}
			<SpreadBase sheet={view === 'etapas' ? stages : view === 'directa' ? direct : cases} fill />
		{/key}
	</div>
</div>
