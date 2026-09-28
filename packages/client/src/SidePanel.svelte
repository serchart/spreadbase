<!--
	SidePanel — marco del panel lateral de la hoja (cambios, filtros).

	Los paneles comparten hueco, ancho, encabezado y cierre; solo cambia el
	contenido. Tenerlo en un solo sitio evita que el segundo panel diverja del
	primero en medio píxel de padding.

	La animación de entrada y salida no está aquí sino en quien lo monta: el
	contenido cambia de un panel a otro sin animar, y solo abrir y cerrar se
	anima.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import X from '@lucide/svelte/icons/x';

	interface Props {
		title: string;
		subtitle?: string;
		onclose: () => void;
		/** Franja bajo el encabezado (filtros, pestañas). */
		toolbar?: Snippet;
		children: Snippet;
	}

	let { title, subtitle, onclose, toolbar, children }: Props = $props();
</script>

<aside
	class="flex min-h-0 w-96 shrink-0 flex-col overflow-hidden rounded-box border border-base-300 bg-base-100 text-sm xl:w-[480px]"
	aria-label={title}
>
	<header class="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
		<div class="min-w-0">
			<h2 class="text-base font-semibold">{title}</h2>
			{#if subtitle}
				<p class="tabular text-xs text-base-content/70">{subtitle}</p>
			{/if}
		</div>
		<button
			type="button"
			class="btn btn-square btn-ghost btn-sm"
			onclick={onclose}
			aria-label="Cerrar panel"
		>
			<X size={16} aria-hidden="true" />
		</button>
	</header>

	{#if toolbar}
		<div class="border-b border-base-300 px-4 pb-3">
			{@render toolbar()}
		</div>
	{/if}

	<!-- Área de contenido en `base-200`: las tarjetas `base-100` contrastan contra ella. -->
	<div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-base-200">
		{@render children()}
	</div>
</aside>
