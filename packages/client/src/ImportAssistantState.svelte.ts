import type {
	CellValue,
	ImportAssistantConfig,
	ImportChange,
	ImportChangeSet,
	ImportChatResponse,
	ImportDestination,
	ImportFileRows,
	ImportRunFileView,
	ImportRunView
} from '@spreadbase/core';
import { expandZips, filesFromDrop, filesFromInput, type PendingFile } from './assistantFiles';
import { SpreadBaseApiError, type RemoteOptions } from './remote';
import { Sheet } from './Sheet.svelte';
import type { GridController } from './GridController.svelte';
import type { GridRow } from './types';

export type ImportAssistantStep = 1 | 2 | 3 | 4;

export interface ImportAssistantStateOptions extends Pick<RemoteOptions, 'headers' | 'fetch'> {
	/** Una corrida que ya existe (para volver a abrirla). Sin ella, se retoma la abierta de `origen` o se crea una al abrir (el chat la necesita desde el momento 0). */
	run?: string;
	/**
	 * La tabla desde donde se abre (`Planes GMF`): se guarda en la corrida y, al
	 * abrir, se retoma la corrida no terminada de esa persona en esa tabla.
	 */
	origen?: string;
	/** Cada cuánto se vuelve a leer la corrida mientras analiza o importa (ms). Default: 1 000. */
	pollMs?: number;
}

/** Un archivo que se está subiendo (o que no se pudo subir). */
export interface ImportUpload {
	id: number;
	nombre: string;
	carpeta: string | null;
	estado: 'subiendo' | 'error';
	error: string | null;
}

/** El Detalle de un archivo: sus filas, con los problemas por fila y campo. */
export type ImportDetail = ImportFileRows;

/**
 * El staging de un destino (§8.3): la `Sheet` **real** de la tabla destino
 * con los cambios de la corrida aplicados como pendientes.
 */
export interface ImportStagingView {
	destino: string;
	label: string;
	/** Lo que mandó el servidor (`GET /runs/:run/staging`). */
	set: ImportChangeSet;
	sheet: Sheet;
	/** Ya se aplicaron los cambios a la hoja (después de su primera carga). */
	applied: boolean;
	/** Llave del staging → clave de la fila en la hoja. */
	rows: Map<string, string>;
	/** Problemas cuya fila no está en la hoja (filas idénticas, avisos generales): se listan arriba. */
	general: ImportChangeSet['problemas'];
	/** Lo aplicado, para saber si la persona editó después. */
	signature: string;
	/** Los archivos que lo alimentaban al abrirlo (`stagingSignature`): si cambian, se vuelve a pedir. */
	files: string;
	/** Archivo → claves de las filas que salieron de él (por el `origen` de cada cambio). */
	origins: Map<string, string[]>;
	/** El archivo cuyas filas se resaltan («Ver en staging»), o `null`. */
	highlight: string | null;
}

/** Lo que pide confirmar «Importar» antes de guardar un replace con eliminaciones. */
export interface ImportDeleteConfirmation {
	destino: string;
	filas: string[];
	/** Lo que se estaba importando: esos destinos (el botón de su pestaña) o todo (`null`). */
	destinos: string[] | null;
}

/** Conteos de un staging, para su pestaña y el botón de importar. */
export interface ImportStagingCounts {
	insert: number;
	update: number;
	delete: number;
	errores: number;
}

/**
 * Una pestaña de destino (§10 de `05-asistente-importacion.md`): una tabla
 * destino con staging, con los archivos que la alimentan (filas de ese
 * formato o adjuntos a una de sus columnas).
 */
export interface ImportDestinationTab {
	destino: string;
	label: string;
	modo: 'upsert' | 'replace' | null;
	archivos: ImportRunFileView[];
	/** Sus archivos ya se importaron (la hoja se guardó con el staging). */
	importado: boolean;
	/** Lo que se guardó al importarlo. */
	publicado: { insert: number; update: number; delete: number } | null;
	/** Se está recalculando: archivos en análisis o importación, o su staging cargando. */
	trabajando: boolean;
	/** Conteos: de la hoja abierta (con lo que editó la persona) o de `GET /staging`; `null` sin calcular. */
	resumen: ImportStagingCounts | null;
}

/** Una opción del selector de destino: su valor en el `<select>` y el destino que representa. */
export interface ImportDestinationChoice {
	value: string;
	label: string;
	destino: ImportDestination;
}

/** El valor de un destino en el `<select>` (`''` = automático). */
export function destinationValue(d: ImportDestination | null): string {
	if (!d) return '';
	if (d.tipo === 'filas') return `filas:${d.formato}:${d.modo}`;
	if (d.tipo === 'adjuntar') return `adjuntar:${d.adjunto}`;
	return 'descartar';
}

const MODOS = { upsert: 'actualizar o agregar', replace: 'reemplazar todo' } as const;

/**
 * El estado del asistente de importación (SB-36), sin interfaz: la corrida en
 * el servidor, los archivos que se suben, los destinos, las instrucciones, el
 * chat y el Detalle de un archivo. `<ImportAssistant>` lo dibuja; una app
 * puede dibujarlo a su manera.
 *
 * - `url` es la base de `importAssistantRoutes`.
 * - Al abrir (`init`) crea la corrida si no hay: el chat existe desde el
 *   momento 0 y lo que la persona escriba antes de analizar son las
 *   instrucciones de la corrida (las guarda el servidor).
 * - El paso sale del estado de la corrida (nueva → 1, analizando/lista → 2,
 *   importando → 3, terminada → 4); `ir(paso)` deja volver a uno anterior.
 * - Mientras analiza o importa, la corrida se vuelve a leer cada `pollMs`; una
 *   app con socket puede llamar `refrescar()` cuando le avise el servidor.
 */
export class ImportAssistantState {
	config = $state<ImportAssistantConfig | null>(null);
	run = $state<ImportRunView | null>(null);
	uploads = $state<ImportUpload[]>([]);
	detail = $state<ImportDetail | null>(null);
	busy = $state<'init' | 'analyze' | 'import' | 'chat' | 'detail' | 'save' | null>(null);
	error = $state<string | null>(null);
	/** Al abrir se retomó una corrida que había quedado a medias (no se creó una nueva). */
	resumed = $state(false);
	/** La pestaña a la vista (§10): `'archivos'` o el formato de un destino (su staging). */
	tab = $state<string>('archivos');
	/** Los stagings abiertos, por destino: su hoja sigue viva al cambiar de pestaña. */
	stagings = $state.raw<Record<string, ImportStagingView>>({});
	/** Conteos de cada staging sin abrir (`GET /staging`), por destino, con la firma de sus archivos. */
	summaries = $state.raw<Record<string, { resumen: ImportStagingCounts; modo: 'upsert' | 'replace'; files: string }>>({});
	/** Destinos cuyo staging se está pidiendo (conteos o la hoja). */
	loadingStaging = $state<Record<string, boolean>>({});
	/** «Importar» espera que la persona confirme las eliminaciones de un replace. */
	confirmDeletes = $state<ImportDeleteConfirmation | null>(null);
	#editTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** El texto del agente mientras lo escribe (`GET /runs/:run/events`, evento `texto`), o `''`. */
	streaming = $state('');
	/** Qué hace el agente con cada archivo (evento `progreso`), por id de archivo (`*`: la corrida). */
	progress = $state<Record<string, string>>({});
	#events: { run: string; abort: AbortController } | null = null;
	/** Las hojas a las que se les están aplicando los cambios (una vez cada una). */
	#applying = new Set<Sheet>();
	/** El paso que la persona eligió ver (volver atrás); `null` = el del estado de la corrida. */
	#override = $state<ImportAssistantStep | null>(null);
	#timer: ReturnType<typeof setTimeout> | null = null;
	#uploadSeq = 0;
	#creating: Promise<ImportRunView> | null = null;
	#closed = false;

	constructor(
		readonly url: string,
		private options: ImportAssistantStateOptions = {}
	) {}

	// -- lectura ----------------------------------------------------------------------------

	async init(): Promise<void> {
		this.#closed = false;
		this.busy = 'init';
		this.error = null;
		try {
			this.config = await this.request<ImportAssistantConfig>('/config');
			if (this.options.run && !this.run) {
				this.run = await this.request<ImportRunView>(`/runs/${encodeURIComponent(this.options.run)}`);
				this.#poll();
			} else if (!this.run && (await this.#resume())) {
				this.#poll();
			} else await this.#ensureRun();
		} catch (err) {
			this.error = messageOf(err, 'No se pudo abrir el asistente');
		} finally {
			this.busy = null;
		}
	}

	/**
	 * Retoma la corrida no terminada más reciente de quien abre, en este origen
	 * (`GET /runs?origen=`): paso, archivos y chat donde se quedaron.
	 */
	async #resume(): Promise<boolean> {
		const query = this.options.origen ? `?origen=${encodeURIComponent(this.options.origen)}` : '';
		const runs = await this.request<ImportRunView[]>(`/runs${query}`).catch(() => [] as ImportRunView[]);
		const open = runs.filter((r) => r.estado !== 'terminada').sort((x, y) => y.actualizada.localeCompare(x.actualizada))[0];
		if (!open) return false;
		this.run = open;
		this.resumed = true;
		return true;
	}

	/** «Empezar de cero»: otra corrida vacía (la anterior queda en el servidor hasta vencer). */
	async startOver(): Promise<void> {
		this.reset();
		this.busy = 'init';
		try {
			await this.#ensureRun();
		} catch (err) {
			this.error = messageOf(err, 'No se pudo crear la corrida');
		} finally {
			this.busy = null;
		}
	}

	/**
	 * Empieza otra corrida (la anterior sigue en el servidor): la usa el
	 * asistente al soltar archivos cuando la que tenía ya se importó.
	 */
	reset(): void {
		this.#events?.abort.abort();
		this.#events = null;
		this.streaming = '';
		this.progress = {};
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		this.run = null;
		this.uploads = [];
		this.detail = null;
		this.stagings = {};
		this.summaries = {};
		this.tab = 'archivos';
		this.confirmDeletes = null;
		this.error = null;
		this.resumed = false;
		this.#override = null;
		this.options = { ...this.options, run: undefined };
	}

	/** La corrida ya no admite archivos (se importó o se está importando). */
	get closedRun(): boolean {
		return this.run?.estado === 'importando' || this.run?.estado === 'terminada';
	}

	/** Al volver a abrir la ventana: lee la corrida otra vez (o crea una, tras `reset`). */
	async reopen(): Promise<void> {
		this.#closed = false;
		if (!this.run || !this.config) await this.init();
		else await this.refrescar();
		this.#listen();
	}

	/** Deja de leer la corrida (al cerrar la ventana: el servidor sigue). */
	close(): void {
		this.#closed = true;
		this.#events?.abort.abort();
		this.#events = null;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
	}

	/** Vuelve a leer la corrida (la llama el sondeo, o la app cuando su socket avisa). */
	async refrescar(): Promise<void> {
		if (!this.run) return;
		try {
			this.#set(await this.request<ImportRunView>(`/runs/${this.run.id}`));
		} catch (err) {
			this.error = messageOf(err, 'No se pudo leer la corrida');
		}
	}

	#set(run: ImportRunView) {
		const before = this.run?.estado;
		this.run = run;
		// Al terminar de importar se muestra el resultado, aunque se hubiera vuelto atrás.
		if (before !== run.estado && (run.estado === 'terminada' || run.estado === 'importando')) this.#override = null;
		// Todo importado: el resultado está en la pestaña Archivos.
		if (before !== run.estado && run.estado === 'terminada') this.tab = 'archivos';
		this.#poll();
	}

	get working(): boolean {
		const r = this.run;
		return !!r && (r.estado === 'analizando' || r.estado === 'importando' || r.archivos.some((f) => ['en_cola', 'analizando', 'importando'].includes(f.estado)));
	}

	#poll() {
		this.#listen();
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		if (this.#closed || !this.working) return;
		this.#timer = setTimeout(() => void this.refrescar(), this.options.pollMs ?? 1000);
	}

	// -- pasos ------------------------------------------------------------------------------

	get stepFromRun(): ImportAssistantStep {
		switch (this.run?.estado) {
			case 'analizando':
			case 'lista':
				return 2;
			case 'importando':
				return 3;
			case 'terminada':
				return 4;
			default:
				return 1;
		}
	}

	get step(): ImportAssistantStep {
		return this.#override ?? this.stepFromRun;
	}

	/** Ver otro paso (los anteriores al de la corrida; o el de la corrida con `null`). */
	ir(step: ImportAssistantStep | null): void {
		this.detail = null;
		this.tab = 'archivos';
		this.#override = step === null || step === this.stepFromRun ? null : step;
	}

	get files(): ImportRunFileView[] {
		return this.run?.archivos ?? [];
	}

	/** Las opciones del selector de destino, de `GET /config`: un formato por modo. */
	get choices(): ImportDestinationChoice[] {
		const out: ImportDestinationChoice[] = [];
		for (const d of this.config?.destinos ?? []) {
			if (d.tipo === 'filas') {
				for (const modo of d.modos) {
					const destino: ImportDestination = { tipo: 'filas', formato: d.formato, modo };
					out.push({ value: destinationValue(destino), label: `Filas → ${d.label} · ${MODOS[modo]}`, destino });
				}
			} else if (d.tipo === 'adjuntar') {
				const destino: ImportDestination = { tipo: 'adjuntar', adjunto: d.adjunto };
				out.push({ value: destinationValue(destino), label: `Adjuntar → ${d.label}`, destino });
			} else out.push({ value: 'descartar', label: d.label, destino: { tipo: 'descartar' } });
		}
		return out;
	}

	/** Cómo se lee un destino en la tabla (con lo que el agente agregó: la fila a la que se adjunta). */
	describe(d: ImportDestination | null): string {
		if (!d) return 'Automático (lo decide el asistente)';
		const choice = this.choices.find((c) => c.value === destinationValue(d));
		if (d.tipo === 'adjuntar') {
			const extra = [d.tabla, d.fila, d.campo].filter(Boolean).join(' · ');
			return `${choice?.label ?? `Adjuntar → ${d.adjunto}`}${extra ? ` · ${extra}` : ''}`;
		}
		if (d.tipo === 'descartar') return `Descartar${d.motivo ? `: ${d.motivo}` : ''}`;
		return choice?.label ?? `Filas → ${d.formato}`;
	}

	get totalBytes(): number {
		return this.files.reduce((a, f) => a + f.tamano, 0);
	}

	/**
	 * Totales del resultado: filas publicadas, adjuntos y filas con error; y,
	 * si se guardó el staging en la hoja, sus altas, ediciones y bajas.
	 */
	get totals(): { filas: number; adjuntos: number; errores: number; archivosConError: number; staging: { insert: number; update: number; delete: number } | null } {
		const published = Object.values(this.run?.staging ?? {}).flatMap((s) => (s.publicado ? [s.publicado.resumen] : []));
		const staging = published.length
			? published.reduce((t, r) => ({ insert: t.insert + r.insert, update: t.update + r.update, delete: t.delete + r.delete }), { insert: 0, update: 0, delete: 0 })
			: null;
		let filas = 0;
		let adjuntos = 0;
		let errores = 0;
		let archivosConError = 0;
		for (const f of this.files) {
			const r = f.resultado;
			if (!r) continue;
			if (f.destino?.tipo === 'adjuntar' && r.status === 'ok') adjuntos += r.ok;
			else if (f.destino?.tipo === 'filas') filas += r.ok;
			errores += r.error;
			if (r.status !== 'ok') archivosConError++;
		}
		return { filas, adjuntos, errores, archivosConError, staging };
	}

	// -- archivos ---------------------------------------------------------------------------

	async #ensureRun(): Promise<ImportRunView> {
		if (this.run) return this.run;
		const body = JSON.stringify(this.options.origen ? { origen: this.options.origen } : {});
		this.#creating ??= this.request<ImportRunView>('/runs', { method: 'POST', body }).then((run) => {
			this.run = run;
			this.#listen();
			return run;
		});
		try {
			return await this.#creating;
		} finally {
			this.#creating = null;
		}
	}

	/** Lo soltado sobre la zona (archivos y carpetas). */
	async drop(data: DataTransfer): Promise<void> {
		await this.add(await filesFromDrop(data));
	}

	/** Lo elegido con el botón (con `webkitdirectory`, una carpeta). */
	async choose(list: FileList | File[]): Promise<void> {
		await this.add(filesFromInput(list));
	}

	/**
	 * Sube cada archivo en cuanto llega. Los zips se abren aquí (si no se puede,
	 * suben tal cual y los abre el servidor). Lo que pasa de los límites no se
	 * sube: queda en `uploads` con su error.
	 */
	async add(pending: PendingFile[]): Promise<void> {
		this.error = null;
		const limits = this.config?.limites;
		const maxFile = (limits?.maxArchivoMB ?? 50) * 1_048_576;
		const files = await expandZips(pending, (limits?.maxLoteMB ?? 200) * 1_048_576);
		const run = await this.#ensureRun().catch((err) => {
			this.error = messageOf(err, 'No se pudo crear la corrida');
			return null;
		});
		if (!run) return;
		for (const { file, carpeta } of files) {
			const upload: ImportUpload = { id: ++this.#uploadSeq, nombre: file.name, carpeta, estado: 'subiendo', error: null };
			this.uploads = [...this.uploads, upload];
			const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
			try {
				if (file.size > maxFile) throw new Error(`pasa de ${limits?.maxArchivoMB ?? 50} MB`);
				if (limits && !limits.tipos.includes(ext)) throw new Error('tipo no admitido');
				const added = await this.request<ImportRunFileView[]>(`/runs/${run.id}/files`, {
					method: 'POST',
					body: file,
					headers: {
						'content-type': 'application/octet-stream',
						'X-File-Name': encodeURIComponent(file.name),
						...(carpeta ? { 'X-Folder': encodeURIComponent(carpeta) } : {})
					}
				});
				this.uploads = this.uploads.filter((u) => u.id !== upload.id);
				if (this.run) this.run = { ...this.run, archivos: [...this.run.archivos.filter((f) => !added.some((a) => a.id === f.id)), ...added] };
			} catch (err) {
				this.uploads = this.uploads.map((u) => (u.id === upload.id ? { ...u, estado: 'error', error: messageOf(err, 'No se pudo subir') } : u));
			}
		}
		await this.refrescar();
	}

	dismissUpload(id: number): void {
		this.uploads = this.uploads.filter((u) => u.id !== id);
	}

	get uploading(): number {
		return this.uploads.filter((u) => u.estado === 'subiendo').length;
	}

	async remove(file: string): Promise<void> {
		await this.#mutate(() => this.request<ImportRunView>(`/runs/${this.run!.id}/files/${file}`, { method: 'DELETE' }), 'No se pudo quitar el archivo');
	}

	/** Fija el destino de un archivo (o, con `null`, deja que lo decida el asistente). */
	async setDestination(file: string, destino: ImportDestination | null): Promise<boolean> {
		return this.#mutate(
			() => this.request<ImportRunView>(`/runs/${this.run!.id}/files/${file}/destination`, { method: 'PUT', body: JSON.stringify({ destino }) }),
			'No se pudo fijar el destino'
		);
	}

	async setInstruction(file: string, instruccion: string): Promise<boolean> {
		return this.#mutate(
			() =>
				this.request<ImportRunView>(`/runs/${this.run!.id}/files/${file}/instruction`, {
					method: 'PUT',
					body: JSON.stringify({ instruccion: instruccion.trim() || null })
				}),
			'No se pudo guardar la instrucción'
		);
	}

	async #mutate(call: () => Promise<ImportRunView>, fallback: string): Promise<boolean> {
		if (!this.run) return false;
		this.error = null;
		try {
			this.#set(await call());
			return true;
		} catch (err) {
			this.error = messageOf(err, fallback);
			return false;
		}
	}

	// -- analizar, chat, importar -------------------------------------------------------------

	async analyze(): Promise<void> {
		if (!this.run) return;
		this.busy = 'analyze';
		try {
			if (await this.#mutate(() => this.request<ImportRunView>(`/runs/${this.run!.id}/analyze`, { method: 'POST', body: '{}' }), 'No se pudo analizar')) {
				this.#override = null;
			}
		} finally {
			this.busy = null;
		}
	}

	async send(texto: string): Promise<boolean> {
		if (!texto.trim()) return false;
		if (!this.run) {
			const run = await this.#ensureRun().catch((err) => {
				this.error = messageOf(err, 'No se pudo crear la corrida');
				return null;
			});
			if (!run) return false;
		}
		if (!this.run) return false;
		this.busy = 'chat';
		this.error = null;
		// Se ve de inmediato; la respuesta trae la corrida completa.
		const optimistic = { id: `local-${Date.now()}`, rol: 'usuario' as const, texto: texto.trim(), fecha: new Date().toISOString() };
		this.run = { ...this.run, chat: [...this.run.chat, optimistic] };
		try {
			const { corrida } = await this.request<ImportChatResponse>(`/runs/${this.run.id}/chat`, { method: 'POST', body: JSON.stringify({ texto }) });
			this.#set(corrida);
			return true;
		} catch (err) {
			this.error = messageOf(err, 'No se pudo enviar el mensaje');
			this.run = { ...this.run, chat: this.run.chat.filter((m) => m.id !== optimistic.id) };
			return false;
		} finally {
			this.busy = null;
		}
	}

	async import(): Promise<void> {
		if (!this.run) return;
		this.busy = 'import';
		try {
			if (await this.#mutate(() => this.request<ImportRunView>(`/runs/${this.run!.id}/import`, { method: 'POST' }), 'No se pudo importar')) {
				this.#override = null;
				this.detail = null;
			}
		} finally {
			this.busy = null;
		}
	}

	// -- detalle ----------------------------------------------------------------------------

	async openDetail(file: string): Promise<void> {
		if (!this.run) return;
		this.busy = 'detail';
		this.error = null;
		try {
			this.detail = await this.request<ImportFileRows>(`/runs/${this.run.id}/files/${file}/rows`);
		} catch (err) {
			this.error = messageOf(err, 'No se pudo leer el detalle');
		} finally {
			this.busy = null;
		}
	}

	/** Vuelve a leer el detalle abierto (cambió el archivo: lo analizó o lo editó el agente). */
	async reloadDetail(): Promise<void> {
		const detail = this.detail;
		if (!this.run || !detail) return;
		try {
			const fresh = await this.request<ImportFileRows>(`/runs/${this.run.id}/files/${detail.archivo.id}/rows`);
			if (this.detail?.archivo.id === fresh.archivo.id) this.detail = fresh;
		} catch {
			// El detalle sigue con lo que tenía; la siguiente lectura lo intenta otra vez.
		}
	}

	closeDetail(): void {
		this.detail = null;
	}

	/**
	 * Guardar correcciones: manda las filas de la hoja de staging (el servidor
	 * las revisa otra vez). Si el archivo ya se había intentado importar y ya
	 * no tienen errores, lo vuelve a importar («corregir y reintentar»). Tras un
	 * `upsert` parcial van solo las rechazadas (las otras ya se publicaron).
	 */
	async retry(filas: Record<string, CellValue>[]): Promise<boolean> {
		const detail = this.detail;
		if (!this.run || !detail) return false;
		const imported = !!detail.archivo.resultado;
		this.busy = 'save';
		this.error = null;
		try {
			const fixed = await this.request<ImportFileRows>(`/runs/${this.run.id}/files/${detail.archivo.id}/rows`, { method: 'PUT', body: JSON.stringify({ filas }) });
			this.detail = fixed;
			if (!imported || fixed.issues.some((i) => i.level === 'error')) {
				await this.refrescar();
				return false;
			}
			this.#set(await this.request<ImportRunView>(`/runs/${this.run.id}/import`, { method: 'POST' }));
			this.#override = null;
			this.detail = null;
			return true;
		} catch (err) {
			this.error = messageOf(err, 'No se pudo reintentar');
			return false;
		} finally {
			this.busy = null;
		}
	}

	// -- en vivo (fase B, §9): `GET /runs/:run/events` y «Detener» ---------------------------

	/**
	 * Escucha la corrida en vivo: el texto del chat por partes, el progreso de
	 * cada archivo y los cambios de la corrida (que se vuelve a leer). Va por
	 * `fetch` y no por `EventSource` para llevar las cabeceras (`Authorization`).
	 * Si se corta, se reconecta; un servidor sin la ruta solo deja el sondeo.
	 */
	#listen(): void {
		const run = this.run?.id;
		if (!run || this.#closed || this.#events?.run === run) return;
		this.#events?.abort.abort();
		const abort = new AbortController();
		this.#events = { run, abort };
		const doFetch = this.options.fetch ?? ((input: RequestInfo | URL, i?: RequestInit) => fetch(input, i));
		void (async () => {
			try {
				const res = await doFetch(`${this.url.replace(/\/+$/, '')}/runs/${run}/events`, { headers: { accept: 'text/event-stream', ...this.options.headers?.() }, signal: abort.signal });
				if (!res.ok || !res.body) return;
				const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
				let buffer = '';
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += value;
					let cut: number;
					while ((cut = buffer.indexOf('\n\n')) >= 0) {
						const chunk = buffer.slice(0, cut);
						buffer = buffer.slice(cut + 2);
						const data = chunk
							.split('\n')
							.filter((l) => l.startsWith('data:'))
							.map((l) => l.slice(5).trimStart())
							.join('\n');
						if (data) this.#onLive(JSON.parse(data));
					}
				}
			} catch {
				// Cortado (o sin la ruta): el sondeo sigue.
			}
			if (this.#events?.abort !== abort || abort.signal.aborted) return;
			this.#events = null;
			setTimeout(() => this.#listen(), 2000);
		})();
	}

	#onLive(e: { tipo: string; delta?: string; texto?: string; archivo?: string; nombre?: string; fase?: string; motivo?: string }): void {
		if (e.tipo === 'texto' && e.delta) this.streaming += e.delta;
		else if (e.tipo === 'texto_fin') this.streaming = '';
		else if (e.tipo === 'progreso' && e.texto) this.progress = { ...this.progress, [e.archivo ?? '*']: e.texto };
		else if (e.tipo === 'herramienta' && e.fase === 'inicio' && e.nombre) this.progress = { ...this.progress, [e.archivo ?? '*']: `usando ${e.nombre}…` };
		else if (e.tipo === 'detenido') {
			this.streaming = '';
			this.progress = {};
			void this.refrescar();
		} else if (e.tipo === 'corrida') {
			// Un archivo que dejó de trabajar ya no muestra su progreso (al volver a analizarlo, empieza de cero).
			const ev = (e as { evento?: { archivo?: string; estado?: string } }).evento;
			if (ev?.archivo && ev.estado !== 'analizando' && ev.estado !== 'importando' && this.progress[ev.archivo]) {
				const { [ev.archivo]: _, ...rest } = this.progress;
				this.progress = rest;
			}
			void this.refrescar();
		}
	}

	/** «Detener»: corta lo que está haciendo el agente en la corrida (`POST /runs/:run/stop`). */
	async stop(): Promise<boolean> {
		if (!this.run) return false;
		try {
			await this.request(`/runs/${this.run.id}/stop`, { method: 'POST', body: '{}' });
			this.streaming = '';
			this.progress = {};
			await this.refrescar();
			return true;
		} catch (err) {
			this.error = messageOf(err, 'No se pudo detener');
			return false;
		}
	}

	// -- staging (§8.3): la tabla destino con los cambios -------------------------------------

	/** Los destinos `filas` de `/config` (cada uno tiene su staging). */
	get stagingDestinations(): Extract<ImportAssistantConfig['destinos'][number], { tipo: 'filas' }>[] {
		return (this.config?.destinos ?? []).filter((d): d is Extract<ImportAssistantConfig['destinos'][number], { tipo: 'filas' }> => d.tipo === 'filas');
	}

	/** El staging que alimenta un archivo: el de su formato o el de la tabla a cuya columna va; `null` si ninguno. */
	stagingOf(file: ImportRunFileView | null): string | null {
		const d = file?.destino;
		if (d?.tipo === 'filas') return d.formato;
		if (d?.tipo === 'adjuntar') {
			const option = this.config?.destinos.find((o) => o.tipo === 'adjuntar' && o.adjunto === d.adjunto);
			if (option?.tipo === 'adjuntar' && option.columna) return option.columna.formato;
		}
		return null;
	}

	/** El staging donde se ve un archivo: el que alimenta o, si no alimenta ninguno, el primero. */
	stagingFor(file: ImportRunFileView | null): string | null {
		return this.stagingOf(file) ?? this.stagingDestinations[0]?.formato ?? null;
	}

	/** Los archivos que alimentan el staging de un destino (ya analizados: con filas, o que van a una de sus columnas). */
	stagingFiles(destino: string): ImportRunFileView[] {
		return this.files.filter((f) => this.stagingOf(f) === destino && f.estado !== 'pendiente' && (f.destino?.tipo !== 'filas' || f.totalFilas > 0 || !!f.resultado));
	}

	/** Huella de lo que alimenta un staging: si cambia (otro análisis, otro destino), su hoja se vuelve a pedir. */
	stagingSignature(destino: string): string {
		return JSON.stringify([
			this.stagingFiles(destino).map((f) => [f.id, f.estado, f.totalFilas, f.totalErrores, f.destino]),
			this.run?.staging?.[destino]?.publicado?.fecha ?? null
		]);
	}

	/**
	 * Las pestañas de destino (§10): una por tabla destino con staging, en
	 * cuanto un archivo analizado la alimenta. Con sus conteos (de la hoja
	 * abierta, con lo que editó la persona, o de `GET /staging`).
	 */
	get destinationTabs(): ImportDestinationTab[] {
		const out: ImportDestinationTab[] = [];
		const analyzing = this.files.some((f) => f.estado === 'en_cola' || f.estado === 'analizando');
		for (const d of this.stagingDestinations) {
			if (!d.sheetUrl) continue;
			const archivos = this.stagingFiles(d.formato);
			if (!archivos.length) continue;
			const publicado = this.run?.staging?.[d.formato]?.publicado ?? null;
			const importado = !!publicado && archivos.every((f) => f.estado === 'importado' || !!f.resultado);
			const view = this.stagings[d.formato];
			const grid = view?.applied ? view.sheet.grid : null;
			let resumen: ImportStagingCounts | null = null;
			if (grid) {
				grid.version;
				resumen = { insert: grid.createdCount, update: grid.buildChangeSet().updates.length, delete: grid.deletedCount, errores: grid.errorCount };
			} else {
				const known = this.summaries[d.formato];
				if (known) resumen = known.resumen;
			}
			out.push({
				destino: d.formato,
				label: d.label,
				modo: view?.set.modo ?? this.summaries[d.formato]?.modo ?? null,
				archivos,
				importado,
				publicado: publicado?.resumen ?? null,
				trabajando:
					!!this.loadingStaging[d.formato] ||
					(!!view && !view.applied) ||
					archivos.some((f) => f.estado === 'importando' || (f.estado === 'en_cola' && this.run?.estado === 'importando')) ||
					(analyzing && this.run?.estado !== 'importando'),
				resumen
			});
		}
		return out;
	}

	/** Los destinos con algo que guardar en su hoja (los de las pestañas que aún no se importan). */
	get stagingPending(): string[] {
		return this.destinationTabs.filter((t) => !t.importado).map((t) => t.destino);
	}

	/**
	 * Pide los conteos de los stagings sin hoja abierta (para sus pestañas y el
	 * botón «Importar todo»); solo los que cambiaron desde la última vez.
	 */
	async refreshSummaries(): Promise<void> {
		if (!this.run) return;
		const run = this.run.id;
		await Promise.all(
			this.destinationTabs
				.filter((t) => !t.importado && !this.stagings[t.destino] && !this.loadingStaging[t.destino] && this.summaries[t.destino]?.files !== this.stagingSignature(t.destino))
				.map(async (t) => {
					const files = this.stagingSignature(t.destino);
					this.loadingStaging = { ...this.loadingStaging, [t.destino]: true };
					try {
						const set = await this.request<ImportChangeSet>(`/runs/${run}/staging?destino=${encodeURIComponent(t.destino)}`);
						if (this.run?.id !== run) return;
						const r = set.resumen;
						this.summaries = { ...this.summaries, [t.destino]: { resumen: { insert: r.insert, update: r.update, delete: r.delete, errores: r.errores }, modo: set.modo, files } };
					} catch {
						// Sin conteos: la pestaña sigue, sin su insignia.
					} finally {
						this.loadingStaging = { ...this.loadingStaging, [t.destino]: false };
					}
				})
		);
	}

	/** El staging abierto en la pestaña a la vista (la tabla destino con los cambios), o `null` en Archivos. */
	get staging(): ImportStagingView | null {
		return this.tab === 'archivos' ? null : (this.stagings[this.tab] ?? null);
	}

	#putView(view: ImportStagingView): void {
		this.stagings = { ...this.stagings, [view.destino]: view };
	}

	/**
	 * Abre la pestaña del staging de un destino. La primera vez (o si sus
	 * archivos cambiaron) pide el `ImportChangeSet` y crea la `Sheet` de la
	 * tabla destino (sin borrador local); los cambios se le aplican cuando
	 * termina de cargar (`applyStaging`). Si la hoja ya estaba abierta, se
	 * conserva tal cual (con lo que la persona editó). Con `highlight` (un id
	 * de archivo), resalta las filas que salieron de ese archivo.
	 */
	async openStaging(destino: string, options: { highlight?: string | null; fresh?: boolean } = {}): Promise<boolean> {
		if (!this.run) return false;
		const option = this.stagingDestinations.find((d) => d.formato === destino);
		if (!option?.sheetUrl) {
			this.error = `El destino «${option?.label ?? destino}» no tiene hoja para ver el staging`;
			return false;
		}
		this.error = null;
		this.detail = null;
		const highlight = options.highlight === undefined ? (this.stagings[destino]?.highlight ?? null) : options.highlight;
		const cached = this.stagings[destino];
		if (cached && !options.fresh && cached.files === this.stagingSignature(destino)) {
			this.tab = destino;
			this.highlightFile(destino, highlight);
			return true;
		}
		this.#flushEdits(destino);
		this.busy = 'detail';
		this.loadingStaging = { ...this.loadingStaging, [destino]: true };
		try {
			const files = this.stagingSignature(destino);
			const set = await this.request<ImportChangeSet>(`/runs/${this.run.id}/staging?destino=${encodeURIComponent(destino)}`);
			const base = `${this.url.replace(/\/+$/, '')}/`;
			const sheetUrl = /^https?:\/\//.test(option.sheetUrl) ? option.sheetUrl : new URL(option.sheetUrl, new URL(base, globalThis.location?.href ?? 'http://localhost/')).href;
			const sheet = new Sheet(sheetUrl, { persist: 'none', headers: this.options.headers, fetch: this.options.fetch });
			this.#putView({ destino, label: option.label, set, sheet, applied: false, rows: new Map(), general: [], signature: '', files, origins: new Map(), highlight });
			this.tab = destino;
			return true;
		} catch (err) {
			this.error = messageOf(err, 'No se pudo leer el staging');
			return false;
		} finally {
			this.busy = null;
			this.loadingStaging = { ...this.loadingStaging, [destino]: false };
		}
	}

	/**
	 * Aplica los cambios del staging a su hoja ya cargada: `update` amarillo en
	 * las celdas que cambian, `insert` verde, `delete` tachado; los problemas,
	 * como avisos en la celda; y abre el panel de cambios.
	 */
	async applyStaging(destino: string = this.tab): Promise<void> {
		const view = this.stagings[destino];
		const grid = view?.sheet.grid;
		if (!view || !grid || view.applied || this.#applying.has(view.sheet)) return;
		this.#applying.add(view.sheet);
		const inserts = view.set.cambios.filter((c): c is Extract<ImportChange, { op: 'insert' }> => c.op === 'insert');
		const updates = view.set.cambios.flatMap((c) => (c.op === 'update' && c.id ? [{ id: c.id, values: Object.fromEntries(Object.entries(c.campos).map(([f, v]) => [f, v.despues])) }] : []));
		const deletes = view.set.cambios.flatMap((c) => (c.op === 'delete' && c.id ? [c.id] : []));
		const { inserted } = await grid.commands.stage({ updates, deletes, inserts: inserts.map((c) => c.valores) });
		const rows = new Map<string, string>();
		for (const c of view.set.cambios) if (c.op !== 'insert' && c.id && grid.getRow(c.id)) rows.set(c.key, c.id);
		inserts.forEach((c, i) => inserted[i] && rows.set(c.key, inserted[i]!));
		const marks = view.set.problemas.filter((p) => rows.has(p.key));
		grid.setExternalErrors(marks.map((p) => ({ rowKey: rows.get(p.key)!, field: p.campo ?? null, message: p.mensaje, level: p.nivel === 'error' ? 'error' : 'warning' })));
		const general = view.set.problemas.filter((p) => !rows.has(p.key));
		// De qué archivo salió cada fila (para «Ver en staging»).
		const origins = new Map<string, string[]>();
		for (const c of view.set.cambios) {
			const rowKey = rows.get(c.key);
			if (!rowKey) continue;
			const from = c.op === 'insert' ? c.origen.map((o) => o.archivo) : c.op === 'update' ? Object.values(c.campos).flatMap((x) => (x.origen ?? []).map((o) => o.archivo)) : [];
			for (const file of new Set(from)) origins.set(file, [...(origins.get(file) ?? []), rowKey]);
		}
		const applied = { ...view, applied: true, rows, general, origins };
		applied.signature = JSON.stringify(this.stagingChanges(applied));
		// Si mientras tanto se volvió a pedir este staging, este ya no se muestra.
		if (this.stagings[destino]?.sheet !== view.sheet) return;
		this.#putView(applied);
		if (grid.hasPendingChanges) grid.openChanges();
		if (applied.highlight) this.highlightFile(destino, applied.highlight);
	}

	/**
	 * Resalta en la hoja del staging las filas que salieron de un archivo y
	 * lleva la hoja a la primera (`null` quita el resaltado).
	 */
	highlightFile(destino: string, file: string | null): void {
		const view = this.stagings[destino];
		if (!view) return;
		if (view.highlight !== file) this.#putView({ ...view, highlight: file });
		const grid = view.sheet.grid;
		if (!view.applied || !grid) return;
		const keys = file ? (view.origins.get(file) ?? []) : [];
		grid.highlightRows(keys);
		if (keys[0]) void grid.commands.revealRow(keys[0]);
	}

	/** Cuántas filas resalta el staging de un destino y de qué archivo. */
	highlighted(destino: string): { file: ImportRunFileView | null; rows: number } | null {
		const view = this.stagings[destino];
		if (!view?.highlight) return null;
		return { file: this.files.find((f) => f.id === view.highlight) ?? null, rows: view.origins.get(view.highlight)?.length ?? 0 };
	}

	/** Lo que hoy tiene pendiente la hoja del staging, como cambios del contrato (§8.3). */
	stagingChanges(view: ImportStagingView | null = this.staging): ImportChange[] {
		const grid = view?.sheet.grid;
		if (!view || !grid) return [];
		const keyOf = new Map([...view.rows].map(([key, rowKey]) => [rowKey, key]));
		const original = new Map(view.set.cambios.map((c) => [c.key, c]));
		const fields = grid.columns.filter((c) => !c.readOnly && c.type !== 'action' && c.field !== grid.idField).map((c) => c.field);
		const cs = grid.buildChangeSet();
		const out: ImportChange[] = [];
		for (const row of grid.createdRows) {
			const key = keyOf.get(row.__key) ?? `nueva:${row.__key}`;
			const before = original.get(key);
			out.push({ op: 'insert', key, valores: Object.fromEntries(fields.map((f) => [f, row[f] ?? null])), origen: before?.op === 'insert' ? before.origen : [] });
		}
		for (const u of cs.updates) {
			const key = keyOf.get(u.key) ?? String(u.id);
			const before = original.get(key);
			const base = grid.baselineOf(u.key);
			const campos = Object.fromEntries(
				Object.entries(u.changes).map(([f, despues]) => [f, { antes: base?.[f] ?? null, despues, origen: before?.op === 'update' ? (before.campos[f]?.origen ?? []) : [] }])
			);
			out.push({ op: 'update', key, id: String(u.id), campos });
		}
		for (const d of cs.deletes) {
			const key = keyOf.get(d.key) ?? String(d.id);
			const before = original.get(key);
			out.push({ op: 'delete', key, id: String(d.id), motivo: before?.op === 'delete' ? before.motivo : 'La quitó la persona' });
		}
		return out;
	}

	/** La persona editó la hoja de un staging: sus cambios se guardan en la corrida (agrupados, 600 ms). */
	stagingEdited(destino: string = this.tab): void {
		const view = this.stagings[destino];
		if (!view?.applied || !this.run) return;
		const timer = this.#editTimers.get(destino);
		if (timer) clearTimeout(timer);
		this.#editTimers.set(
			destino,
			setTimeout(() => this.#flushEdits(destino), 600)
		);
	}

	/** Manda ya las ediciones pendientes de un staging (antes de volver a pedirlo o de guardarlo). */
	#flushEdits(destino: string): void {
		const timer = this.#editTimers.get(destino);
		if (timer) clearTimeout(timer);
		this.#editTimers.delete(destino);
		const view = this.stagings[destino];
		if (!view?.applied || !this.run) return;
		const cambios = this.stagingChanges(view);
		const signature = JSON.stringify(cambios);
		if (signature === view.signature) return;
		this.#putView({ ...view, signature });
		void this.request(`/runs/${this.run.id}/staging`, { method: 'PUT', body: JSON.stringify({ destino: view.destino, cambios }) }).catch(() => undefined);
	}

	/** Vuelve a la pestaña Archivos (las hojas de staging abiertas se conservan). */
	closeStaging(): void {
		this.tab = 'archivos';
		this.confirmDeletes = null;
	}

	/**
	 * «Importar» (§8.3 y §10): por cada destino con cambios —todos, o los de
	 * `destinos` (el botón de su pestaña)—, abre su staging si hace falta, pide
	 * confirmar las eliminaciones de un replace y **guarda la hoja** (el lote de
	 * siempre, con su validación y sus conflictos); luego `POST /import` marca
	 * la corrida (con `destinos`, solo esos: la corrida sigue abierta mientras
	 * falten otros) y procesa los destinos `adjuntar`. Los errores de guardado
	 * quedan en la celda y el agente los dice en el chat. `confirmed`: la
	 * persona ya aceptó las eliminaciones.
	 */
	async importStaging(confirmed = false, destinos: string[] | null = null): Promise<'ok' | 'confirm' | 'error' | 'open'> {
		if (!this.run) return 'error';
		const pending = this.stagingPending.filter((d) => !destinos || destinos.includes(d));
		if (!pending.length) {
			if (destinos) {
				this.error = 'No hay nada por importar en esta tabla';
				return 'error';
			}
			await this.import();
			return 'ok';
		}
		this.error = null;
		const published: { destino: string; resumen: { insert: number; update: number; delete: number } }[] = [];
		for (const destino of pending) {
			const known = this.stagings[destino];
			if (!known || known.files !== this.stagingSignature(destino) || !known.applied || !known.sheet.grid) {
				if (!known || known.files !== this.stagingSignature(destino)) {
					if (!(await this.openStaging(destino))) return 'error';
				} else this.tab = destino;
				// La hoja carga y se le aplican los cambios (lo hace el asistente al montarla); se sigue al terminar.
				return 'open';
			}
			const view = known;
			const grid = view.sheet.grid!;
			const errors = grid.errorCount;
			if (errors) {
				this.tab = destino;
				this.error = `El staging de ${view.label} tiene ${errors} ${errors === 1 ? 'celda' : 'celdas'} con error: corrígelas (o quita esas filas) antes de importar`;
				return 'error';
			}
			const deleted = this.stagingChanges(view).filter((c) => c.op === 'delete');
			if (view.set.modo === 'replace' && deleted.length && !confirmed) {
				this.tab = destino;
				this.confirmDeletes = { destino, filas: deleted.map((c) => rowLabel(grid, c.id ? grid.getRow(c.id) : undefined) || c.key), destinos };
				return 'confirm';
			}
			this.confirmDeletes = null;
			this.#flushEdits(destino);
			const resumen = { insert: grid.createdCount, update: grid.buildChangeSet().updates.length, delete: grid.deletedCount };
			this.busy = 'import';
			try {
				// El guardado de la hoja, sin su diálogo de resultado: lo que pasó se dice aquí y en el chat.
				const result = await grid.save();
				await grid.commands.sync();
				if (result.status === 'ok' && !result.summary.conflicts) {
					published.push({ destino, resumen });
					continue;
				}
				const message =
					result.status === 'error' ? result.message : result.status === 'invalid' ? 'Hay celdas inválidas' : result.status === 'ok' ? `${result.summary.conflicts} filas en conflicto: resuélvelas en el panel de cambios` : 'Nada que guardar';
				if (result.status === 'noop') {
					published.push({ destino, resumen });
					continue;
				}
				this.tab = destino;
				this.error = `No se pudo guardar ${view.label}: ${message}`;
				const problemas =
					result.status === 'error'
						? (result.problems ?? []).map((p) => ({ key: rowLabel(grid, grid.getRow(p.rowKey)), ...(p.field ? { campo: p.field } : {}), mensaje: p.message }))
						: [];
				// El agente lo dice en el chat (con los motivos por fila y campo).
				await this.request(`/runs/${this.run.id}/staging`, { method: 'PUT', body: JSON.stringify({ destino, error: { mensaje: message, problemas } }) }).catch(() => undefined);
				await this.refrescar();
				grid.openChanges();
				return 'error';
			} finally {
				this.busy = null;
			}
		}
		this.busy = 'import';
		try {
			const ok = await this.#mutate(
				() => this.request<ImportRunView>(`/runs/${this.run!.id}/import`, { method: 'POST', body: JSON.stringify({ staging: published, ...(destinos ? { destinos } : {}) }) }),
				'No se pudo importar'
			);
			if (!ok) return 'error';
			this.#override = null;
			// Las hojas guardadas ya no tienen cambios: su pestaña se vuelve a pedir limpia.
			const rest = { ...this.stagings };
			for (const p of published) delete rest[p.destino];
			this.stagings = rest;
			if (!destinos) this.tab = 'archivos';
			this.detail = null;
			return 'ok';
		} finally {
			this.busy = null;
		}
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const doFetch = this.options.fetch ?? ((input: RequestInfo | URL, i?: RequestInit) => fetch(input, i));
		const res = await doFetch(`${this.url.replace(/\/+$/, '')}${path}`, {
			...init,
			headers: { 'content-type': 'application/json', ...this.options.headers?.(), ...(init.headers as Record<string, string> | undefined) }
		});
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			const error = body?.error ?? {};
			throw new SpreadBaseApiError(res.status, error.code ?? 'http_error', error.message ?? `HTTP ${res.status}`, error.details);
		}
		return body as T;
	}
}

function messageOf(err: unknown, fallback: string): string {
	return err instanceof Error && err.message ? err.message : fallback;
}

/** Cómo se nombra una fila en una lista («ONIX 2026 · A · LS · CONTADO»): sus primeros textos. */
function rowLabel(grid: GridController, row: GridRow | undefined): string {
	if (!row) return '';
	return grid.columns
		.filter((c) => c.type === 'text' && c.field !== grid.idField && !c.hidden)
		.map((c) => row[c.field])
		.filter((v) => v !== null && v !== undefined && v !== '')
		.slice(0, 4)
		.join(' · ');
}
