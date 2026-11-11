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

Con `importAssistant`, la hoja recibe archivos: al soltarlos encima se abre el
asistente de importación (SB-36) y, al cerrarlo, la hoja se recarga. La barra
suma el botón «Importar archivos» (`button: false` lo quita); al abrir, el
asistente retoma la corrida que la persona dejó a medias en ese `origen`.

```svelte
<SpreadBase {sheet} fill importAssistant={{ url: '/api/import-assistant', origen: 'Planes GMF' }} bind:importOpen />
```
-->
<script lang="ts" module>
	import type { ImportAssistantState } from './ImportAssistantState.svelte';

	/** El atajo del asistente de importación sobre la hoja (SB-36): las props de `<ImportAssistant>` salvo `target` y `open`. */
	export interface SpreadBaseImportAssistant {
		url: string;
		headers?: () => Record<string, string>;
		origen?: string;
		aviso?: string;
		dropHint?: string;
		run?: string;
		/** El botón «Importar archivos» en la barra de la hoja. Default: `true`. */
		button?: boolean;
		/** Se cerró; la hoja ya se recargó. */
		onclose?: () => void;
		/** Recibe el estado del asistente (para leerlo desde fuera). */
		onassistant?: (state: ImportAssistantState) => void;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import Upload from '@lucide/svelte/icons/upload';
	import SpreadsheetGrid from './SpreadsheetGrid.svelte';
	import ImportAssistant from './ImportAssistant.svelte';
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
		/** La hoja recibe archivos: soltarlos encima abre el asistente de importación (SB-36). */
		importAssistant?: SpreadBaseImportAssistant;
		/** Abre el asistente del atajo (para un enlace propio, «o elige archivos»). */
		importOpen?: boolean;
		/** La leyenda inferior de colores y filas. Default: `true`; `false` la quita (hojas dentro de otra interfaz). */
		legend?: boolean;
	}

	let { sheet, toolbar = true, fill = false, theme, title = '', description = '', importAssistant, importOpen = $bindable(false), legend = true }: Props = $props();
	let host = $state<HTMLElement>();
	let assistantState = $state<ImportAssistantState>();
	$effect(() => {
		if (assistantState) importAssistant?.onassistant?.(assistantState);
	});

	/** Con el atajo, la barra trae «Importar archivos» (después de Guardar y de los botones propios). */
	const toolbarWithImport = $derived.by((): boolean | GridToolbarConfig => {
		if (!importAssistant || importAssistant.button === false || toolbar === false) return toolbar;
		const cfg: GridToolbarConfig = toolbar === true ? {} : toolbar;
		return { ...cfg, actions: [...(cfg.actions ?? []), { label: 'Importar archivos', icon: Upload, onclick: () => (importOpen = true) }] };
	});

	function closed() {
		void sheet.grid?.commands.reload();
		importAssistant?.onclose?.();
	}

	onMount(() => {
		sheet.connect().catch(() => {
			// El motivo queda en `sheet.error` y se muestra abajo.
		});
	});
</script>

{#snippet body()}
{#if sheet.grid}
	<SpreadsheetGrid config={sheet.grid.config} controller={sheet.grid} toolbar={toolbarWithImport} {fill} {theme} {title} {description} {legend} />
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
{/snippet}

{#if importAssistant}
	<div bind:this={host} class="relative flex min-h-0 flex-col" class:h-full={fill}>
		{@render body()}
	</div>
	<ImportAssistant
		url={importAssistant.url}
		headers={importAssistant.headers}
		origen={importAssistant.origen}
		aviso={importAssistant.aviso}
		dropHint={importAssistant.dropHint}
		run={importAssistant.run}
		target={host}
		bind:open={importOpen}
		bind:assistant={assistantState}
		onclose={closed}
	/>
{:else}
	{@render body()}
{/if}
