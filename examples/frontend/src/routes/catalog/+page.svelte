<!--
@component
Catálogo con fotos (SB-38, SB-29). Dos vistas:

- **Modelos**: «Fotos» es una carpeta; la celda muestra su principal (el
  primero: miniatura si es imagen, ícono de su tipo si no) y el número de
  archivos. En el panel, «Hacer principal» lo cambia. «Modelo y año» toma su
  miniatura de la carpeta (`avatar: { image: 'fotos' }`).
- **Unidades**: «Modelo» es un `lookup` con el mismo `avatar.image`: la foto
  principal del modelo elegido.

Backend: examples/backend/src/examples/catalog/
-->
<script lang="ts">
	import { page } from '$app/state';
	import { Sheet, SpreadBase } from '@spreadbase/client';
	import { API_URL } from '$lib/config';

	const BASE = `${API_URL}/api/catalog`;
	const VIEWS = [
		{ id: 'modelos', label: 'Modelos' },
		{ id: 'unidades', label: 'Unidades' }
	] as const;
	const view = $derived(VIEWS.find((v) => v.id === page.url.searchParams.get('view'))?.id ?? 'modelos');

	const models = new Sheet(`${BASE}/models`);
	const units = new Sheet(`${BASE}/units`);
</script>

<div data-fill class="flex min-h-0 flex-1 flex-col gap-2 p-6">
	<header class="flex flex-wrap items-end justify-between gap-2">
		<div>
			<h1 class="text-lg font-semibold tracking-tight">Catálogo con fotos</h1>
			<p class="text-base-content/70 text-xs">
				Una carpeta por modelo con su archivo principal, y la miniatura del modelo tomada de ella
				(<code>avatar.image</code> sobre una columna <code>folder</code>). Backend: <code>examples/backend/src/examples/catalog/</code>.
			</p>
		</div>
		<nav class="join" aria-label="Vistas">
			{#each VIEWS as v (v.id)}
				<a href="?view={v.id}" class="btn btn-xs join-item" class:btn-active={view === v.id} data-sveltekit-replacestate>{v.label}</a>
			{/each}
		</nav>
	</header>

	<div class="bg-base-100 border-base-300 rounded-box min-h-0 flex-1 border p-3">
		{#key view}
			<SpreadBase sheet={view === 'unidades' ? units : models} fill />
		{/key}
	</div>
</div>
