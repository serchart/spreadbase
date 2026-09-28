<!--
@component
Hoja **sin servidor**: la definición se escribe en el front y los datos vienen
de una fuente local (un ledger de cargos en memoria del navegador).

Es el uso de `new Sheet({ id, columns, dataSource })`. Contraparte real prevista:
  GET  /api/v1/charges            → dataSource.load
  POST /api/v1/charges/batch      → dataSource.save (recibe el ChangeSet)
  GET  /api/v1/customers/search   → columna `customer_id` (remote-select)
-->
<script lang="ts">
	import { Sheet, SpreadBase, type GridConfig, type GridToolbarConfig } from '@spreadbase/client';
	import {
		CHARGE_KINDS,
		CHARGE_STATUSES,
		CUSTOMER_LABELS,
		loadCharges,
		resetChargesStore,
		saveCharges,
		searchCustomers,
		seedSyntheticCharges
	} from '$lib/mocks/charges';

	const config: GridConfig = {
		id: 'examples.contract_charges',
		idField: 'id',
		persist: 'session',
		height: '470px',
		allowInsert: true,
		allowDelete: true,
		dataSource: {
			load: loadCharges,
			save: saveCharges
		},
		columns: [
			{
				field: 'id',
				label: 'ID',
				type: 'text',
				width: 92,
				readOnly: true
			},
			{
				field: 'customer_id',
				label: 'Cliente',
				type: 'remote-select',
				width: 210,
				required: true,
				search: searchCustomers,
				preloadLabels: CUSTOMER_LABELS
			},
			{
				field: 'kind',
				label: 'Naturaleza',
				type: 'select',
				width: 165,
				required: true,
				options: CHARGE_KINDS,
				defaultValue: 'pactado'
			},
			{
				field: 'status',
				label: 'Estatus',
				type: 'select',
				width: 150,
				required: true,
				options: CHARGE_STATUSES,
				defaultValue: 'chg_programado'
			},
			{ field: 'serie', label: 'Serie', type: 'text', width: 64, maxLength: 4 },
			{
				field: 'folio',
				label: 'Folio',
				type: 'text',
				width: 88,
				pattern: /^\d+$/,
				patternMessage: 'El folio debe ser numérico'
			},
			{
				field: 'uuid_fiscal',
				label: 'UUID fiscal',
				type: 'text',
				width: 190,
				pattern: /^[0-9a-fA-F-]{36}$/,
				patternMessage: 'Debe ser un UUID de 36 caracteres'
			},
			{
				field: 'due_date',
				label: 'Vencimiento',
				type: 'date',
				width: 118,
				required: true
			},
			{
				field: 'amount',
				label: 'Importe',
				type: 'number',
				width: 120,
				required: true,
				min: 0,
				precision: 2,
				prefix: '$'
			},
			{
				field: 'paid_amount',
				label: 'Pagado',
				type: 'number',
				width: 118,
				min: 0,
				precision: 2,
				prefix: '$',
				defaultValue: 0,
				// Regla de negocio cruzada: lo pagado no puede exceder el importe.
				validate: (value, row) => {
					const paid = Number(value ?? 0);
					const amount = Number(row.amount ?? 0);
					return paid > amount ? 'No puede exceder el importe del cargo' : null;
				}
			},
			{
				field: 'installment_number',
				label: 'Parcialidad',
				type: 'number',
				width: 96,
				min: 1,
				max: 120
			},
			{ field: 'last_seen_corte', label: 'Últ. corte', type: 'date', width: 112 },
			{ field: 'synced_at', label: 'Sincronizado', type: 'datetime', width: 145 },
			{ field: 'evidence_url', label: 'Evidencia', type: 'image', width: 90 },
			{ field: 'portal_password', label: 'Clave portal', type: 'password', width: 110, min: 8 },
			{ field: 'notes', label: 'Notas', type: 'text', width: 240, maxLength: 240 }
		]
	};

	/**
	 * Presets para probar el prop `toolbar` en vivo.
	 *
	 * Cambiar el preset no reconstruye la grilla: `toolbar` solo alimenta un
	 * `$derived`, así que los cambios pendientes y el historial sobreviven al
	 * alternar. Eso es justo lo que se quiere comprobar aquí.
	 */
	const TOOLBAR_PRESETS: { id: string; label: string; value: boolean | GridToolbarConfig }[] = [
		{ id: 'full', label: 'Completa (default)', value: true },
		{
			id: 'minimal',
			label: 'Mínima',
			value: { groups: [['undo', 'redo'], ['save']] }
		},
		{
			id: 'readonly',
			label: 'Solo consulta',
			value: { groups: [['copy', 'copyRows'], ['reload']] }
		},
		{
			id: 'nostatus',
			label: 'Sin contadores',
			value: { status: false }
		},
		{ id: 'off', label: 'Oculta', value: false }
	];

	let preset = $state(TOOLBAR_PRESETS[0]);

	/**
	 * Sin servidor, el controlador existe desde el principio: `sheet.grid`.
	 * Crearlo aquí y no dentro del componente es lo que permite escucharlo.
	 */
	const sheet = new Sheet(config);
	const grid = sheet.grid!;

	/**
	 * Cómo enterarse de los cambios en tiempo real. **Ejemplo, no funcionalidad.**
	 *
	 * El controlador no emite eventos, y no le hacen falta: expone estado
	 * reactivo. Leerlo dentro de un `$effect` basta para que Svelte lo reejecute
	 * en cada cambio. Es la misma vía por la que la toolbar pinta sus chips, así
	 * que esto imprime exactamente lo que ellas muestran.
	 *
	 * La dependencia se declara sobre `grid.version`, el pulso del controlador:
	 * cada mutación lo incrementa y **todos** los contadores lo leen antes de
	 * calcular. Depender de él y no de `dirtyCount` asegura enterarse también de
	 * los cambios que no mueven ningún contador, como editar otra celda de una
	 * fila que ya estaba sucia.
	 */
	$effect(() => {
		grid.version;

		console.log('[datagrid] estado de la hoja', {
			// Los números de las chips de la toolbar.
			contadores: {
				filas: grid.rowCount,
				editadas: grid.dirtyCount,
				nuevas: grid.createdCount,
				eliminadas: grid.deletedCount,
				errores: grid.errorCount,
				hayPendientes: grid.hasPendingChanges
			},
			// El detalle que despliega la chip de errores: fila, columna y motivo.
			errores: grid.errorList,
			/**
			 * Lo que se enviaría al guardar: separado en creates/updates/deletes, sin
			 * `__key`, y con solo los campos tocados en cada update.
			 *
			 * Recorre todas las filas, así que sirve para depurar. Un listener de
			 * producción debería quedarse en los contadores.
			 */
			changeset: grid.buildChangeSet()
		});
	});

	// -- banco de rendimiento -------------------------------------------------

	/**
	 * Mide el coste de las operaciones del presupuesto del
	 * `07-anexo-datagrid-engine.md` §9 sobre un dataset del tamaño del escenario
	 * crítico.
	 *
	 * Vive en los ejemplos y no en la librería porque su propósito es detectar
	 * regresiones de rendimiento, no servir a un usuario final. Sin esto, las
	 * cifras del spec no son comprobables por nadie.
	 */
	let benchRows = $state(10000);
	let benchDirty = $state(5000);
	let benchBusy = $state(false);
	let benchOut = $state<string[]>([]);

	const ms = (n: number) => `${n.toFixed(1)} ms`;

	/** Cronometra `fn` aisladamente. Devuelve el tiempo y deja pasar el resultado. */
	function timed<T>(label: string, fn: () => T): T {
		const t0 = performance.now();
		const out = fn();
		benchOut = [...benchOut, `${label}: ${ms(performance.now() - t0)}`];
		return out;
	}

	async function runBench() {
		benchBusy = true;
		benchOut = [`— ${benchRows} filas × ${config.columns.length} columnas —`];
		try {
			seedSyntheticCharges(benchRows);
			grid.clearStorage();
			// Se recarga por el comando de la hoja, no por `grid.load()`: el comando es
			// el que además vuelca la matriz a jspreadsheet y repinta. La latencia
			// simulada del mock queda dentro, así que esta parte no se cronometra.
			await grid.commands.reload();

			// Se ensucian celdas repartidas por toda la hoja. Concentrarlas en las
			// primeras filas haría que los recorridos lineales salieran pronto del
			// bucle y el resultado sería engañosamente bueno.
			const editable = config.columns.filter((c) => !c.readOnly);
			const target = Math.min(benchDirty, grid.rowCount * editable.length);
			timed(`ensuciar ${target} celdas`, () => {
				grid.transaction(() => {
					for (let i = 0; i < target; i++) {
						const y = (i * 7919) % grid.rowCount; // primo: reparte sin repetir pronto
						const column = editable[i % editable.length];
						grid.setCellValue(y, column.field, `bench-${i}`);
					}
				});
			});

			benchOut = [
				...benchOut,
				`celdas sucias: ${grid.dirtyCount} · errores: ${grid.errorCount}`
			];

			const issues = timed('errorList', () => grid.errorList);
			const cs = timed('buildChangeSet', () => grid.buildChangeSet());
			// La primera lectura agrupa; la segunda debe salir de la memoria por versión.
			const summary = timed('rowSummary (fría)', () => grid.rowSummary);
			timed('rowSummary (memoizada)', () => grid.rowSummary);
			const log = timed('changeLog', () => grid.changeLog);
			benchOut = [
				...benchOut,
				`filas: ${summary.total} total · ${summary.created} nuevas · ${summary.updated} editadas · ${summary.deleted} eliminadas · ${summary.withErrors} con error · log: ${log.length}`
			];
			/*
				La ruta real de una celda confirmada: fuera de transacción, así que
				incluye su entrada de historial. Es la cifra que debe caber en un
				fotograma (< 16 ms, §9). Se repite para promediar y porque la primera
				ejecución paga la compilación JIT.

				Deshacer y rehacer se miden sobre esas mismas 5 ediciones y después
				sobre la transacción grande. Solo el controlador: la hoja no se
				resincroniza aquí.
			*/
			const probe = editable[0];
			const avg5 = (label: string, fn: (i: number) => void) => {
				const t0 = performance.now();
				for (let i = 0; i < 5; i++) fn(i);
				benchOut = [...benchOut, `${label} (media de 5): ${ms((performance.now() - t0) / 5)}`];
			};
			avg5('1 edición suelta', (i) => grid.setCellValue(i, probe.field, `probe-${i}`));
			avg5('deshacer 1 edición', () => grid.undo());
			avg5('rehacer 1 edición', () => grid.redo());
			// Deja la pila con la transacción grande en la cima.
			for (let i = 0; i < 5; i++) grid.undo();
			timed(`deshacer transacción de ${target} celdas`, () => grid.undo());
			timed(`rehacer transacción de ${target} celdas`, () => grid.redo());

			timed('indexOfRow × 10 000', () => {
				const keys = grid.rows;
				for (let i = 0; i < 10000; i++) grid.indexOfRow(keys[i % keys.length].__key);
			});

			benchOut = [
				...benchOut,
				`errorList devolvió ${issues.length} · changeset: ${cs.updates.length} updates`
			];
		} finally {
			benchBusy = false;
		}
	}

	async function resetBench() {
		benchBusy = true;
		try {
			resetChargesStore();
			grid.clearStorage();
			await grid.commands.reload();
			benchOut = [];
		} finally {
			benchBusy = false;
		}
	}
</script>

<!--
	`data-fill` apaga el scroll de `main`; la página
	reparte el alto entre su cabecera, los controles de prueba y la hoja, que
	ocupa lo que queda y scrollea por dentro —incluido su panel lateral—.
-->
<div data-fill class="flex min-h-0 flex-1 flex-col">
	<!-- ====================== Cabecera y controles de prueba ====================== -->
	<div class="flex shrink-0 flex-wrap items-end justify-between gap-x-4 gap-y-2 px-6 pt-4 pb-1">
		<header>
			<h1 class="text-lg font-semibold tracking-tight">
				Sin servidor · <code>contract_charges</code>
			</h1>
			<p class="text-base-content/70 text-xs">
				Definición escrita en el front y datos en memoria del navegador: nada toca la fuente
				hasta pulsar <strong>Guardar</strong>.
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

	<!--
		Banco de rendimiento. Mide el escenario crítico del
		`07-anexo-datagrid-engine.md` §9 para que sus cifras sean reproducibles.
		Advertencia deliberada: con 10 000 filas la hoja aún no está virtualizada,
		así que el montaje inicial es lento. Eso es el hallazgo, no un fallo del banco.
	-->
	<details class="collapse-arrow collapse bg-base-100 border-base-300 mx-6 mt-2 shrink-0 border border-dashed text-xs">
		<summary class="collapse-title py-2 text-xs font-semibold min-h-0!">
			Banco de rendimiento
		</summary>
		<div class="collapse-content">
			<div class="flex flex-wrap items-end gap-3 pt-2">
				<fieldset class="fieldset p-0">
					<legend class="fieldset-legend">Filas</legend>
					<input
						type="number"
						class="input input-sm w-24"
						min="100"
						max="50000"
						step="100"
						bind:value={benchRows}
					/>
				</fieldset>
				<fieldset class="fieldset p-0">
					<legend class="fieldset-legend">Celdas a ensuciar</legend>
					<input
						type="number"
						class="input input-sm w-24"
						min="10"
						max="50000"
						step="100"
						bind:value={benchDirty}
					/>
				</fieldset>
				<button type="button" class="btn btn-sm" disabled={benchBusy} onclick={runBench}>
					{benchBusy ? 'Midiendo…' : 'Medir'}
				</button>
				<button type="button" class="btn btn-sm btn-ghost" disabled={benchBusy} onclick={resetBench}>
					Restaurar semilla
				</button>
			</div>

			{#if benchOut.length > 0}
				<pre class="bg-neutral text-neutral-content rounded-field mt-3 max-h-44 overflow-auto p-3 text-[11px] leading-relaxed tabular-nums">{benchOut.join('\n')}</pre>
			{/if}
		</div>
	</details>

	<!-- ====================== Hoja ====================== -->
	<!-- El alto sobrante es de la hoja; el panel de cambios scrollea dentro de ella. -->
	<div class="bg-base-100 border-base-300 rounded-box mx-6 mt-2 mb-4 min-h-0 flex-1 border p-3">
		<SpreadBase {sheet} toolbar={preset.value} fill />
	</div>

	<details class="collapse-arrow collapse bg-base-100 border-base-300 mx-6 mb-4 shrink-0 border text-xs">
		<summary class="collapse-title py-2 text-xs font-semibold min-h-0!">Qué probar</summary>
		<div class="collapse-content text-base-content/70">
			<ul class="list-inside list-disc space-y-1 pt-1">
				<li>
					<strong>Cliente</strong> es un selector de fuente externa: al abrirlo carga un
					buscador que filtra conforme escribes y solo admite valores de la fuente.
				</li>
				<li>
					<strong>Importe / Pagado</strong> validan número y rango. Si pones un pagado mayor al
					importe, la celda se marca en rojo y el guardado se bloquea.
				</li>
				<li>
					<strong>Folio</strong> y <strong>UUID fiscal</strong> validan por expresión regular.
				</li>
				<li>
					<strong>Evidencia</strong> abre un editor con vista previa; <strong>Clave portal</strong>
					enmascara el contenido.
				</li>
				<li>
					Crear una fila nueva sin cliente y guardar dispara un error simulado del backend,
					para ver el manejo de fallos.
				</li>
				<li>
					<strong>Deshacer / Rehacer</strong> con los botones o con <code>⌘Z</code> /
					<code>⌘⇧Z</code>. El historial es del controlador, no de jspreadsheet, así que
					también revierte altas y bajas de fila junto con su estado en el changeset.
				</li>
				<li>
					Los botones de arriba cambian el prop <code>toolbar</code>. Alternar presets no
					reconstruye la grilla: los cambios pendientes y el historial siguen ahí.
				</li>
				<li>
					Con <strong>Oculta</strong>, el componente no dibuja barra. Es el modo para cuando
					el contenedor monta la suya con <code>controller.commands</code>.
				</li>
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
