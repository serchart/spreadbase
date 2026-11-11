<!--
@component
Ejemplo del asistente de importación con agente (SB-36). La tabla «Planes
GMF» del servidor (examples/backend/src/examples/import-assistant/) recibe
archivos: se sueltan encima (un CSV o un PDF del boletín, fotos, un zip,
carpetas) y se abre el asistente con ellos subiendo. El agente los analiza,
se conversa con él y se importa en segundo plano; al cerrar, la tabla se
recarga. Es el atajo `importAssistant` de `<SpreadBase>`; el enlace «o elige
archivos» abre el asistente sin arrastrar nada.

El backend usa un modelo de guion (sin red) salvo que se encienda con
`IMPORT_ASSISTANT_LLM=gemini`.
-->
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	import Upload from '@lucide/svelte/icons/upload';
	import { API_URL } from '$lib/config';

	const sheet = new Sheet(`${API_URL}/api/import-assistant/planes`);
	let importOpen = $state(false);
</script>

<svelte:head><title>Asistente de importación · SpreadBase</title></svelte:head>

<section class="flex flex-col gap-4">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold">Asistente de importación</h1>
			<p class="text-base-content/70">
				Suelta el boletín, un CSV de planes, fotos, carpetas o un zip <strong class="text-base-content">sobre la tabla</strong>: el agente decide a dónde va
				cada archivo, revisa las filas con el formato y las importa aquí.
			</p>
		</div>
		<p class="text-base-content/70 flex items-center gap-1.5 text-sm">
			<Upload size={15} aria-hidden="true" />Arrastra archivos a la tabla
			<button type="button" class="link link-primary" onclick={() => (importOpen = true)}>o elige archivos</button>
		</p>
	</header>
	<div class="h-[65vh]" id="tabla-planes">
		<SpreadBase {sheet} fill importAssistant={{ url: `${API_URL}/api/import-assistant`, origen: 'Planes GMF', aviso: 'te avisamos en el panel al terminar' }} bind:importOpen />
	</div>
</section>
