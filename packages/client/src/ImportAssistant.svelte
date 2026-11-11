<!--
@component
ImportAssistant — el asistente de importación con agente (SB-36), en una
ventana a pantalla completa sobre la tabla de origen. Dos columnas desde que
abre: el contenido a la izquierda y el chat con el agente a la derecha (en
pantallas chicas, el chat es una pestaña). El contenido va en pestañas:
**Archivos** y, tras el análisis, **una por tabla destino** con su staging y
su botón para importarla sola. Cuatro pasos:

1. **Archivos**: se sueltan archivos o carpetas (las carpetas y los zips se
   abren en el navegador); cada uno sube al soltarlo. La lista es una hoja:
   por archivo se fija el destino y una instrucción. Las instrucciones
   generales van en el chat.
2. **Análisis**: el agente llena Estado, Análisis, Destino, Filas y Errores;
   al terminar cada archivo deja su veredicto en el chat.
3. **Importando**: en segundo plano; la ventana se puede cerrar.
4. **Resultado**: totales y resultado por archivo.

Al inicio de cada archivo, «Ver documento» (el archivo tal cual) y «Ver en
staging»: abre la pestaña de su tabla destino —la hoja **real** con los cambios
de toda la corrida como pendientes (§8 y §10 de `05-asistente-importacion.md`),
con los problemas en la celda y el panel de cambios— y resalta las filas que
salieron de ese archivo. Cada pestaña de destino importa su tabla; «Importar
todo» importa todas (con confirmación si un reemplazo elimina filas): guarda
cada hoja y marca la corrida. Al abrir, se retoma la corrida que quedó a medias
en `origen`; el chat y el progreso llegan en vivo y «Detener» corta al agente.

Con `target` (id o elemento), ese contenedor recibe archivos: al arrastrar se
cubre con una capa y al soltar se abre el asistente con los archivos subiendo.

```svelte
<div id="tabla-planes">…</div>
<ImportAssistant url="/api/import-assistant" target="tabla-planes" origen="Planes GMF" onclose={recargar} />
```
-->
<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { CellValue, ImportRunFileView } from '@spreadbase/core';
	import X from '@lucide/svelte/icons/x';
	import Upload from '@lucide/svelte/icons/upload';
	import FolderUp from '@lucide/svelte/icons/folder-up';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Send from '@lucide/svelte/icons/send';
	import Bot from '@lucide/svelte/icons/bot';
	import FileText from '@lucide/svelte/icons/file-text';
	import Table2 from '@lucide/svelte/icons/table-2';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Square from '@lucide/svelte/icons/square';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import House from '@lucide/svelte/icons/house';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import SpreadBase from './SpreadBase.svelte';
	import { Sheet } from './Sheet.svelte';
	import { ImportAssistantState, destinationValue, type ImportAssistantStep, type ImportDestinationTab, type ImportStagingCounts, type ImportStagingView } from './ImportAssistantState.svelte';
	import type { ColumnDef, GridRow } from './types';

	interface Props {
		/** La base de `importAssistantRoutes` en el servidor. */
		url: string;
		/** Cabeceras de cada petición (p. ej. `Authorization`). */
		headers?: () => Record<string, string>;
		/**
		 * El contenedor que recibe archivos (id o elemento): al arrastrar sobre él
		 * se cubre con una capa y al soltar se abre el asistente con esos archivos.
		 */
		target?: string | HTMLElement | null;
		/** El texto de la capa al arrastrar. Default: «Suelta para importar a {origen}». */
		dropHint?: string;
		/** Abierta o cerrada. Default: abierta, salvo con `target` (se abre al soltar). */
		open?: boolean;
		/** La tabla de origen, para el subtítulo. */
		origen?: string;
		/** Cómo se avisa al terminar de importar (lo dice la app): «te avisamos en el panel y por WhatsApp». */
		aviso?: string;
		/** Volver a abrir una corrida que ya existe. */
		run?: string;
		/** Se cerró (la importación, si empezó, sigue en el servidor). */
		onclose?: () => void;
		/** El estado, para quien lo quiera leer desde fuera (`bind:assistant`). */
		assistant?: ImportAssistantState;
	}

	let {
		url,
		headers,
		target,
		dropHint,
		open = $bindable(),
		origen,
		aviso = 'te avisamos al terminar',
		run,
		onclose,
		assistant: exposed = $bindable()
	}: Props = $props();

	// Se crea una vez, con la URL y la corrida de entrada.
	const a = untrack(() => new ImportAssistantState(url, { headers, run, origen }));
	exposed = a;
	let started = false;
	/** Sin `open` explícito: abierta, salvo que espere archivos en un `target`. */
	const isOpen = $derived(open ?? !target);

	let dialog = $state<HTMLDialogElement>();
	$effect(() => {
		if (!dialog) return;
		if (isOpen && !dialog.open) {
			dialog.showModal();
			if (!started) {
				started = true;
				void a.init();
			} else void a.reopen();
		} else if (!isOpen && dialog.open) dialog.close();
	});
	onDestroy(() => a.close());

	/** Escape dentro de una hoja (cancelar la edición de una celda) es de la hoja: no cierra la ventana. */
	let gridEscape = false;
	function escapeInGrid(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		const active = document.activeElement;
		gridEscape = !!dialog?.querySelector('td.editor') || !!active?.closest('.oc-grid') || active?.id === 'jss_textarea';
	}

	function close() {
		a.close();
		open = false;
		onclose?.();
	}

	const step = $derived(a.step);
	const steps = ['Archivos', 'Análisis', 'Importando', 'Resultado'];
	const files = $derived(a.files);
	const analyzing = $derived(a.run?.estado === 'analizando' || files.some((f) => f.estado === 'analizando' || (f.estado === 'en_cola' && a.run?.estado !== 'importando')));
	const titleId = `sb-import-assistant-${Math.random().toString(36).slice(2, 8)}`;

	// -- soltar archivos: sobre el `target` y dentro del asistente ----------------------------
	const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

	/** Llegaron archivos (soltados o elegidos): si la corrida ya se importó, empieza otra. */
	function receive(data: DataTransfer | File[]) {
		if (a.closedRun) a.reset();
		open = true;
		void (Array.isArray(data) ? a.choose(data) : a.drop(data));
	}

	let targetRect = $state<{ top: number; left: number; width: number; height: number } | null>(null);
	$effect(() => {
		const el = typeof target === 'string' ? document.getElementById(target) : target;
		if (!el) return;
		let depth = 0;
		const show = () => {
			const r = el.getBoundingClientRect();
			targetRect = { top: r.top, left: r.left, width: r.width, height: r.height };
		};
		const hide = () => {
			depth = 0;
			targetRect = null;
		};
		const enter = (e: DragEvent) => {
			if (!hasFiles(e) || dialog?.open) return;
			e.preventDefault();
			depth++;
			show();
		};
		const over = (e: DragEvent) => {
			if (!hasFiles(e) || dialog?.open) return;
			e.preventDefault();
			e.dataTransfer!.dropEffect = 'copy';
			if (!targetRect) show();
		};
		const leave = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			depth = Math.max(0, depth - 1);
			if (!depth) targetRect = null;
		};
		const drop = (e: DragEvent) => {
			if (!hasFiles(e) || dialog?.open) return;
			e.preventDefault();
			hide();
			receive(e.dataTransfer!);
		};
		el.addEventListener('dragenter', enter);
		el.addEventListener('dragover', over);
		el.addEventListener('dragleave', leave);
		el.addEventListener('drop', drop);
		window.addEventListener('dragend', hide);
		window.addEventListener('drop', hide);
		return () => {
			el.removeEventListener('dragenter', enter);
			el.removeEventListener('dragover', over);
			el.removeEventListener('dragleave', leave);
			el.removeEventListener('drop', drop);
			window.removeEventListener('dragend', hide);
			window.removeEventListener('drop', hide);
		};
	});

	let input = $state<HTMLInputElement>();
	let folderInput = $state<HTMLInputElement>();
	/** Arrastrando sobre el panel izquierdo del asistente. */
	let dragging = $state(0);

	/** Se agregan archivos mientras no se haya empezado a importar (después, el navegador no debe abrirlos). */
	const accepts = $derived(step <= 2 && !a.closedRun);

	function ondrop(event: DragEvent) {
		if (!hasFiles(event)) return;
		event.preventDefault();
		dragging = 0;
		if (!accepts) return;
		a.closeStaging();
		docFile = null;
		receive(event.dataTransfer!);
	}

	function chosen(e: Event) {
		const el = e.currentTarget as HTMLInputElement;
		if (el.files?.length) receive([...el.files]);
		el.value = '';
	}

	// -- presentación de un archivo -------------------------------------------------------------
	const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
	const isImage = (f: ImportRunFileView) => f.tipo.startsWith('image/') && f.tipo !== 'image/heic';
	const extOf = (f: ImportRunFileView) => f.nombre.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]?.toUpperCase() ?? f.tipo.split('/').pop()!.toUpperCase();
	const typeLabel = (f: ImportRunFileView) => `${extOf(f)} · ${kb(f.tamano)}`;

	/** El ícono de la celda: la miniatura de una imagen o una etiqueta con la extensión (SVG en línea). */
	function iconOf(f: ImportRunFileView): string {
		if (isImage(f)) return f.url;
		const ext = extOf(f).slice(0, 4);
		const color = /PDF/.test(ext) ? '#dc2626' : /XLS|CSV/.test(ext) ? '#16a34a' : /ZIP/.test(ext) ? '#d97706' : /DOC/.test(ext) ? '#2563eb' : '#64748b';
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><path d="M9 3h15l8 8v24a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z" fill="${color}"/><path d="M24 3v8h8" fill="#ffffff55"/><text x="19" y="29" font-family="system-ui,sans-serif" font-size="${ext.length > 3 ? 7.5 : 9}" font-weight="700" fill="#fff" text-anchor="middle">${ext}</text></svg>`;
		return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	}

	function resultText(f: ImportRunFileView): string {
		const r = f.resultado;
		if (!r) return f.error ? `Error: ${f.error}` : '—';
		if (r.status === 'error') return `Error${r.mensaje ? `: ${r.mensaje}` : ''}`;
		if (f.destino?.tipo === 'adjuntar') return r.mensaje?.startsWith('En la columna') ? r.mensaje : 'Adjuntado';
		if (r.mensaje === 'Guardado con el staging') return 'Guardado con el staging';
		if (f.destino?.tipo === 'descartar') return 'Descartado';
		return r.error ? `${r.ok} importadas · ${r.error} con error` : `${r.ok} importadas`;
	}

	function stateText(f: ImportRunFileView): string {
		const mine = f.destinoFijadoPorUsuario ? ' · fijado por ti' : '';
		switch (f.estado) {
			case 'pendiente':
				return `Pendiente${mine}`;
			case 'en_cola':
				return a.run?.estado === 'importando' ? 'En cola para importar…' : 'En cola…';
			case 'analizando': {
				// Lo que llega en vivo (SSE `progreso`) de ese archivo, o de la corrida si el agente trabaja varios a la vez.
				const live = a.progress[f.id] ?? a.progress['*'];
				return live ? `Analizando… ${live}` : 'Analizando…';
			}
			case 'analizado':
				return `Analizado${mine}`;
			case 'importando':
				return a.progress[f.id] ? `Importando… ${a.progress[f.id]}` : 'Importando…';
			default:
				return resultText(f);
		}
	}

	/** El ícono de la celda Estado: un spinner animado mientras trabaja; si no, el estado en un vistazo. */
	const svgIcon = (body: string, name: string) =>
		`data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" data-sb="${name}">${body}</svg>`)}`;
	const STATUS_ICONS = {
		trabajando: svgIcon(
			'<circle cx="12" cy="12" r="8.5" fill="none" stroke="#94a3b8" stroke-opacity=".35" stroke-width="3"/><path d="M20.5 12A8.5 8.5 0 0 0 12 3.5" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></path>',
			'trabajando'
		),
		pendiente: svgIcon('<circle cx="12" cy="12" r="8.5" fill="none" stroke="#94a3b8" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"/>', 'pendiente'),
		listo: svgIcon('<circle cx="12" cy="12" r="9.5" fill="#16a34a"/><path d="m8 12.5 2.7 2.7L16.5 9.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>', 'listo'),
		error: svgIcon('<circle cx="12" cy="12" r="9.5" fill="#dc2626"/><path d="M12 7v6M12 16.5v.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>', 'error')
	};
	function statusIcon(f: ImportRunFileView): string {
		if (f.estado === 'en_cola' || f.estado === 'analizando' || f.estado === 'importando') return STATUS_ICONS.trabajando;
		if (f.estado === 'pendiente') return STATUS_ICONS.pendiente;
		if (f.estado === 'error' || f.resultado?.status === 'error') return STATUS_ICONS.error;
		return STATUS_ICONS.listo;
	}

	function analysisText(f: ImportRunFileView): string {
		if (f.analisis) return f.analisis;
		if (f.estado === 'error' && !f.resultado) return f.error ?? 'Error';
		return f.estado === 'pendiente' ? 'pendiente' : '';
	}

	// -- la hoja de archivos (local, en memoria) -------------------------------------------------
	const AUTO = 'auto';
	type FileRow = Record<string, CellValue>;

	function fileRows(): FileRow[] {
		return a.files.map((f) => {
			const toRows = f.destino?.tipo === 'filas';
			const value = destinationValue(f.destino);
			return {
				id: f.id,
				icono: iconOf(f),
				nombre: f.nombre,
				tipo: typeLabel(f),
				carpeta: f.carpeta ?? '—',
				estado: stateText(f),
				// La miniatura de la celda Estado (`avatar.image`): el spinner mientras trabaja.
				estadoIcono: statusIcon(f),
				analisis: analysisText(f),
				destino: !f.destino ? AUTO : a.choices.some((c) => c.value === value) ? value : null,
				instruccion: f.instruccion,
				filas: toRows || f.totalFilas ? f.totalFilas : null,
				errores: toRows ? f.totalErrores : null
			};
		});
	}

	/** Lo que la hoja tiene cargado; si los archivos cambian, se recarga. */
	let loaded = '';
	let loads = $state(0);
	const editable = $derived(step <= 2);
	const removable = $derived(step === 1);

	const filesSheet = $derived.by(() => {
		if (!a.config) return null;
		const canEdit = editable;
		const canRemove = removable;
		const options = [{ value: AUTO, label: 'Automático (lo decide el asistente)' }, ...a.choices.map((c) => ({ value: c.value, label: c.label }))];
		const columns: ColumnDef[] = [
			// Las acciones, al inicio: el documento tal cual y la tabla destino con los cambios.
			{ field: 'documento', label: 'Documento', type: 'action', width: 64, action: { label: 'Ver documento', icon: FileText, showLabel: false, onclick: (row: GridRow) => openDocument(String(row.id)) } },
			{ field: 'staging', label: 'Staging', type: 'action', width: 64, action: { label: 'Ver en staging', icon: Table2, showLabel: false, onclick: (row: GridRow) => void openFile(String(row.id)) } },
			{ field: 'icono', label: 'Icono', type: 'image', width: 52, readOnly: true, filterable: false },
			{ field: 'nombre', label: 'Nombre', type: 'text', width: 170, readOnly: true },
			{ field: 'tipo', label: 'Tipo', type: 'text', width: 84, readOnly: true },
			{ field: 'carpeta', label: 'Carpeta', type: 'text', width: 110, readOnly: true },
			{ field: 'estado', label: 'Estado', type: 'text', width: 210, readOnly: true, avatar: { image: 'estadoIcono', shape: 'square' } },
			{ field: 'analisis', label: 'Análisis', type: 'text', width: 210, readOnly: true },
			{ field: 'destino', label: 'Destino', type: 'select', width: 240, readOnly: !canEdit, options },
			{ field: 'instruccion', label: 'Instrucción', type: 'text', width: 170, readOnly: !canEdit },
			{ field: 'filas', label: 'Filas', type: 'number', width: 60, readOnly: true },
			{ field: 'errores', label: 'Errores', type: 'number', width: 70, readOnly: true },
			...(canRemove
				? [{ field: 'quitar', label: 'Quitar', type: 'action', width: 64, action: { label: 'Quitar', icon: X, showLabel: false, onclick: (row: GridRow) => void a.remove(String(row.id)) } }]
				: [])
		];
		return untrack(
			() =>
				new Sheet({
					id: `import-assistant:files:${Date.now()}`,
					idField: 'id',
					columns,
					// Las acciones, el ícono y el nombre quedan fijos al desplazarse hacia Destino e Instrucción
					// (en pantallas chicas, ninguna: fijas no dejarían ver Estado).
					frozenColumns: typeof window !== 'undefined' && window.innerWidth < 640 ? 0 : 4,
					persist: 'none',
					dataSource: {
						load: async () => {
							const rows = fileRows();
							loaded = JSON.stringify(rows);
							loads++;
							return rows;
						}
					}
				})
		);
	});

	// Cambió la corrida (sondeo, análisis, chat): la hoja se vuelve a cargar con lo nuevo.
	const filesSignature = $derived(JSON.stringify(fileRows()));
	$effect(() => {
		const grid = filesSheet?.grid;
		const signature = filesSignature;
		if (!grid?.sheetReady || signature === loaded) return;
		untrack(() => grid.commands.reload());
	});

	// Los archivos con errores, en rojo en su celda (una vez por carga).
	let marked = -1;
	$effect(() => {
		const grid = filesSheet?.grid;
		grid?.version;
		const seq = loads;
		if (!grid || seq === marked || grid.loading) return;
		marked = seq;
		untrack(() =>
			grid.setExternalErrors(
				grid.rows
					.filter((r) => Number(r.errores) > 0)
					.map((r) => ({ rowKey: r.__key, field: 'errores', message: 'Filas con error: ábrelo para verlas' }))
			)
		);
	});

	// Editar Destino o Instrucción en la hoja: se guarda en el servidor en cuanto se confirma la celda.
	const sent = new Map<string, string>();
	$effect(() => {
		const grid = filesSheet?.grid;
		grid?.version;
		if (!grid || !editable) return;
		untrack(() => {
			for (const row of grid.rows) {
				for (const field of ['destino', 'instruccion'] as const) {
					if (!grid.isDirtyCell(row.__key, field)) continue;
					const value = (row[field] ?? null) as CellValue;
					const key = `${row.id}:${field}`;
					if (sent.get(key) === JSON.stringify(value)) continue;
					sent.set(key, JSON.stringify(value));
					void push(String(row.id), field, value).finally(() => {
						sent.delete(key);
						if (filesSheet?.grid === grid) grid.commands.reload();
					});
				}
			}
		});
	});

	async function push(file: string, field: 'destino' | 'instruccion', value: CellValue): Promise<boolean> {
		if (field === 'instruccion') return a.setInstruction(file, value === null ? '' : String(value));
		const choice = a.choices.find((c) => c.value === value);
		return a.setDestination(file, choice ? choice.destino : null);
	}

	// -- «Ver documento», «Ver en staging» y las pestañas de destino (§10) ----------------------

	/** «Ver en staging»: la pestaña de la tabla destino del archivo, con sus filas resaltadas. */
	async function openFile(id: string) {
		mobileTab = 'contenido';
		docFile = null;
		const destino = a.stagingFor(files.find((f) => f.id === id) ?? null);
		if (destino) await a.openStaging(destino, { highlight: id });
		else a.error = 'No hay una tabla destino para ver el staging';
	}

	/** «Ver documento»: el archivo tal cual (imagen, PDF) en la pestaña Archivos. */
	let docFile = $state<string | null>(null);
	const docView = $derived(docFile ? (files.find((f) => f.id === docFile) ?? null) : null);
	function openDocument(id: string) {
		mobileTab = 'contenido';
		a.closeStaging();
		docFile = id;
	}

	/** Cambiar de pestaña: Archivos o la de un destino (su hoja se pide la primera vez). */
	function selectTab(tab: string) {
		mobileTab = 'contenido';
		a.confirmDeletes = null;
		if (tab === 'archivos') a.closeStaging();
		else void a.openStaging(tab);
	}

	const tabs = $derived(a.destinationTabs);
	const pendingTabs = $derived(tabs.filter((t) => !t.importado));

	// Cada hoja de staging cargó: se le aplican los cambios (y, si «Importar» lo estaba esperando, sigue).
	let importAfterApply: { destinos: string[] | null } | null = null;
	$effect(() => {
		for (const view of Object.values(a.stagings)) {
			const grid = view.sheet.grid;
			grid?.version;
			if (view.applied || !grid || !grid.sheetReady || grid.loading) continue;
			untrack(() =>
				void a.applyStaging(view.destino).then(() => {
					const pending = importAfterApply;
					if (pending) {
						importAfterApply = null;
						void runImport(false, pending.destinos);
					}
				})
			);
		}
	});
	// La persona edita un staging: sus cambios se guardan en la corrida.
	$effect(() => {
		for (const view of Object.values(a.stagings)) {
			const grid = view.sheet.grid;
			grid?.version;
			if (!view.applied || !grid) continue;
			untrack(() => a.stagingEdited(view.destino));
		}
	});
	// La pestaña a la vista es un destino sin hoja (recién importado, al retomar) o con archivos que cambiaron: se pide otra vez.
	$effect(() => {
		const tab = a.tab;
		if (tab === 'archivos' || !a.run || a.loadingStaging[tab]) return;
		const info = tabs.find((t) => t.destino === tab);
		const view = a.stagings[tab];
		if (!info) {
			if (!view) untrack(() => a.closeStaging());
			return;
		}
		if (!view) untrack(() => void a.openStaging(tab));
		else if (view.applied && !info.trabajando && view.files !== a.stagingSignature(tab) && view.signature === JSON.stringify(untrack(() => a.stagingChanges(view)))) {
			untrack(() => void a.openStaging(tab, { fresh: true }));
		}
	});
	// Los conteos de cada pestaña sin hoja abierta (cuando cambian sus archivos y nada se está analizando).
	$effect(() => {
		const signature = JSON.stringify(tabs.map((t) => [t.destino, a.stagingSignature(t.destino)]));
		if (!a.run || analyzing || !signature) return;
		untrack(() => void a.refreshSummaries());
	});

	/**
	 * «Importar» (el de una pestaña, con su destino, o «Importar todo»): guarda
	 * la hoja de cada staging (con confirmación si un replace elimina filas) y
	 * marca la corrida.
	 */
	async function runImport(confirmed = false, destinos: string[] | null = null) {
		mobileTab = 'contenido';
		docFile = null;
		const result = await a.importStaging(confirmed, destinos);
		if (result === 'open') importAfterApply = { destinos };
	}

	const n = (k: number, uno: string, varios: string) => `${k} ${k === 1 ? uno : varios}`;
	/** Los conteos en palabras: «2 nuevas · 1 actualizada · 1 eliminada · 0 errores». */
	const countsText = (r: ImportStagingCounts) => `${n(r.insert, 'nueva', 'nuevas')} · ${n(r.update, 'actualizada', 'actualizadas')} · ${n(r.delete, 'eliminada', 'eliminadas')} · ${n(r.errores, 'error', 'errores')}`;

	function stagingSummary(view: ImportStagingView): string {
		const r = view.set.resumen;
		const modo = view.set.modo === 'replace' ? 'Reemplazar' : 'Actualizar o agregar';
		const parts = [`${r.insert} ${r.insert === 1 ? 'nueva' : 'nuevas'}`, `${r.update} con cambios`, ...(view.set.modo === 'replace' ? [`${r.delete} se ${r.delete === 1 ? 'elimina' : 'eliminan'}`] : [])];
		return `${modo} · ${view.set.base.filas} filas hoy · ${parts.join(' · ')}${r.errores ? ` · ${r.errores} con error` : ''}`;
	}
	const tabOf = (destino: string): ImportDestinationTab | undefined => tabs.find((t) => t.destino === destino);
	const fileName = (id: string) => files.find((f) => f.id === id)?.nombre ?? id;

	// -- pie --------------------------------------------------------------------------------------
	const status = $derived.by(() => {
		const n = files.length;
		if (step === 1) {
			const up = a.uploading ? ` · subiendo ${a.uploading}…` : '';
			return n ? `${n} ${n === 1 ? 'archivo' : 'archivos'} · ${kb(a.totalBytes)} · se suben en cuanto los sueltas${up}` : `Suelta archivos o carpetas para empezar${up}`;
		}
		if (step === 2) {
			if (analyzing) {
				const done = files.filter((f) => f.estado === 'analizado' || f.estado === 'error').length;
				return `Analizando ${done} de ${n} archivos…`;
			}
			return 'Revisa a dónde va cada archivo; puedes cambiar el destino o pedirle ajustes al asistente';
		}
		if (step === 3) return `Importando ${n} ${n === 1 ? 'archivo' : 'archivos'} en segundo plano`;
		const bad = a.totals.archivosConError;
		return bad ? `Terminado · ${bad} ${bad === 1 ? 'archivo' : 'archivos'} con filas por corregir` : 'Terminado';
	});

	const primary = $derived.by(() => {
		if (step === 1) return { label: 'Analizar', arrow: true, disabled: !files.length || a.uploading > 0 || a.busy === 'analyze', run: () => a.analyze() };
		// «Importar todo»: todos los stagings y lo demás (adjuntos, descartes).
		if (step === 2) return { label: 'Importar todo', arrow: true, disabled: analyzing || !files.length || a.busy === 'import' || !!a.confirmDeletes || files.every((f) => f.estado === 'importado'), run: () => runImport() };
		if (step === 3) return { label: 'Cerrar (sigue en segundo plano)', arrow: false, disabled: false, run: close };
		return { label: 'Listo', arrow: false, disabled: false, run: close };
	});
	const back = $derived(step === 2 ? { label: 'Archivos', to: 1 as ImportAssistantStep } : step === 4 ? { label: 'Volver al análisis', to: 2 as ImportAssistantStep } : null);

	// -- chat -------------------------------------------------------------------------------------
	/** En pantallas chicas, el contenido y el chat son pestañas. */
	let mobileTab = $state<'contenido' | 'chat'>('contenido');
	let draft = $state('');
	let chatList = $state<HTMLElement>();
	const openedAt = new Date().toISOString();
	const beforeAnalysis = $derived(!a.run || (a.run.estado === 'nueva' && files.every((f) => f.estado === 'pendiente')));
	const hour = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

	async function send(event?: Event) {
		event?.preventDefault();
		const text = draft.trim();
		if (!text || a.busy === 'chat') return;
		draft = '';
		if (!(await a.send(text))) draft = text;
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) void send(event);
	}

	$effect(() => {
		a.run?.chat.length;
		a.streaming;
		a.busy;
		mobileTab;
		if (chatList) queueMicrotask(() => chatList && (chatList.scrollTop = chatList.scrollHeight));
	});
	const unread = $derived(a.run?.chat.filter((m) => m.rol !== 'usuario').length ?? 0);
</script>

{#snippet preview(f: ImportRunFileView)}
	<div class="rounded-box bg-base-200 grid min-h-0 flex-1 place-items-center overflow-auto" data-testid="doc-preview">
		{#if isImage(f)}
			<img src={f.url} alt="Vista previa de {f.nombre}" class="max-h-full object-contain" />
		{:else if f.tipo === 'application/pdf'}
			<object data={f.url} type="application/pdf" class="h-full w-full" aria-label="PDF {f.nombre}">
				<p class="p-6 text-sm">El navegador no muestra el PDF aquí: ábrelo en otra pestaña.</p>
			</object>
		{:else}
			<p class="text-base-content/70 p-6 text-sm">Sin vista previa para este tipo: ábrelo en otra pestaña.</p>
		{/if}
	</div>
{/snippet}

{#if targetRect}
	<!-- La capa sobre el contenedor de origen mientras se arrastran archivos. -->
	<div
		class="rounded-box border-primary bg-primary/10 text-primary pointer-events-none fixed z-[60] grid place-items-center border-2 border-dashed backdrop-blur-[1px]"
		style:top="{targetRect.top}px"
		style:left="{targetRect.left}px"
		style:width="{targetRect.width}px"
		style:height="{targetRect.height}px"
		data-testid="import-drop-overlay"
	>
		<div class="bg-base-100 rounded-box flex items-center gap-3 px-5 py-3 shadow-lg">
			<Upload size={22} aria-hidden="true" />
			<strong class="text-base-content">{dropHint ?? (origen ? `Suelta para importar a ${origen}` : 'Suelta para importar')}</strong>
		</div>
	</div>
{/if}

<dialog bind:this={dialog} class="modal" aria-labelledby={titleId} onkeydowncapture={escapeInGrid} oncancel={(e) => (e.preventDefault(), gridEscape ? (gridEscape = false) : close())}>
	<!-- A pantalla completa: sin márgenes ni esquinas (100vw × 100dvh). -->
	<section class="modal-box bg-base-100 flex h-dvh max-h-none w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 shadow-none" data-testid="import-assistant">
		<!-- Encabezado: título, tabla de origen, pasos y cerrar. -->
		<header class="border-base-300 flex items-center justify-between gap-4 border-b px-4 py-3 sm:px-6">
			<div class="flex min-w-0 flex-col">
				<h2 id={titleId} class="flex items-center gap-2 text-lg font-bold">
					Importar archivos
					{#if a.resumed}<span class="badge badge-soft badge-info badge-sm font-normal" data-testid="resumed">Retomada</span>{/if}
				</h2>
				{#if origen}
					<p class="text-base-content/70 truncate text-sm">Tabla de origen: <strong class="text-base-content">{origen}</strong><span class="hidden sm:inline"> · el asistente decide a dónde va cada archivo</span></p>
				{/if}
			</div>
			<ol class="steps steps-horizontal hidden text-xs md:grid" aria-label="Pasos">
				{#each steps as name, i (name)}
					<li class="step {i + 1 <= step ? 'step-primary' : ''}" aria-current={i + 1 === step ? 'step' : undefined} data-content={i + 1 < step ? '✓' : String(i + 1)}>
						{name}
					</li>
				{/each}
			</ol>
			<div class="flex shrink-0 items-center gap-1">
				{#if files.length || (a.run?.chat.length ?? 0) > 0}
					<button
						type="button"
						class="btn btn-ghost btn-sm"
						title="Deja esta corrida y empieza otra vacía"
						disabled={a.working || a.busy !== null}
						onclick={() => ((docFile = null), void a.startOver())}><RotateCcw size={14} aria-hidden="true" />Empezar de cero</button
					>
				{/if}
				<button type="button" class="btn btn-square btn-ghost" aria-label="Cerrar" onclick={close}><X size={18} aria-hidden="true" /></button>
			</div>
		</header>

		<!--
			Pestañas (§10): Archivos, una por tabla destino con staging (con sus conteos) y, en pantallas
			chicas, el chat. Un spinner dice qué está trabajando.
		-->
		<div role="tablist" aria-label="Vistas" class="tabs tabs-border border-base-300 flex shrink-0 flex-nowrap overflow-x-auto border-b px-2 sm:px-4">
			<button
				type="button"
				role="tab"
				class="tab shrink-0 gap-2 {a.tab === 'archivos' && mobileTab === 'contenido' ? 'tab-active' : ''}"
				aria-selected={a.tab === 'archivos' && mobileTab === 'contenido'}
				data-tab="archivos"
				onclick={() => selectTab('archivos')}
			>
				<House size={15} aria-hidden="true" />Archivos
				{#if a.working || a.uploading}<span class="loading loading-spinner loading-xs text-primary" data-testid="tab-working" aria-label="Trabajando"></span>
				{:else if files.length}<span class="badge badge-sm badge-ghost">{files.length}</span>{/if}
			</button>
			{#each tabs as t (t.destino)}
				<button
					type="button"
					role="tab"
					class="tab shrink-0 gap-2 {a.tab === t.destino && mobileTab === 'contenido' ? 'tab-active' : ''}"
					aria-selected={a.tab === t.destino && mobileTab === 'contenido'}
					data-tab={t.destino}
					title={t.importado ? `${t.label}: importada` : t.resumen ? `${t.label}: ${countsText(t.resumen)}` : t.label}
					onclick={() => selectTab(t.destino)}
				>
					<Table2 size={15} aria-hidden="true" /><span class="whitespace-nowrap">{t.label}</span>
					{#if t.trabajando}<span class="loading loading-spinner loading-xs text-primary" data-testid="tab-working" aria-label="Recalculando"></span>{/if}
					{#if t.importado}
						<span class="badge badge-sm badge-success badge-soft gap-1" data-testid="tab-counts"><CircleCheck size={12} aria-hidden="true" />importada</span>
					{:else if t.resumen}
						{@const r = t.resumen}
						<span class="flex items-center gap-0.5" data-testid="tab-counts">
							<span class="sr-only">{countsText(r)}</span>
							<span class="badge badge-xs badge-success badge-soft" aria-hidden="true">+{r.insert}</span>
							<span class="badge badge-xs badge-warning badge-soft" aria-hidden="true">~{r.update}</span>
							<span class="badge badge-xs badge-error badge-soft" aria-hidden="true">−{r.delete}</span>
							{#if r.errores}<span class="badge badge-xs badge-error" aria-hidden="true">{r.errores} !</span>{/if}
						</span>
					{/if}
				</button>
			{/each}
			<button type="button" role="tab" class="tab ml-auto shrink-0 gap-2 lg:hidden {mobileTab === 'chat' ? 'tab-active' : ''}" aria-selected={mobileTab === 'chat'} onclick={() => (mobileTab = 'chat')}>
				Chat <span class="badge badge-sm badge-neutral">{unread + 1}</span>
			</button>
		</div>

		<div class="flex min-h-0 flex-1">
			<!-- Izquierda: archivos, o el detalle de uno. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="relative min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:px-6 {mobileTab === 'chat' ? 'hidden lg:flex' : 'flex'}"
				ondragenter={(e) => hasFiles(e) && (e.preventDefault(), accepts && dragging++)}
				ondragover={(e) => hasFiles(e) && e.preventDefault()}
				ondragleave={(e) => hasFiles(e) && (dragging = Math.max(0, dragging - 1))}
				{ondrop}
			>
				<input bind:this={input} class="hidden" type="file" multiple aria-label="Archivos a importar" onchange={chosen} />
				<input bind:this={folderInput} class="hidden" type="file" webkitdirectory multiple aria-label="Carpeta a importar" onchange={chosen} />

				<!-- Pestaña Archivos: la zona para soltar, la hoja de archivos o un documento. -->
				<div role="tabpanel" aria-label="Archivos" class="min-h-0 flex-1 flex-col gap-3 {a.tab === 'archivos' ? 'flex' : 'hidden'}">
					{#if docView}
						<nav class="breadcrumbs shrink-0 py-0 text-sm" aria-label="Migas">
							<ul>
								<li><button type="button" class="link link-hover" onclick={() => (docFile = null)}>Archivos</button></li>
								<li><span class="font-mono font-medium" aria-current="page">{docView.nombre}</span></li>
							</ul>
						</nav>
						<section class="flex min-h-0 flex-1 flex-col gap-3" aria-label="Documento {docView.nombre}">
							<div class="flex shrink-0 flex-wrap items-start justify-between gap-3">
								<div class="flex min-w-0 flex-col gap-1">
									<p class="text-sm" data-testid="doc-analysis"><span class="text-base-content/60">Análisis:</span> {analysisText(docView) || '—'}</p>
									<p class="text-base-content/70 text-xs">{typeLabel(docView)} · {a.describe(docView.destino)} · {stateText(docView)}</p>
								</div>
								<a class="btn btn-ghost btn-sm" href={docView.url} target="_blank" rel="noopener"><ExternalLink size={14} aria-hidden="true" />Abrir en otra pestaña</a>
							</div>
							{@render preview(docView)}
						</section>
					{:else}
						{#if step === 1}
							<!-- Zona para soltar: todo el panel sin archivos; una franja con archivos. -->
							<div
								class="rounded-box border-base-content/25 bg-base-200/60 flex border-2 border-dashed {files.length || a.uploading
									? 'shrink-0 flex-wrap items-center gap-3 px-4 py-2'
									: 'flex-1 flex-col items-center justify-center gap-4 p-8 text-center'}"
								role="region"
								aria-label="Soltar archivos"
							>
								<span class="bg-primary/10 text-primary rounded-field grid place-items-center {files.length || a.uploading ? 'size-9' : 'size-16'}">
									<Upload size={files.length || a.uploading ? 18 : 30} aria-hidden="true" />
								</span>
								<div class="flex min-w-48 flex-1 flex-col {files.length || a.uploading ? '' : 'max-w-xl flex-none items-center'}">
									<strong class={files.length || a.uploading ? 'text-sm' : 'text-lg'}>{files.length || a.uploading ? 'Suelta más archivos o carpetas aquí' : 'Suelta aquí archivos o carpetas'}</strong>
									<span class="text-base-content/70 text-xs">
										{#if a.config}
											{a.config.limites.tipos.map((t) => t.toUpperCase()).join(', ')} · hasta {a.config.limites.maxArchivoMB} MB por archivo y {a.config.limites.maxLoteMB} MB por lote · las carpetas y zips se abren en archivos sueltos
										{:else}
											Cargando límites…
										{/if}
									</span>
								</div>
								<div class="flex flex-wrap justify-center gap-2">
									<button type="button" class="btn btn-sm" onclick={() => folderInput?.click()}><FolderUp size={16} aria-hidden="true" />Elegir carpeta</button>
									<button type="button" class="btn btn-sm {files.length || a.uploading ? '' : 'btn-primary'}" onclick={() => input?.click()}><Upload size={16} aria-hidden="true" />Elegir archivos</button>
								</div>
							</div>
							{#each a.uploads.filter((u) => u.estado === 'error') as u (u.id)}
								<div role="alert" class="alert alert-error alert-soft shrink-0 py-2 text-sm">
									<TriangleAlert size={16} aria-hidden="true" /><span>«{u.nombre}» no se subió: {u.error}</span>
									<button type="button" class="btn btn-ghost btn-xs" onclick={() => a.dismissUpload(u.id)}>Quitar aviso</button>
								</div>
							{/each}
							{#if a.uploading}
								<p class="text-base-content/70 flex shrink-0 items-center gap-2 text-xs" role="status">
									<span class="loading loading-spinner loading-xs"></span>Subiendo {a.uploads
										.filter((u) => u.estado === 'subiendo')
										.map((u) => u.nombre)
										.join(', ')}…
								</p>
							{/if}
						{/if}

						{#if step === 3}
							<div role="status" class="alert alert-info alert-soft shrink-0 text-sm">
								<span><strong>Importando en segundo plano.</strong> Puedes cerrar esta ventana: {aviso}.</span>
							</div>
						{/if}

						{#if step === 4}
							<div class="grid shrink-0 gap-3 sm:grid-cols-2" aria-label="Totales">
								<div class="rounded-box bg-success/10 flex flex-col px-4 py-3">
									<span class="text-success text-xs font-semibold uppercase">Importados</span>
									<strong class="text-2xl" data-testid="total-ok"
										>{#if a.totals.staging}{a.totals.staging.insert} {a.totals.staging.insert === 1 ? 'nueva' : 'nuevas'} · {a.totals.staging.update}
											{a.totals.staging.update === 1 ? 'actualizada' : 'actualizadas'} · {a.totals.staging.delete}
											{a.totals.staging.delete === 1 ? 'eliminada' : 'eliminadas'}{:else}{a.totals.filas} {a.totals.filas === 1 ? 'fila' : 'filas'}{/if}{a.totals.adjuntos
											? ` · ${a.totals.adjuntos} ${a.totals.adjuntos === 1 ? 'archivo adjunto' : 'archivos adjuntos'}`
											: ''}</strong
									>
								</div>
								<div class="rounded-box bg-error/10 flex flex-col px-4 py-3">
									<span class="text-error text-xs font-semibold uppercase">Con error</span>
									<strong class="text-2xl" data-testid="total-error">{a.totals.errores} {a.totals.errores === 1 ? 'fila' : 'filas'}</strong>
								</div>
							</div>
						{/if}

						{#if files.length && filesSheet}
							<div class="flex min-h-0 flex-1 flex-col" data-testid="files-sheet" aria-label="Archivos">
								{#key filesSheet}
									<SpreadBase sheet={filesSheet} fill toolbar={false} legend={false} />
								{/key}
							</div>
						{/if}
					{/if}
				</div>

				<!-- Una pestaña por tabla destino: la hoja real con los cambios de la corrida (§8.3, §10); sigue viva al cambiar de pestaña. -->
				{#each Object.values(a.stagings) as view (view.sheet)}
					{@const info = tabOf(view.destino)}
					{@const mark = a.highlighted(view.destino)}
					<div class="min-h-0 flex-1 flex-col gap-2 {a.tab === view.destino ? 'flex' : 'hidden'}" role="tabpanel" aria-label="Staging de {view.label}">
						<div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
							<div class="flex min-w-0 flex-1 flex-col">
								<p class="text-base-content/70 text-xs" data-testid="staging-summary">{stagingSummary(view)}</p>
								{#if info?.archivos.length}<p class="text-base-content/60 truncate text-xs" data-testid="staging-files">De {info.archivos.map((f) => f.nombre).join(', ')}</p>{/if}
							</div>
							{#if mark}
								<span class="badge badge-info badge-soft h-auto gap-1 py-1" data-testid="staging-highlight">
									{mark.rows ? `${n(mark.rows, 'fila resaltada', 'filas resaltadas')} de «${mark.file?.nombre ?? 'archivo'}»` : `«${mark.file?.nombre ?? 'archivo'}» no cambia filas de esta tabla`}
									<button type="button" class="btn btn-ghost btn-xs btn-circle" aria-label="Quitar resaltado" onclick={() => a.highlightFile(view.destino, null)}><X size={12} aria-hidden="true" /></button>
								</span>
							{/if}
							<button type="button" class="btn btn-ghost btn-sm" title="Vuelve a calcular el staging con lo último de los archivos" disabled={!view.applied || a.busy === 'import'} onclick={() => void a.openStaging(view.destino, { fresh: true })}
								><RefreshCw size={14} aria-hidden="true" />Recalcular</button
							>
							<button
								type="button"
								class="btn btn-primary btn-sm"
								data-testid="import-destination"
								disabled={!view.applied || !!info?.importado || !info || analyzing || a.busy === 'import' || !!a.confirmDeletes || a.run?.estado === 'importando'}
								onclick={() => void runImport(false, [view.destino])}
							>
								{#if a.busy === 'import'}<span class="loading loading-spinner loading-xs"></span>{/if}
								Importar {view.label}
							</button>
						</div>
						{#if info?.importado && info.publicado}
							<div role="status" class="alert alert-success alert-soft shrink-0 py-1.5 text-sm" data-testid="staging-imported">
								<CircleCheck size={16} aria-hidden="true" /><span>Importada: {n(info.publicado.insert, 'nueva', 'nuevas')} · {n(info.publicado.update, 'actualizada', 'actualizadas')} · {n(info.publicado.delete, 'eliminada', 'eliminadas')}.</span>
							</div>
						{/if}
						{#each view.general as p, k (k)}
							<div role="alert" class="alert alert-soft shrink-0 py-1.5 text-sm {p.nivel === 'error' ? 'alert-error' : 'alert-warning text-base-content'}" data-level={p.nivel}>
								<TriangleAlert size={16} class={p.nivel === 'error' ? '' : 'text-warning'} aria-hidden="true" /><span>{p.key ? `${p.key}: ` : ''}{p.mensaje}</span>
							</div>
						{/each}
						{#each view.set.sinEmparejar as u, k (k)}
							<div role="alert" class="alert alert-soft alert-warning text-base-content shrink-0 py-1.5 text-sm" data-testid="sin-emparejar">
								<TriangleAlert size={16} class="text-warning" aria-hidden="true" /><span>Sin emparejar: {u.motivo}</span>
							</div>
						{/each}
						{#if a.confirmDeletes?.destino === view.destino}
							{@const c = a.confirmDeletes}
							<div role="alertdialog" aria-labelledby="{titleId}-del-{view.destino}" class="rounded-box border-error/40 bg-error/10 text-base-content flex shrink-0 flex-col gap-2 border p-3 text-sm" data-testid="confirm-deletes">
								<strong id="{titleId}-del-{view.destino}" class="text-error">Se {c.filas.length === 1 ? 'eliminará 1 fila' : `eliminarán ${c.filas.length} filas`} de {view.label}: no vienen en los archivos y el modo es reemplazar.</strong>
								<ul class="ml-4 list-disc text-xs">
									{#each c.filas.slice(0, 8) as fila, k (k)}<li>{fila}</li>{/each}
									{#if c.filas.length > 8}<li>… y {c.filas.length - 8} más</li>{/if}
								</ul>
								<div class="flex justify-end gap-2">
									<button type="button" class="btn btn-sm" onclick={() => (a.confirmDeletes = null)}>Cancelar</button>
									<button type="button" class="btn btn-error btn-sm" onclick={() => void runImport(true, c.destinos)}>Eliminar {c.filas.length} e importar</button>
								</div>
							</div>
						{/if}
						<div class="flex min-h-0 flex-1 flex-col" data-testid="staging">
							<SpreadBase sheet={view.sheet} fill legend={false} toolbar={{ groups: [['undo', 'redo'], ['copy', 'paste'], ['addRow', 'deleteRow']] }} />
						</div>
					</div>
				{/each}
				{#if a.tab !== 'archivos' && !a.stagings[a.tab]}
					<div class="grid min-h-0 flex-1 place-items-center" role="status">
						<span class="text-base-content/70 flex items-center gap-2 text-sm"><span class="loading loading-spinner loading-md text-primary"></span>Calculando el staging…</span>
					</div>
				{/if}

				{#if a.error}
					<div role="alert" class="alert alert-error alert-soft shrink-0 text-sm"><TriangleAlert size={16} aria-hidden="true" /><span>{a.error}</span></div>
				{/if}

				{#if dragging && accepts}
					<div class="rounded-box border-primary bg-primary/10 text-primary pointer-events-none absolute inset-2 grid place-items-center border-2 border-dashed">
						<strong class="bg-base-100 rounded-box px-4 py-2 shadow">Suelta para agregar</strong>
					</div>
				{/if}
			</div>

			<!-- Derecha: el chat con el agente, siempre visible. -->
			<aside
				class="border-base-300 bg-base-200/40 w-full shrink-0 flex-col lg:w-[34%] lg:max-w-[30rem] lg:min-w-80 lg:border-l {mobileTab === 'chat' ? 'flex' : 'hidden lg:flex'}"
				aria-label="Chat con el asistente"
			>
				<div class="border-base-300 flex items-center gap-3 border-b px-4 py-3">
					<span class="bg-primary text-primary-content grid size-8 place-items-center rounded-full"><Bot size={17} aria-hidden="true" /></span>
					<div class="flex min-w-0 flex-1 flex-col leading-tight">
						<strong class="text-sm">Asistente</strong>
						<span class="text-base-content/60 text-xs" data-testid="chat-status">
							{a.busy === 'chat' ? 'pensando…' : analyzing ? (a.progress['*'] ?? 'analizando…') : a.run?.estado === 'importando' ? 'importando…' : 'en línea'}
						</span>
					</div>
					{#if a.busy === 'chat' || analyzing}
						<button type="button" class="btn btn-ghost btn-xs" title="Corta lo que está haciendo el asistente" onclick={() => void a.stop()}><Square size={12} aria-hidden="true" />Detener</button>
					{/if}
				</div>
				<div bind:this={chatList} class="flex min-h-0 flex-1 flex-col gap-1 overflow-auto px-3 py-3" role="log" aria-live="polite">
					{#if a.config?.bienvenida}
						<div class="chat chat-start">
							<div class="chat-header text-xs">Asistente <time class="opacity-50">{hour(openedAt)}</time></div>
							<div class="chat-bubble bg-base-100 text-base-content text-sm leading-snug whitespace-pre-line shadow-sm" data-rol="agente" data-bienvenida>{a.config.bienvenida}</div>
						</div>
					{/if}
					{#each a.run?.chat ?? [] as m (m.id)}
						<div class="chat {m.rol === 'usuario' ? 'chat-end' : 'chat-start'}">
							<div class="chat-header text-xs">{m.rol === 'usuario' ? 'Tú' : m.rol === 'sistema' ? 'Sistema' : 'Asistente'} <time class="opacity-50">{hour(m.fecha)}</time></div>
							<div
								class="chat-bubble text-sm leading-snug whitespace-pre-line {m.rol === 'usuario' ? 'chat-bubble-primary' : 'bg-base-100 text-base-content shadow-sm'}"
								data-rol={m.rol}
							>
								{m.texto}
							</div>
						</div>
					{/each}
					{#if a.streaming}
						<!-- El texto del agente mientras lo escribe (en vivo). -->
						<div class="chat chat-start" data-testid="chat-streaming">
							<div class="chat-bubble bg-base-100 text-base-content text-sm leading-snug whitespace-pre-line shadow-sm">{a.streaming}</div>
						</div>
					{:else if a.busy === 'chat'}
						<div class="chat chat-start" data-testid="chat-thinking">
							<div class="chat-bubble bg-base-100 text-base-content/70 flex items-center gap-2 text-sm shadow-sm">
								<span class="loading loading-dots loading-sm"></span>pensando…
							</div>
						</div>
					{/if}
				</div>
				<form class="border-base-300 bg-base-100 flex items-end gap-2 border-t p-3" onsubmit={send}>
					<label class="flex flex-1">
						<span class="sr-only">Mensaje para el asistente</span>
						<textarea
							class="textarea textarea-sm min-h-10 w-full resize-none leading-snug"
							rows="2"
							bind:value={draft}
							{onkeydown}
							placeholder={beforeAnalysis ? 'Instrucciones generales: «ignora los seminuevos»…' : 'Pide un ajuste o pregunta…'}
							disabled={a.busy === 'chat'}
						></textarea>
					</label>
					<button type="submit" class="btn btn-primary btn-sm btn-square" aria-label="Enviar" title="Enviar (Enter)" disabled={a.busy === 'chat' || !draft.trim()}>
						<Send size={15} aria-hidden="true" />
					</button>
				</form>
			</aside>
		</div>

		<!-- Pie: estado a la izquierda; regresar y el paso siguiente a la derecha. -->
		<footer class="border-base-300 flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 sm:px-6">
			<span class="text-base-content/70 line-clamp-2 min-w-0 flex-1 text-xs sm:text-sm" role="status">{status}</span>
			<div class="flex gap-2">
				{#if back}
					<button type="button" class="btn" onclick={() => a.ir(back.to)}><ArrowLeft size={16} aria-hidden="true" />{back.label}</button>
				{/if}
				<!-- «Importar todo» (paso 2): con cuántas tablas y, al pasar el cursor, cuáles y sus conteos. -->
				<div class="group relative">
					<button type="button" class="btn btn-primary" disabled={primary.disabled} aria-describedby={step === 2 && pendingTabs.length ? `${titleId}-tablas` : undefined} onclick={() => void primary.run()}>
						{#if a.busy === 'analyze' || a.busy === 'import'}<span class="loading loading-spinner loading-xs"></span>{/if}
						{primary.label}
						{#if step === 2 && pendingTabs.length}<span class="badge badge-sm" data-testid="import-all-count" aria-label="{n(pendingTabs.length, 'tabla', 'tablas')}">{pendingTabs.length}</span>{/if}
						{#if primary.arrow}<ArrowRight size={16} aria-hidden="true" />{/if}
					</button>
					{#if step === 2 && pendingTabs.length}
						<div
							id="{titleId}-tablas"
							role="tooltip"
							class="rounded-box bg-neutral text-neutral-content pointer-events-none absolute right-0 bottom-full z-20 mb-2 hidden w-max max-w-[min(22rem,calc(100vw-2rem))] p-3 text-xs shadow-lg group-hover:block group-has-[:focus-visible]:block"
							data-testid="import-all-tooltip"
						>
							<p class="mb-1 font-semibold">Importa {n(pendingTabs.length, 'tabla', 'tablas')}:</p>
							<ul class="flex flex-col gap-0.5">
								{#each pendingTabs as t (t.destino)}
									<li><strong>{t.label}</strong>: {t.resumen ? countsText(t.resumen) : 'calculando…'}</li>
								{/each}
							</ul>
							{#if files.some((f) => f.estado !== 'importado' && !a.stagingOf(f))}
								<p class="mt-1 opacity-80">Y los demás archivos (adjuntos y descartes).</p>
							{/if}
						</div>
					{/if}
				</div>
			</div>
		</footer>
	</section>
</dialog>
