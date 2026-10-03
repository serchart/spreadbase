<!--
@component
Ejemplo de importación (SB-34): el formato «Contactos» del servidor
(examples/backend/src/examples/imports/) en `<SheetImport>`. Suelta un Excel o
CSV sobre la vista previa, pega desde tu hoja de cálculo o escribe; «Revisar»
marca en la hoja lo que el servidor encuentra y «Aplicar» escribe en la hoja
del ejemplo básico.
-->
<script lang="ts">
	import { SheetImport } from '@spreadbase/client';
	import type { ImportResult } from '@spreadbase/core';
	import { API_URL } from '$lib/config';

	let applied = $state<ImportResult | null>(null);
	let round = $state(0);
</script>

<svelte:head><title>Importar · SpreadBase</title></svelte:head>

<section class="flex flex-col gap-4">
	<header>
		<h1 class="text-2xl font-semibold">Importar</h1>
		<p class="text-base-content/70">
			Contactos a la hoja del <a class="link" href="/basic">ejemplo básico</a>: se crean o se actualizan por su correo. Si el archivo no trae
			«Estado», se elige una vez a la izquierda.
		</p>
	</header>
	{#if applied}
		<div role="status" class="alert alert-success alert-soft">
			<span>Importado: {applied.summary.creados} creados y {applied.summary.actualizados} actualizados.</span>
			<a class="btn btn-sm" href="/basic">Ver la hoja</a>
			<button type="button" class="btn btn-sm" onclick={() => ((applied = null), round++)}>Importar otro</button>
		</div>
	{/if}
	<div class="h-[70vh]">
		{#key round}
			<SheetImport url={`${API_URL}/api/imports`} onapplied={(r) => (applied = r)} />
		{/key}
	</div>
</section>
