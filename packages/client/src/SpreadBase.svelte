<!--
@component
La hoja de SpreadBase. Dibuja un `Sheet`: se conecta al montarse (pide el
esquema si es remoto) y muestra la hoja, su barra y sus paneles.

```svelte
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	const sheet = new Sheet('/api/cases');
</script>

<SpreadBase {sheet} fill />
```
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import SpreadsheetGrid from './SpreadsheetGrid.svelte';
	import type { Sheet } from './Sheet.svelte';
	import type { DataGridTheme, GridToolbarConfig } from './types';

	interface Props {
		sheet: Sheet;
		/** `true` (default) barra completa, `false` sin barra, u objeto para elegir botones. */
		toolbar?: boolean | GridToolbarConfig;
		/** Ocupa todo el alto disponible del contenedor y scrollea por dentro. */
		fill?: boolean;
		theme?: DataGridTheme;
		title?: string;
		description?: string;
	}

	let { sheet, toolbar = true, fill = false, theme, title = '', description = '' }: Props = $props();

	onMount(() => {
		sheet.connect().catch(() => {
			// El motivo queda en `sheet.error` y se muestra abajo.
		});
	});
</script>

{#if sheet.grid}
	<SpreadsheetGrid config={sheet.grid.config} controller={sheet.grid} {toolbar} {fill} {theme} {title} {description} />
{:else}
	<div class="flex min-h-40 items-center justify-center p-6" class:h-full={fill}>
		{#if sheet.error}
			<div role="alert" class="alert alert-error alert-soft max-w-lg">
				<span>No se pudo abrir la hoja: {sheet.error}</span>
				<button type="button" class="btn btn-sm" onclick={() => sheet.connect().catch(() => {})}>Reintentar</button>
			</div>
		{:else}
			<span class="loading loading-spinner loading-md opacity-60" aria-label="Cargando la hoja"></span>
		{/if}
	</div>
{/if}
