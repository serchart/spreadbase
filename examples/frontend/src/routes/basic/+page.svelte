<!--
@component
Ejemplo básico: la página no define columnas; las pide al servidor.
Backend: examples/backend/src/examples/basic/

Lo único del cliente: un botón «Abrir» por fila (`actions`) y dos ajustes
sobre columnas del servidor, uno como parche y otro como función (SB-23); y
botones propios en la barra, junto a Guardar (SB-24). «Límite en cero» escribe
en la hoja desde fuera con `grid.commands.setValues` (SB-27). Con `?status=`
en la URL, la hoja muestra solo ese estado (filtro fijo, SB-28).
-->
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	import type { GridRow } from '@spreadbase/client';
	import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
	import X from '@lucide/svelte/icons/x';
	import Eraser from '@lucide/svelte/icons/eraser';
	import { page } from '$app/state';
	import { API_URL } from '$lib/config';

	let opened = $state<GridRow | null>(null);

	// `?status=active`: filtro fijo de la hoja (SB-28). Se lee al cargar la página.
	const status = page.url.searchParams.get('status');
	const sheet = new Sheet(`${API_URL}/api/basic/contacts`, {
		filters: status ? { status } : undefined,
		actions: [{ label: 'Abrir', icon: SquareArrowOutUpRight, onclick: (row) => (opened = row) }],
		columns: {
			// Parche: se mezcla sobre la columna del servidor.
			name: { width: 260 },
			// Función: recibe la columna del servidor y devuelve la final. Con el filtro
			// fijo sobra (todas dirían lo mismo): se oculta, y las altas nacen con ese estado.
			status: status ? { hidden: true } : (col) => ({ ...col, label: `${col?.label} del contacto` })
		},
		// La acción queda fija junto al número de fila al desplazar.
		frozenColumns: 1
	});

	// Botón propio en la sección de acciones de la barra (SB-24). Un `$derived`
	// para que `disabled` siga al estado de la página.
	const toolbar = $derived({
		actions: [
			{ label: 'Cerrar contacto', icon: X, disabled: !opened, onclick: () => (opened = null) },
			// Escribe en la fila abierta como si se tecleara: se repinta, queda por guardar y ⌘Z lo deshace (SB-27).
			{
				label: 'Límite en cero',
				icon: Eraser,
				disabled: !opened,
				onclick: () => void sheet.grid?.commands.setValues([{ rowKey: String(opened!.id), field: 'credit_limit', value: 0 }])
			}
		]
	});
</script>

<div data-fill class="flex min-h-0 flex-1 flex-col gap-2 p-6">
	<header>
		<h1 class="text-lg font-semibold tracking-tight">Básico · contactos</h1>
		<p class="text-base-content/70 text-xs">
			1 000 contactos en memoria. El correo se valida con un patrón que define el servidor.
		</p>
	</header>
	<p class="text-sm" aria-live="polite" data-testid="opened">
		{#if opened}Abierto: <strong>{opened.name}</strong> · {opened.email}{:else}Pulsa «Abrir» en una fila.{/if}
	</p>
	<div class="bg-base-100 border-base-300 rounded-box min-h-0 flex-1 border p-3">
		<SpreadBase {sheet} fill {toolbar} />
	</div>
</div>
