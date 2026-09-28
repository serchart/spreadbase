<!--
@component
Layout de los ejemplos: cabecera con navegación y selector de tema; cada
ejemplo ocupa el resto de la pantalla.
-->
<script lang="ts">
	import '../app.css';
	// Tema de la hoja a partir de los tokens de daisyUI.
	import '@spreadbase/client/theme-daisyui.css';
	import { page } from '$app/state';
	import { Sheet } from '@lucide/svelte';
	import ThemeSwitcher from '$lib/components/ui/ThemeSwitcher.svelte';
	import { theme } from '$lib/stores/theme.svelte';
	import { EXAMPLES } from '$lib/examples';

	let { children } = $props();

	// El tema ya lo aplicó el script en línea de app.html. Esto solo sincroniza
	// el store con el DOM para que el selector nazca marcando la opción real.
	$effect(() => {
		theme.init();
	});
</script>

<!-- h-dvh: la ventana no scrollea; scrollea `main`. Permite hojas a pantalla completa (data-fill). -->
<div class="bg-base-200 flex h-dvh flex-col">
	<header
		class="bg-base-100/80 border-base-300 z-40 flex items-center justify-between gap-4 border-b px-6 py-2.5 backdrop-blur"
	>
		<div class="flex items-center gap-6">
			<a href="/" class="flex items-center gap-2">
				<span class="bg-primary text-primary-content rounded-field grid h-8 w-8 place-items-center">
					<Sheet size={16} />
				</span>
				<div class="leading-tight">
					<div class="text-sm font-semibold">SpreadBase</div>
					<div class="eyebrow">Ejemplos</div>
				</div>
			</a>
			<nav class="tabs tabs-box tabs-sm">
				{#each EXAMPLES as example (example.href)}
					<a href={example.href} class="tab" class:tab-active={page.url.pathname === example.href}>{example.title}</a>
				{/each}
			</nav>
		</div>
		<ThemeSwitcher />
	</header>

	<!--
		`main` scrollea para vistas de documento (el índice); una vista con
		`data-fill` ocupa todo el alto, sin padding, y cada zona scrollea por dentro.
	-->
	<main
		class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-6 pt-6 pb-16 has-[>[data-fill]]:overflow-hidden has-[>[data-fill]]:p-0"
	>
		{@render children()}
	</main>
</div>
