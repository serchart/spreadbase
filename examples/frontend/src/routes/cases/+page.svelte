<!--
@component
Hoja **contra un servidor**: el uso normal de SpreadBase.

La página no define columnas: `new Sheet(url)` pide el esquema al backend
(`GET /api/cases/schema`) al montarse. El backend es un módulo en capas
(`cases.routes → cases.controller → cases.service`), como en OpenCollect.
-->
<script lang="ts">
	import { Sheet, SpreadBase, type GridToolbarConfig } from '@spreadbase/client';
	import { API_URL } from '$lib/config';

	/**
	 * 50 000 casos que nunca están todos en el navegador: la hoja retiene una
	 * ventana de 180 filas y pide páginas de 60 al acercarse a un borde. El
	 * borrador —cambios e historial de deshacer— vive en IndexedDB y sobrevive a
	 * recargar. Guardar manda un lote con concurrencia por campo.
	 */
	const sheet = new Sheet(`${API_URL}/api/cases`, {
		// Consola: lote enviado, respuesta, avisos, conflictos y reconciliaciones.
		debug: true,
		frozenColumns: 1
	});

	/**
	 * Cómo enterarse de los cambios en tiempo real. **Ejemplo, no funcionalidad.**
	 *
	 * `sheet.grid` es el controlador: expone estado reactivo, así que leerlo en
	 * un `$effect` basta para que Svelte lo reejecute en cada cambio. Depender de
	 * `version` —el pulso del controlador— asegura enterarse también de cambios
	 * que no mueven ningún contador.
	 */
	$effect(() => {
		const grid = sheet.grid;
		if (!grid) return;
		grid.version;
		console.log('[spreadbase] estado de la hoja', {
			filas: grid.rowCount,
			pendientes: grid.rowSummary,
			hayPendientes: grid.hasPendingChanges
		});
	});

	/** Presets para probar el prop `toolbar` en vivo: alternarlos no reconstruye la hoja. */
	const TOOLBAR_PRESETS: { id: string; label: string; value: boolean | GridToolbarConfig }[] = [
		{ id: 'full', label: 'Completa (default)', value: true },
		{ id: 'minimal', label: 'Mínima', value: { groups: [['undo', 'redo'], ['save']] } },
		{ id: 'readonly', label: 'Solo consulta', value: { groups: [['copy', 'copyRows'], ['reload']] } },
		{ id: 'nostatus', label: 'Sin contadores', value: { status: false } },
		{ id: 'off', label: 'Oculta', value: false }
	];

	let preset = $state(TOOLBAR_PRESETS[0]);
</script>

<div data-fill class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 flex-wrap items-end justify-between gap-x-4 gap-y-2 px-6 pt-4 pb-1">
		<header>
			<h1 class="text-lg font-semibold tracking-tight">
				Casos · <code>/api/cases</code>
			</h1>
			<p class="text-base-content/70 text-xs">
				50 000 casos en el backend; la hoja retiene una ventana de 180 y pide páginas al
				desplazarse. Editable, con altas y bajas; el borrador sobrevive a recargar y guardar
				detecta conflictos por campo. Backend: <code>examples/backend/src/examples/cases/</code>.
			</p>
		</header>

		<div class="flex flex-wrap items-center gap-1.5">
			<span class="eyebrow">Toolbar:</span>
			{#each TOOLBAR_PRESETS as option (option.id)}
				<button
					type="button"
					class="btn btn-xs"
					class:btn-active={preset.id === option.id}
					onclick={() => (preset = option)}
				>
					{option.label}
				</button>
			{/each}
		</div>
	</div>

	<div class="bg-base-100 border-base-300 rounded-box mx-6 mt-2 mb-4 min-h-0 flex-1 border p-3">
		<SpreadBase {sheet} toolbar={preset.value} fill />
	</div>

	<details class="collapse-arrow collapse bg-base-100 border-base-300 mx-6 mb-4 shrink-0 border text-xs">
		<summary class="collapse-title py-2 text-xs font-semibold min-h-0!">Qué probar</summary>
		<div class="collapse-content text-base-content/70">
			<ul class="list-inside list-disc space-y-1 pt-1">
				<li>Desplázate lejos: la numeración de filas es global y el pie dice qué tramo está en memoria.</li>
				<li>Edita una fila, bájate hasta que salga de la ventana y recarga: el cambio sigue ahí.</li>
				<li>
					Para simular a otro usuario:
					<code>curl -X POST {API_URL}/api/cases/dev/mutate -H 'content-type: application/json' -d '{`{"ids":["case_000001"],"fields":["customer_name"]}`}'</code>
					y guarda un cambio tuyo en esa fila.
				</li>
				<li>Agrega una fila (va arriba, en verde) o elimina una (queda tachada hasta guardar).</li>
			</ul>
		</div>
	</details>
</div>

<style>
	code {
		font-family: var(--font-mono, ui-monospace, 'SF Mono', Menlo, monospace);
		font-size: 0.92em;
		background: var(--color-base-200);
		padding: 0.1em 0.35em;
		border-radius: 4px;
	}
</style>
