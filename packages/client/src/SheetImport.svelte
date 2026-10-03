<!--
@component
SheetImport — importar a través de un formato del servidor (SB-34).

A la izquierda, el formato y **solo lo que el archivo no trae** (los datos
`form`, y los `either` que no vienen en una columna); lo que se leyó del
archivo y lo que dijo el servidor. A la derecha, la **vista previa**: una hoja
local con las columnas del formato, donde se suelta un Excel o CSV, se pega
desde una hoja de cálculo o se escribe a mano, y se corrige.

«Revisar» manda las filas al servidor, que las valida con las reglas de sus
columnas y dice qué haría: sus avisos se marcan en la celda. «Aplicar» lo hace.
Editar después de revisar pide revisar otra vez.

```svelte
<SheetImport url="/api/imports/formats" onapplied={(r) => …} oncancel={cerrar}>
	{#snippet summary(result)} …cuántos se crean y se actualizan… {/snippet}
</SheetImport>
```
-->
<script lang="ts">
	import { onMount, untrack, type Snippet } from 'svelte';
	import type { ImportResult } from '@spreadbase/core';
	import FileUp from '@lucide/svelte/icons/file-up';
	import FileSpreadsheet from '@lucide/svelte/icons/file-spreadsheet';
	import Eraser from '@lucide/svelte/icons/eraser';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import SpreadBase from './SpreadBase.svelte';
	import Field from './Field.svelte';
	import { ImportState } from './ImportState.svelte';

	interface Props {
		/** La base de `importRoutes` en el servidor. */
		url: string;
		/** Cabeceras de cada petición (p. ej. `Authorization`). */
		headers?: () => Record<string, string>;
		/** El formato con que abre. Default: el primero. */
		format?: string;
		/** Se aplicó: el resultado del servidor. */
		onapplied?: (result: ImportResult) => void;
		oncancel?: () => void;
		/** Cómo contar el resultado (cuántos se crean, se actualizan…). Default: los números del resumen. */
		summary?: Snippet<[ImportResult, ImportState]>;
		/** El estado, para quien lo quiera leer desde fuera (`bind:importer`). */
		importer?: ImportState;
	}

	let { url, headers, format, onapplied, oncancel, summary, importer: exposed = $bindable() }: Props = $props();

	// Se crea una vez, con la URL y el formato de entrada: cambiarlos es montar otro importador.
	const importer = untrack(() => new ImportState(url, { headers, format }));
	exposed = importer;
	onMount(() => void importer.init());

	/** La hoja cambió después de revisar: hay que revisar otra vez antes de aplicar. */
	let reviewedAt = $state<number | null>(null);
	const version = $derived(importer.sheet?.grid?.version ?? 0);
	const stale = $derived(reviewedAt !== null && version !== reviewedAt);
	const result = $derived(importer.result);
	const applied = $derived(!!result?.applied);
	const canApply = $derived(!!result && result.ok && !stale && !applied);
	const forceable = $derived(!!result && !stale && !applied && !!result.blocked?.forceable && !result.issues.some((i) => i.level === 'error'));
	const rowErrors = $derived((result?.issues ?? []).filter((i) => i.row !== null && i.level === 'error').length);
	const warnings = $derived((result?.issues ?? []).filter((i) => i.level === 'warning'));
	let confirmForce = $state(false);

	async function review() {
		confirmForce = false;
		const r = await importer.review();
		if (r) reviewedAt = importer.sheet?.grid?.version ?? 0;
	}

	async function apply(force = false) {
		const r = await importer.apply(force);
		confirmForce = false;
		if (r?.applied) onapplied?.(r);
	}

	// -- archivo: elegir, soltar ---------------------------------------------------------------------
	let input = $state<HTMLInputElement>();
	let dragging = $state(0);

	async function take(file: File | undefined | null) {
		if (!file) return;
		reviewedAt = null;
		await importer.loadFile(file);
	}

	function ondrop(event: DragEvent) {
		event.preventDefault();
		dragging = 0;
		void take(event.dataTransfer?.files?.[0]);
	}

	const numbers = $derived(
		Object.entries(result?.summary ?? {}).filter((e): e is [string, number] => typeof e[1] === 'number' && e[0] !== 'rows')
	);
</script>

<div class="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
	<!-- Izquierda: el formato, lo que no viene en el archivo y lo que dijo el servidor. -->
	<aside class="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1" aria-label="Datos de la importación">
		{#if importer.formats.length > 1}
			<label class="fieldset">
				<span class="fieldset-legend">Formato</span>
				<select
					class="select w-full"
					value={importer.schema?.id ?? ''}
					onchange={(e) => {
						reviewedAt = null;
						void importer.select((e.currentTarget as HTMLSelectElement).value);
					}}
				>
					{#each importer.formats as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
				</select>
			</label>
		{:else if importer.schema}
			<h3 class="font-semibold">{importer.schema.label}</h3>
		{/if}
		{#if importer.schema?.description}
			<p class="text-base-content/70 text-sm">{importer.schema.description}</p>
		{/if}

		{#if importer.form && importer.formFields.length}
			{#key importer.form}
				<div class="flex flex-col">
					{#each importer.formFields as name (name)}
						<Field form={importer.form} {name} />
					{/each}
				</div>
			{/key}
		{/if}

		{#if importer.file}
			<section class="rounded-box border-base-300 flex flex-col gap-1 border p-3 text-sm" aria-label="Archivo leído">
				<div class="flex items-center gap-2 font-medium"><FileSpreadsheet size={16} aria-hidden="true" />{importer.file.name}</div>
				<p class="text-base-content/70">{importer.file.rows.toLocaleString('es-MX')} filas · encabezado en la fila {importer.file.headerRow}</p>
				{#if importer.checksum}
					<p class="text-base-content/70">Trae la suma de control del pie: se comprueba al revisar.</p>
				{/if}
				{#if importer.file.missing.length}
					<p class="text-error">No trae: {importer.file.missing.join(', ')}</p>
				{/if}
				{#if importer.file.ignored.length}
					<p class="text-base-content/60 text-xs">Se ignoran: {importer.file.ignored.join(', ')}</p>
				{/if}
			</section>
		{/if}

		{#if result}
			<section class="flex flex-col gap-2 text-sm" aria-label="Resultado">
				{#if applied}
					<div role="status" class="alert alert-success alert-soft"><CircleCheck size={16} aria-hidden="true" /><span>Aplicado.</span></div>
				{:else if stale}
					<div role="status" class="alert alert-soft"><span>Cambiaste la hoja: revisa otra vez antes de aplicar.</span></div>
				{:else if result.ok}
					<div role="status" class="alert alert-success alert-soft"><CircleCheck size={16} aria-hidden="true" /><span>Listo para aplicar.</span></div>
				{:else if rowErrors}
					<div role="alert" class="alert alert-error alert-soft">
						<TriangleAlert size={16} aria-hidden="true" /><span>{rowErrors} {rowErrors === 1 ? 'celda marcada' : 'celdas marcadas'} en la hoja: corrígelas y revisa otra vez.</span>
					</div>
				{/if}
				{#each importer.generalIssues.filter((i) => i.level === 'error') as issue, n (n)}
					<div role="alert" class="alert alert-error alert-soft"><span>{issue.message}</span></div>
				{/each}
				{#if result.blocked}
					<div role="alert" class="alert alert-warning alert-soft">
						<TriangleAlert size={16} aria-hidden="true" />
						<div>
							<p class="font-medium">Se detiene{result.blocked.forceable ? '' : ' y no se puede forzar'}:</p>
							<ul class="list-disc pl-5">{#each result.blocked.reasons as reason (reason)}<li>{reason}</li>{/each}</ul>
						</div>
					</div>
				{/if}
				{#if summary}
					{@render summary(result, importer)}
				{:else if numbers.length}
					<dl class="grid grid-cols-[1fr_auto] gap-x-4">
						{#each numbers as [key, n] (key)}<dt class="text-base-content/70">{key}</dt><dd class="tabular-nums text-right">{n}</dd>{/each}
					</dl>
				{/if}
				{#if warnings.length}
					<details>
						<summary class="cursor-pointer">{warnings.length} {warnings.length === 1 ? 'aviso' : 'avisos'}</summary>
						<ul class="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-xs">
							{#each warnings.slice(0, 200) as w, n (n)}<li>{w.row !== null ? `Fila ${w.row + 1}: ` : ''}{w.message}</li>{/each}
						</ul>
					</details>
				{/if}
			</section>
		{/if}

		{#if importer.error}
			<div role="alert" class="alert alert-error alert-soft"><span>{importer.error}</span></div>
		{/if}

		<div class="mt-auto flex flex-wrap justify-end gap-2 pt-2">
			{#if oncancel}
				<button type="button" class="btn btn-ghost" onclick={oncancel}>{applied ? 'Cerrar' : 'Cancelar'}</button>
			{/if}
			{#if !applied}
				{#if forceable}
					{#if confirmForce}
						<button type="button" class="btn btn-warning" disabled={!!importer.busy} onclick={() => apply(true)}>Sí, aplicar de todos modos</button>
					{:else}
						<button type="button" class="btn btn-outline" onclick={() => (confirmForce = true)}>Aplicar pese a esto</button>
					{/if}
				{/if}
				{#if canApply}
					<button type="button" class="btn btn-primary" disabled={!!importer.busy} onclick={() => apply()}>
						{#if importer.busy === 'apply'}<span class="loading loading-spinner loading-sm"></span>{/if}
						Aplicar
					</button>
				{:else}
					<button type="button" class="btn btn-primary" disabled={!!importer.busy || !importer.schema} onclick={review}>
						{#if importer.busy === 'review'}<span class="loading loading-spinner loading-sm"></span>{/if}
						Revisar
					</button>
				{/if}
			{/if}
		</div>
	</aside>

	<!-- Derecha: la vista previa. Se suelta un archivo encima, se pega o se escribe. -->
	<section
		class="rounded-box border-base-300 bg-base-100 relative flex min-h-[24rem] min-w-0 flex-col gap-2 border p-3"
		aria-label="Vista previa"
		ondragenter={(e) => {
			e.preventDefault();
			dragging++;
		}}
		ondragover={(e) => e.preventDefault()}
		ondragleave={() => (dragging = Math.max(0, dragging - 1))}
		{ondrop}
	>
		<div class="flex flex-wrap items-center justify-between gap-2">
			<p class="text-base-content/70 text-sm">Suelta aquí un Excel o CSV, pega desde tu hoja de cálculo o escribe.</p>
			<div class="flex gap-2">
				{#if importer.file}
					<button type="button" class="btn btn-ghost btn-sm" onclick={() => ((reviewedAt = null), importer.clear())}>
						<Eraser size={16} aria-hidden="true" />Vaciar
					</button>
				{/if}
				<button type="button" class="btn btn-sm" disabled={!importer.schema} onclick={() => input?.click()}>
					<FileUp size={16} aria-hidden="true" />Elegir archivo
				</button>
				<input
					bind:this={input}
					class="hidden"
					type="file"
					accept=".xlsx,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
					aria-label="Archivo a importar"
					onchange={(e) => {
						const el = e.currentTarget as HTMLInputElement;
						void take(el.files?.[0]);
						el.value = '';
					}}
				/>
			</div>
		</div>
		<div class="flex min-h-0 flex-1 flex-col">
			{#if importer.sheet}
				{#key importer.sheet}
					<SpreadBase
						sheet={importer.sheet}
						fill
						toolbar={{ groups: [['undo', 'redo'], ['copy', 'paste'], ['addRow', 'deleteRow']], changes: false }}
					/>
				{/key}
			{/if}
		</div>
		{#if dragging || importer.busy === 'reading'}
			<div class="rounded-box bg-base-100/90 border-primary absolute inset-0 z-10 grid place-items-center border-2 border-dashed">
				<p class="flex items-center gap-2 font-medium">
					{#if importer.busy === 'reading'}<span class="loading loading-spinner loading-sm"></span>Leyendo el archivo…{:else}<FileUp size={18} aria-hidden="true" />Suelta el archivo para leerlo{/if}
				</p>
			</div>
		{/if}
	</section>
</div>
