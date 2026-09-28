<!--
@component
Ejemplo Postgres: la tienda servida por el backend JS estilo Aggy, con dos hojas.
- Productos: un campo de cada tipo; «Responsable» es un lookup a usuarios (SB-21).
- Usuarios: contraseña (SB-22) y casilla; sus rutas se montan con `sheetRouter`.
Backend: examples/backend/src/examples/postgres/
-->
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	import { page } from '$app/state';
	import { API_URL } from '$lib/config';

	const SHEETS = {
		products: {
			label: 'Productos',
			url: `${API_URL}/api/postgres/products/sheet`,
			text: 'Un campo de cada tipo; «Responsable» elige entre 2 000 usuarios en una mini tabla paginada (lookup). Cambiar un precio deja historial; un producto sin existencias no se puede activar; eliminar es borrado lógico.'
		},
		users: {
			label: 'Usuarios',
			url: `${API_URL}/api/postgres/users/sheet`,
			text: 'La contraseña se escribe en claro y el servidor guarda su hash: nunca vuelve al navegador, ni queda en el borrador local. «Activo» es una casilla: un clic la alterna. Contraseña de la semilla: demo-12345.'
		}
	} as const;
	type Key = keyof typeof SHEETS;

	const current = $derived<Key>(page.url.searchParams.get('sheet') === 'users' ? 'users' : 'products');
	// Una hoja nueva por pestaña: al desmontarse, la anterior se libera. Lo que
	// quedó sin guardar no se pierde: vuelve del borrador local al regresar.
	const sheet = $derived(new Sheet(SHEETS[current].url));
</script>

<div data-fill class="flex min-h-0 flex-1 flex-col gap-2 p-6">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold tracking-tight">Postgres · la tienda</h1>
			<p class="text-base-content/70 max-w-4xl text-xs">
				{SHEETS[current].text} Todo en una transacción por guardado. Necesita
				<code>DATABASE_URL</code> y <code>npm run postgres:setup</code>.
			</p>
		</div>
		<nav class="tabs tabs-box tabs-sm" aria-label="Hojas">
			{#each Object.entries(SHEETS) as [key, sheet] (key)}
				<a class="tab" class:tab-active={current === key} href={key === 'products' ? '?' : `?sheet=${key}`}>{sheet.label}</a>
			{/each}
		</nav>
	</header>
	<div class="bg-base-100 border-base-300 rounded-box min-h-0 flex-1 border p-3">
		{#key current}
			<SpreadBase {sheet} fill />
		{/key}
	</div>
</div>
