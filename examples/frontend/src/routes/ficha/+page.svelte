<!--
@component
Ejemplo de ficha (SB-32): un contacto de la hoja del ejemplo básico como
formulario guardable. Los campos son las columnas editables de la hoja, con sus
editores y reglas; «Guardar» manda solo lo cambiado, con la versión que se leyó
(la misma concurrencia que la hoja). `?id=c_00001` elige el contacto.
Backend: examples/backend/src/examples/basic/
-->
<script lang="ts">
	import { Field, RecordForm, Sheet } from '@spreadbase/client';
	import { page } from '$app/state';
	import { API_URL } from '$lib/config';

	const id = page.url.searchParams.get('id') ?? 'c_00001';
	const record = new RecordForm(new Sheet(`${API_URL}/api/basic/contacts`), id);
</script>

<div class="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
	<header>
		<h1 class="text-lg font-semibold tracking-tight">Ficha · contacto <span class="font-mono">{id}</span></h1>
		<p class="text-base-content/70 text-xs">
			Las columnas editables de la hoja de contactos, como formulario. Guardar es un lote de la hoja: solo lo cambiado, con su
			versión.
		</p>
	</header>

	{#if record.loadError}
		<div role="alert" class="alert alert-error alert-soft"><span>{record.loadError}</span></div>
	{:else if !record.form}
		<span class="loading loading-spinner loading-md" aria-label="Cargando"></span>
	{:else}
		<section class="card card-border border-base-300 bg-base-100">
			<div class="card-body">
				<div class="grid gap-x-6 sm:grid-cols-2">
					{#each record.fields as name (name)}
						<Field form={record.form} {name} />
					{/each}
				</div>
				{#if record.conflict}
					<div role="alert" class="alert alert-warning alert-soft mt-2">
						<span>Otra persona cambió {record.conflict.join(', ')} mientras editabas.</span>
						<button type="button" class="btn btn-sm" onclick={() => record.reload()}>Ver lo vigente</button>
						<button type="button" class="btn btn-sm" onclick={() => record.overwrite()}>Guardar lo mío</button>
					</div>
				{/if}
				{#if record.saveError}
					<div role="alert" class="alert alert-error alert-soft mt-2"><span>{record.saveError}</span></div>
				{/if}
				<div class="card-actions mt-2 items-center justify-end">
					{#if record.savedCount > 0 && !record.dirty}<span role="status" class="badge badge-success badge-soft">Guardado</span>{/if}
					<button type="button" class="btn btn-ghost" disabled={!record.dirty || record.saving} onclick={() => record.reset()}>Descartar</button>
					<button type="button" class="btn btn-primary" disabled={!record.dirty || record.saving} onclick={() => record.save()}>
						{#if record.saving}<span class="loading loading-spinner loading-sm"></span>{/if}
						Guardar
					</button>
				</div>
			</div>
		</section>
	{/if}
</div>
