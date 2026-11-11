/**
 * El agente importador (SB-36): convierte cada archivo de una corrida en filas
 * de un formato SB-34, lo adjunta donde diga la app o lo descarta; la persona
 * revisa, corrige o conversa, y lo importa en segundo plano.
 *
 * - **Analizar** (por archivo, en la cola): con `llm.chat`, un bucle con tools
 *   —extraer (P y X), comparar, mapear al formato, revisar, corregir, terminar—
 *   hasta `maxIteraciones`. Sin `chat`, con reglas: P, la tabla que más
 *   columnas del formato reconoce, mapeo por encabezados y `review`.
 * - **Chat** (por corrida): la persona escribe; el agente responde y puede
 *   volver a trabajar cualquier archivo con las mismas tools.
 * - **Importar** (por archivo, en la cola): `apply` del formato —`replace` se
 *   bloquea con cualquier error; `upsert` publica las filas buenas y deja las
 *   malas con su error— o `attach` de la app.
 *
 * La corrida vive en el `ImportRunStore` de la app; los cambios se guardan
 * con control de versión (dos trabajos a la vez no se pisan).
 */
import { randomUUID } from 'node:crypto';
import { fold } from '@spreadbase/core';
import type {
	CellValue,
	ImportAssistantConfig,
	ImportChatMessage,
	ImportChatResponse,
	ImportDestination,
	ImportDestinationOption,
	ImportFileResult,
	ImportFileRows,
	ImportIssue,
	ImportLimits,
	ImportPayload,
	ImportRun,
	ImportRunEvent,
	ImportRunFile,
	ImportRunFileView,
	ImportRunView
} from '@spreadbase/core';
import { NotFoundError, SpreadBaseError, ValidationError } from '../errors.ts';
import type { ImportFormat } from '../imports.ts';
import { SpreadBase } from '../SpreadBase.ts';
import { compararExtracciones } from '../extraction/compare.ts';
import { extraerDeterminista } from '../extraction/deterministic.ts';
import { extraerConLLM, textoDePagina } from '../extraction/llm.ts';
import type { LLMMensaje, LLMParte, LLMTool } from '../extraction/llm.ts';
import { renderizarPdf } from '../extraction/pdf.ts';
import type { Extraccion } from '../extraction/types.ts';
import { docxText, extensionOf, fileType, isZip, unzip } from './files.ts';
import { coerceCell, mapearBloques, puntaje } from './mapping.ts';
import type { Mapeo, MapeoOpciones } from './mapping.ts';
import { inProcessRunner } from './store.ts';
import { baseTools, resumenExtraccion } from './tools.ts';
import type { EditarArgs, Kernel } from './tools.ts';
import type { ImportAgentDestination, ImportAgentOptions, ImportJob, ImportRunner, ImportTool, ImportToolContext } from './types.ts';
import type { ImportBrainEvent, ImportBrainHost, ImportLiveEvent } from './brain/types.ts';
import { describirStaging, llavePorOmision } from './brain/staging.ts';
import { stagingDeCorrida } from './stagingCorrida.ts';

const MB = 1_048_576;

/** El progreso de cada tool del bucle, como se lee en la columna Estado. */
const PASOS: Record<string, string> = {
	leerDestino: 'leyendo el destino…',
	extraerDeterminista: 'leyendo el documento…',
	extraerConLLM: 'leyendo con visión…',
	compararExtracciones: 'comparando lecturas…',
	verBloque: 'leyendo una tabla…',
	mapearTabla: 'mapeando columnas…',
	proponerFilas: 'proponiendo filas…',
	editarFilas: 'corrigiendo filas…',
	revisar: 'revisando filas…',
	leerFilasActuales: 'leyendo la tabla actual…',
	crearDerivado: 'escribiendo la ficha…',
	terminar: 'cerrando el análisis…'
};

export const DEFAULT_LIMITS: ImportLimits = {
	maxArchivoMB: 50,
	maxLoteMB: 200,
	retencionDias: 30,
	tipos: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'heic', 'xlsx', 'csv', 'txt', 'json', 'md', 'docx', 'zip']
};

/** Las instrucciones base del agente; la app suma las suyas (`prompt`). */
export const PROMPT_BASE = `Eres el agente importador. Conviertes archivos (PDF, fotos, Excel, texto…) en filas de un formato de importación, los adjuntas donde corresponde o los descartas diciendo por qué.

Cómo trabajar un archivo:
1. Léelo. CSV, Excel o texto: extraerDeterminista. PDF con texto: extraerDeterminista y, en las páginas con tablas, extraerConLLM y compararExtracciones (la capa de texto puede traer artefactos). Foto o escaneo: extraerConLLM. PDF grande: usa el índice y pide solo las páginas que sirven.
2. Elige el destino. Si la persona fijó el destino de un archivo, respétalo siempre.
3. Para un formato: leerDestino, mapearTabla, proponerFilas, revisar; corrige (editarFilas, o mapearTabla con columnas y fijos) y vuelve a revisar hasta que no haya errores o ya no puedas mejorar.
4. Cierra con terminar: una línea concreta para la persona (cuántas filas, de qué, qué quedó fuera).

Reglas: no inventes datos (lo que el archivo no dice queda vacío); sigue las instrucciones de la persona; responde en español, breve.`;

/** El resultado de una tool, acotado: el modelo no necesita miles de filas. */
function acotar(value: unknown): unknown {
	const json = JSON.stringify(value ?? null);
	return json.length <= 30_000 ? value : { recortado: true, json: `${json.slice(0, 30_000)}…` };
}

const now = () => new Date().toISOString();

export class ImportAgent {
	private readonly limits: ImportLimits;
	private readonly runner: ImportRunner;
	private readonly formats = new Map<string, { def: Extract<ImportAgentDestination, { tipo: 'filas' }>; format: ImportFormat }>();
	private readonly attachments = new Map<string, Extract<ImportAgentDestination, { tipo: 'adjuntar' }>>();
	private readonly discard: boolean;
	/** Lo que se extrajo y mapeó de cada archivo: memoria de trabajo del proceso (se rehace si falta). */
	private readonly memo = new Map<string, { P?: Extraccion; X?: Extraccion; mapeo?: Mapeo & { formato: string } }>();
	/** Cerebro (fase B): quién escucha cada corrida en vivo (SSE) y el «Detener» de cada una. */
	private readonly vivos = new Map<string, Set<(e: ImportLiveEvent) => void>>();
	private readonly aborts = new Map<string, AbortController>();

	constructor(private readonly options: ImportAgentOptions) {
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
		for (const d of options.destinations) {
			if (d.tipo === 'filas') this.formats.set(d.formato.id, { def: d, format: d.formato });
			else if (d.tipo === 'adjuntar') this.attachments.set(d.id, d);
		}
		this.discard = options.destinations.some((d) => d.tipo === 'descartar');
		this.runner = options.runner ?? inProcessRunner();
		this.runner.iniciar?.((job) => this.procesar(job));
	}

	// -- configuración ----------------------------------------------------------------------

	config(): ImportAssistantConfig {
		const destinos: ImportDestinationOption[] = this.options.destinations.map((d) => {
			if (d.tipo === 'filas') {
				const schema = d.formato.schema();
				const modos = d.modos ?? ['upsert', 'replace'];
				return { tipo: 'filas', formato: schema.id, label: schema.label, description: schema.description ?? null, modos, modo: d.modo ?? modos[0]!, ...(d.sheetUrl ? { sheetUrl: d.sheetUrl } : {}) };
			}
			if (d.tipo === 'adjuntar') {
				const columna = d.columna ? { columna: { formato: d.columna.formato, campo: d.columna.campo } } : {};
				return { tipo: 'adjuntar', adjunto: d.id, label: d.label, description: d.description ?? null, ...columna };
			}
			return { tipo: 'descartar', label: d.label ?? 'Descartar' };
		});
		const custom = this.options.bienvenida;
		const bienvenida = typeof custom === 'function' ? custom(destinos) : (custom ?? bienvenidaBase(destinos));
		return { destinos, limites: this.limits, bienvenida };
	}

	/** Hay un cerebro enchufado (`importAgent({ brain })`): los eventos sin espera le llegan. */
	get conCerebro(): boolean {
		return Boolean(this.options.brain);
	}

	/** Cuánto se agrupan las ediciones del staging antes de avisarle al cerebro (`esperaEdicionMs`). */
	get esperaEdicionMs(): number {
		return this.options.esperaEdicionMs ?? 2000;
	}

	/** La cola: la de la app o la de omisión (sus pruebas esperan con `vacia()`). */
	get cola(): ImportRunner {
		return this.runner;
	}

	/** Los destinos como los declaró la app (el staging, `./staging.ts`, lee su llave, hoja y columnas). */
	get destinos(): readonly ImportAgentDestination[] {
		return this.options.destinations;
	}

	/** Cambia la corrida con control de versión (para `./staging.ts`). */
	cambiarCorrida(id: string, change: (run: ImportRun) => void): Promise<ImportRun> {
		return this.mutar(id, change);
	}

	// -- corrida ----------------------------------------------------------------------------

	async crearCorrida(input: { instrucciones?: string; contexto?: Record<string, unknown> }, ctx: Record<string, unknown> = {}): Promise<ImportRun> {
		const created = now();
		const run: ImportRun = {
			id: randomUUID(),
			contexto: input.contexto ?? ctx,
			propietario: this.options.owner?.(ctx) ?? null,
			instrucciones: input.instrucciones ?? '',
			archivos: [],
			chat: [],
			estado: 'nueva',
			version: 1,
			creada: created,
			actualizada: created,
			expira: new Date(Date.now() + this.limits.retencionDias * 86_400_000).toISOString()
		};
		await this.options.runs.crear(run);
		return run;
	}

	/**
	 * La corrida, si es de quien pide (`owner`). `ctx = null`: lectura interna (el cerebro, el staging que
	 * él consulta), sin revisar el dueño: el host ya está atado a esa corrida.
	 */
	async obtener(id: string, ctx: Record<string, unknown> | null = {}): Promise<ImportRun> {
		const run = await this.options.runs.obtener(id);
		const owner = ctx === null ? null : (this.options.owner?.(ctx) ?? null);
		if (!run || (ctx !== null && this.options.owner && run.propietario !== owner)) throw new NotFoundError(`No existe la corrida ${id}`);
		return run;
	}

	async listar(ctx: Record<string, unknown> = {}, limite = 50): Promise<ImportRunView[]> {
		const runs = await this.options.runs.listar({ propietario: this.options.owner ? (this.options.owner(ctx) ?? null) : undefined, limite });
		return runs.map(vista);
	}

	async cambiarInstrucciones(id: string, instrucciones: string, ctx: Record<string, unknown> = {}): Promise<ImportRun> {
		await this.obtener(id, ctx);
		return this.mutar(id, (run) => {
			run.instrucciones = instrucciones;
		});
	}

	/**
	 * Agrega un archivo. Un zip se abre aquí (respaldo de lo que hace el
	 * navegador): cada archivo de adentro es uno de la corrida, con su ruta en
	 * `carpeta`. Revisa tipo, tamaño y el total de la corrida.
	 */
	async agregarArchivo(id: string, input: { bytes: Uint8Array; nombre: string; carpeta?: string | null }, ctx: Record<string, unknown> = {}): Promise<ImportRunFile[]> {
		const run = await this.obtener(id, ctx);
		if (run.estado === 'importando' || run.estado === 'terminada') throw new SpreadBaseError(409, 'run_closed', 'La corrida ya se importó: crea otra');
		const entries = this.aceptar(input.bytes, input.nombre, input.carpeta ?? null);
		const total = run.archivos.reduce((a, f) => a + f.tamano, 0) + entries.reduce((a, e) => a + e.bytes.length, 0);
		if (total > this.limits.maxLoteMB * MB) {
			throw new SpreadBaseError(413, 'batch_too_large', `La corrida pasaría de ${this.limits.maxLoteMB} MB`);
		}
		const files: ImportRunFile[] = [];
		for (const e of entries) {
			// En el almacenamiento, un nombre limpio (sin rutas ni signos); a la persona se le muestra el original.
			const url = await this.options.storage.save({ bytes: e.bytes, type: e.tipo, name: storageName(e.nombre) }, run.contexto);
			files.push({
				id: randomUUID(),
				nombre: e.nombre,
				tipo: e.tipo,
				carpeta: e.carpeta,
				url,
				tamano: e.bytes.length,
				estado: 'pendiente',
				analisis: null,
				destino: null,
				destinoFijadoPorUsuario: false,
				instruccion: null,
				filas: [],
				campos: {},
				issues: [],
				resumen: null,
				derivados: [],
				resultado: null,
				error: null
			});
		}
		await this.mutar(id, (r) => {
			r.archivos.push(...files);
			if (r.estado === 'lista') r.estado = 'nueva';
		});
		this.avisarCerebro(id, { tipo: 'archivos_subidos', archivos: files.map((f) => f.id) });
		return files;
	}

	/** Tipo, tamaño y, si es zip, sus archivos. */
	private aceptar(bytes: Uint8Array, nombre: string, carpeta: string | null): { bytes: Uint8Array; nombre: string; tipo: string; carpeta: string | null }[] {
		const ext = extensionOf(nombre);
		const max = this.limits.maxArchivoMB * MB;
		if (bytes.length > max) throw new SpreadBaseError(413, 'file_too_large', `«${nombre}» pasa de ${this.limits.maxArchivoMB} MB`);
		if (!bytes.length) throw new ValidationError(`«${nombre}» está vacío`);
		const tipo = fileType(bytes, nombre);
		if (!tipo || !this.limits.tipos.includes(ext)) {
			throw new SpreadBaseError(415, 'unsupported_type', `«${nombre}»: tipo no admitido (${this.limits.tipos.join(', ')})`);
		}
		if (!isZip(tipo)) return [{ bytes, nombre: nombre.split(/[\\/]/).pop() || nombre, tipo, carpeta }];
		const base = [carpeta, nombre.replace(/\.zip$/i, '')].filter(Boolean).join('/');
		const out: { bytes: Uint8Array; nombre: string; tipo: string; carpeta: string | null }[] = [];
		for (const entry of unzip(bytes, this.limits.maxLoteMB * MB)) {
			const parts = entry.path.split('/');
			const name = parts.pop()!;
			const folder = [base, ...parts].filter(Boolean).join('/');
			// Lo de adentro pasa por las mismas reglas (un zip dentro de otro también se abre).
			try {
				out.push(...this.aceptar(entry.bytes, name, folder));
			} catch {
				// Un archivo de adentro que no se admite no tumba el zip entero: se omite.
			}
		}
		if (!out.length) throw new ValidationError(`«${nombre}» no trae archivos que se puedan importar`);
		return out;
	}

	async quitarArchivo(id: string, archivo: string, ctx: Record<string, unknown> = {}): Promise<ImportRun> {
		const run = await this.obtener(id, ctx);
		const file = archivoDe(run, archivo);
		if (file.estado === 'importando' || file.estado === 'importado') throw new SpreadBaseError(409, 'file_imported', 'El archivo ya se importó');
		await this.options.storage.remove?.(file.url, run.contexto).catch(() => undefined);
		this.memo.delete(`${id}:${file.id}`);
		return this.mutar(id, (r) => {
			r.archivos = r.archivos.filter((f) => f.id !== file.id);
		});
	}

	/** La persona fija (o, con `null`, suelta) el destino de un archivo: el agente no lo cambia. */
	async fijarDestino(id: string, archivo: string, destino: ImportDestination | null, ctx: Record<string, unknown> = {}): Promise<ImportRun> {
		const run = await this.obtener(id, ctx);
		const file = archivoDe(run, archivo);
		if (destino) this.validarDestino(destino);
		const formatOf = (d: ImportDestination | null) => (d?.tipo === 'filas' ? d.formato : null);
		return this.mutar(id, (r) => {
			const f = archivoDe(r, file.id);
			// Otro formato (u otro tipo de destino): lo propuesto para el anterior ya no vale.
			if (destino && formatOf(f.destino) !== formatOf(destino)) {
				f.filas = [];
				f.issues = [];
				f.resumen = null;
			}
			f.destino = destino;
			f.destinoFijadoPorUsuario = destino !== null;
		});
	}

	/** La instrucción de la persona para un archivo (o `null` para quitarla): el agente la toma al analizarlo. */
	async fijarInstruccion(id: string, archivo: string, instruccion: string | null, ctx: Record<string, unknown> = {}): Promise<ImportRun> {
		const run = await this.obtener(id, ctx);
		const file = archivoDe(run, archivo);
		const text = instruccion?.trim() ? instruccion.trim().slice(0, 2000) : null;
		return this.mutar(id, (r) => {
			archivoDe(r, file.id).instruccion = text;
		});
	}

	/**
	 * La persona corrige las filas (en la hoja de Detalle): se vuelven a revisar.
	 * Si el archivo ya se había importado (o falló), vuelve a quedar listo para
	 * importar: «Corregir y reintentar».
	 */
	async editarFilas(id: string, archivo: string, filas: Record<string, CellValue>[], ctx: Record<string, unknown> = {}): Promise<ImportFileRows> {
		const run = await this.obtener(id, ctx);
		const file = archivoDe(run, archivo);
		if (file.destino?.tipo !== 'filas') throw new ValidationError('El archivo no va a un formato');
		const format = this.formato(file.destino.formato);
		const columns = format.schema().columns;
		const clean = filas.map((row) => Object.fromEntries(Object.entries(columns).filter(([, c]) => c.from !== 'form').map(([f, c]) => [f, coerceCell(row[f], c)])));
		await this.mutar(id, (r) => {
			const f = archivoDe(r, file.id);
			f.filas = clean;
			if (f.estado === 'importado' || f.estado === 'error') {
				f.estado = 'analizado';
				f.resultado = null;
				f.error = null;
				if (r.estado === 'terminada') r.estado = 'lista';
			}
		});
		const review = await this.revisarArchivo(id, file.id);
		const errores = review.issues.filter((i) => i.level === 'error').length;
		this.avisarCerebro(id, { tipo: 'staging_editado', archivo: file.id, destino: format.schema().id, resumen: `La persona guardó ${clean.length} filas de «${file.nombre}»; el review deja ${errores} errores.` });
		return this.filas(id, file.id, ctx);
	}

	async filas(id: string, archivo: string, ctx: Record<string, unknown> = {}): Promise<ImportFileRows> {
		const run = await this.obtener(id, ctx);
		const file = archivoDe(run, archivo);
		const schema = file.destino?.tipo === 'filas' && this.formats.has(file.destino.formato) ? this.formato(file.destino.formato).schema() : null;
		return { archivo: vistaArchivo(file), schema, filas: file.filas, issues: file.issues, resumen: file.resumen };
	}

	// -- analizar ---------------------------------------------------------------------------

	/** Encola el análisis de los archivos (todos los que no se importaron, o los nombrados). */
	async analizar(id: string, input: { archivos?: string[] } = {}, ctx: Record<string, unknown> = {}): Promise<ImportRun> {
		const run = await this.obtener(id, ctx);
		const wanted = input.archivos?.length ? input.archivos.map((a) => archivoDe(run, a).id) : run.archivos.map((f) => f.id);
		const ids = wanted.filter((fid) => {
			const f = archivoDe(run, fid);
			return f.estado !== 'importando' && f.estado !== 'importado' && f.estado !== 'en_cola' && f.estado !== 'analizando';
		});
		if (!run.archivos.length) throw new ValidationError('La corrida no tiene archivos');
		const updated = await this.mutar(id, (r) => {
			for (const fid of ids) {
				const f = archivoDe(r, fid);
				f.estado = 'en_cola';
				f.error = null;
			}
			if (ids.length) r.estado = 'analizando';
		});
		for (const fid of ids) await this.runner.encolar({ tipo: 'analizar', corrida: id, archivo: fid });
		this.emit({ corrida: id, tipo: 'corrida', estado: updated.estado });
		return updated;
	}

	/** Lo llama la cola por cada trabajo (la de omisión, o el worker de la app). */
	async procesar(job: ImportJob): Promise<void> {
		if (job.tipo === 'analizar') await this.analizarArchivo(job.corrida, job.archivo);
		else await this.importarArchivo(job.corrida, job.archivo);
	}

	private async analizarArchivo(id: string, fid: string): Promise<void> {
		await this.mutar(id, (r) => {
			const f = archivoDe(r, fid);
			f.estado = 'analizando';
			// Un análisis nuevo empieza de cero; el destino que fijó la persona se queda.
			f.analisis = null;
			f.filas = [];
			f.issues = [];
			f.resumen = null;
			f.derivados = [];
			if (!f.destinoFijadoPorUsuario) f.destino = null;
		});
		this.emit({ corrida: id, tipo: 'archivo', archivo: fid, estado: 'analizando' });
		this.progreso(id, fid, 'empezando…');
		try {
			if (this.options.brain) await this.options.brain.manejar({ tipo: 'analizar', archivo: fid }, this.host(id));
			else await this.analizarBasico(id, fid);
			const run = await this.options.runs.obtener(id);
			const file = run && archivoDe(run, fid);
			if (file?.destino?.tipo === 'filas' && file.filas.length) {
				this.progreso(id, fid, `Revisando ${file.filas.length} filas`);
				await this.revisarArchivo(id, fid);
			}
			const done = await this.mutar(id, (r) => {
				const f = archivoDe(r, fid);
				f.estado = 'analizado';
				f.analisis ??= resumenArchivo(f);
			});
			const f = archivoDe(done, fid);
			this.emit({ corrida: id, tipo: 'archivo', archivo: fid, estado: 'analizado', mensaje: f.analisis ?? undefined });
			await this.decir(id, this.veredictoAnalisis(f));
		} catch (error) {
			const failed = await this.mutar(id, (r) => {
				const f = archivoDe(r, fid);
				f.estado = 'error';
				f.error = (error as Error).message;
			});
			this.emit({ corrida: id, tipo: 'archivo', archivo: fid, estado: 'error', mensaje: (error as Error).message });
			await this.decir(id, this.veredictoAnalisis(archivoDe(failed, fid)));
		}
		await this.cerrarFase(id);
	}

	/** Sin LLM con tools: P, la tabla que más columnas reconoce de algún formato, mapeo y review. */
	private async porReglas(id: string, fid: string): Promise<void> {
		const run = await this.options.runs.obtener(id);
		if (!run) return;
		const file = archivoDe(run, fid);
		const ctx = this.toolContext(run, file);
		const conX = file.tipo.startsWith('image/') && Boolean(this.options.llm);
		this.progreso(id, fid, conX ? `Leyendo con visión «${file.nombre}»` : `Leyendo «${file.nombre}»`);
		await (conX ? this.extraerX(ctx, file) : this.extraerP(ctx, file));
		const e = this.memo.get(this.key(file))![conX ? 'X' : 'P']!;
		const tables = e.bloques.map((b, i) => ({ b, i })).filter(({ b }) => b.tipo === 'tabla');
		const fixed = file.destinoFijadoPorUsuario ? file.destino : null;
		const candidates = fixed ? (fixed.tipo === 'filas' ? [fixed.formato] : []) : [...this.formats.keys()];
		let best: { formato: string; score: number } | null = null;
		for (const formato of candidates) {
			const schema = this.formato(formato).schema();
			const score = Math.max(0, ...tables.map(({ b }) => puntaje(b, schema)));
			if (!best || score > best.score) best = { formato, score };
		}
		if (fixed && fixed.tipo !== 'filas') {
			await this.terminar(ctx, file, fixed.tipo === 'descartar' ? `Descartado: ${fixed.motivo ?? 'lo pidió la persona'}` : 'Se adjunta tal cual');
			return;
		}
		if (!best || best.score < 2) {
			await this.terminar(ctx, file, fixed ? 'No se encontró una tabla con las columnas del formato' : 'No se reconoció ninguna tabla de los formatos: elige un destino');
			return;
		}
		const schema = this.formato(best.formato).schema();
		const blocks = tables.filter(({ b }) => puntaje(b, schema) >= Math.max(2, best.score - 1)).map(({ i }) => i);
		this.progreso(id, fid, `Mapeando ${blocks.length} ${blocks.length === 1 ? 'tabla' : 'tablas'} a ${schema.label}`);
		this.mapear(file, best.formato, conX ? 'X' : 'P', blocks, {});
		await this.proponer(ctx, file, { formato: best.formato });
		const pages = [...new Set(blocks.map((i) => e.bloques[i]!.pagina))];
		const count = (await this.options.runs.obtener(id))?.archivos.find((f) => f.id === fid)?.filas.length ?? 0;
		await this.terminar(ctx, file, `${count} filas para ${schema.label} (${pages.length > 1 ? `págs. ${pages.join(', ')}` : `pág. ${pages[0]}`})`);
	}

	// -- el bucle del modelo ----------------------------------------------------------------

	private tools(conAnalizar: boolean): ImportTool[] {
		const base = baseTools(this.kernel(), { conX: Boolean(this.options.llm) });
		const extra: ImportTool[] = conAnalizar
			? [
					{
						nombre: 'analizar',
						descripcion: 'Vuelve a analizar un archivo desde cero (con las instrucciones y el destino actuales).',
						parametros: { type: 'object', properties: { archivo: { type: 'string' } }, required: ['archivo'] },
						ejecutar: async (args, ctx) => {
							const file = archivoDe(ctx.corrida, String(args.archivo));
							await this.bucle(ctx.corrida.id, { archivo: file.id });
							if ((await this.options.runs.obtener(ctx.corrida.id))?.archivos.find((f) => f.id === file.id)?.destino?.tipo === 'filas') {
								await this.revisarArchivo(ctx.corrida.id, file.id);
							}
							const after = await this.options.runs.obtener(ctx.corrida.id);
							return after ? vistaArchivo(archivoDe(after, file.id)) : null;
						}
					}
				]
			: [];
		return [...base, ...extra, ...(this.options.tools ?? [])];
	}

	private async sistema(run: ImportRun, chat: boolean): Promise<string> {
		const destinos = this.config()
			.destinos.map((d) =>
				d.tipo === 'filas'
					? `- filas → formato «${d.formato}» (${d.label})${d.description ? `: ${d.description}` : ''}. Modos: ${d.modos.join(', ')} (por omisión ${d.modo}).`
					: d.tipo === 'adjuntar'
						? `- adjuntar → «${d.adjunto}» (${d.label})${d.description ? `: ${d.description}` : ''}`
						: `- descartar`
			)
			.join('\n');
		const parts = [PROMPT_BASE, this.options.prompt, `Destinos posibles:\n${destinos}`];
		const extra = await this.options.context?.(run);
		if (extra) parts.push(`Contexto:\n${extra}`);
		if (run.instrucciones.trim()) parts.push(`Instrucciones de la persona para esta corrida:\n${run.instrucciones.trim()}`);
		if (chat && antesDeAnalizar(run)) {
			parts.push(
				'Todavía no se analiza ningún archivo: lo que escriba la persona ya quedó en las instrucciones de la corrida y se aplicará al analizar. Contesta breve (confirma lo que entendiste) y no trabajes archivos salvo que te lo pida.'
			);
		}
		if (chat) {
			const stagings = await this.describirStagings(run);
			if (stagings.length) {
				parts.push(`Stagings (una tabla destino con los cambios de toda la corrida; nómbralos por su tabla, p. ej. «Planes GMF: 286 nuevas, 0 errores, lista para importar»):\n${stagings.join('\n')}`);
			}
			parts.push(
				`Estás en el chat de la corrida: responde a la persona y, si hace falta, vuelve a trabajar los archivos con las tools (nombra el archivo en «archivo»). Archivos:\n${run.archivos
					.map((f) => `- ${f.id} «${f.nombre}»${f.carpeta ? ` en ${f.carpeta}` : ''} (${f.tipo}) · ${f.estado} · destino: ${describirDestino(f)}${f.instruccion ? ` · instrucción: ${f.instruccion}` : ''} · ${f.analisis ?? 'sin análisis'} · ${f.filas.length} filas, ${f.issues.filter((i) => i.level === 'error').length} errores`)
					.join('\n')}`
			);
		}
		return parts.filter(Boolean).join('\n\n');
	}

	/** La presentación de un archivo para el modelo: qué es y, si es barato, qué trae. */
	private async presentar(run: ImportRun, file: ImportRunFile): Promise<LLMParte[]> {
		const head =
			`Archivo a analizar: «${file.nombre}»${file.carpeta ? ` (carpeta ${file.carpeta})` : ''}, ${file.tipo}, ${Math.round(file.tamano / 1024)} KB. Destino: ${describirDestino(file)}.` +
			(file.instruccion ? `\nInstrucción de la persona para este archivo (síguela): ${file.instruccion}` : '');
		const parts: LLMParte[] = [{ tipo: 'texto', texto: head }];
		if (file.tipo.startsWith('image/')) {
			parts.push({ tipo: 'imagen', datos: Buffer.from(await this.options.storage.read(file.url, run.contexto)), mime: file.tipo });
			return parts;
		}
		try {
			const e = await this.extraerP(this.toolContext(run, file), file);
			const pages = [...new Set(e.bloques.map((b) => b.pagina))];
			const index = e.bloques
				.map((b, i) => `[${i}] pág. ${b.pagina} · ${b.tipo}${b.titulo ? ` «${b.titulo.slice(0, 80)}»` : ''}${b.filas ? ` · ${b.filas.length} filas · ${(b.encabezados ?? []).join(' | ')}` : b.contenido ? ` · ${b.contenido.slice(0, 120).replace(/\n/g, ' ')}` : ''}`)
				.join('\n');
			parts.push({ tipo: 'texto', texto: `Índice (método P, ${e.archivo.paginas} ${e.archivo.tipo === 'xlsx' ? 'hojas' : 'páginas'}, bloques en ${pages.length}):\n${index}` });
		} catch (error) {
			parts.push({ tipo: 'texto', texto: `El método P no pudo leerlo: ${(error as Error).message}` });
		}
		return parts;
	}

	/**
	 * Una conversación con el modelo y sus tools. Con `archivo`, analiza ese
	 * archivo; con `mensaje`, responde en el chat. Devuelve el último texto.
	 */
	private async bucle(id: string, input: { archivo?: string; mensaje?: string; profundo?: boolean }): Promise<string> {
		const llm = this.options.llm!;
		let run = (await this.options.runs.obtener(id))!;
		const chat = input.archivo === undefined;
		const tools = this.tools(chat);
		const specs: LLMTool[] = tools.map(({ nombre, descripcion, parametros }) => ({ nombre, descripcion, parametros }));
		const mensajes: LLMMensaje[] = [];
		if (chat) {
			for (const m of run.chat.slice(-20)) {
				if (m.rol === 'usuario') mensajes.push({ rol: 'usuario', partes: [{ tipo: 'texto', texto: m.texto }] });
				else if (m.rol === 'agente') mensajes.push({ rol: 'agente', texto: m.texto });
			}
			mensajes.push({ rol: 'usuario', partes: [{ tipo: 'texto', texto: input.mensaje ?? '' }] });
		} else {
			mensajes.push({ rol: 'usuario', partes: await this.presentar(run, archivoDe(run, input.archivo!)) });
		}
		const sistema = await this.sistema(run, chat);
		let last = '';
		let calls = 0;
		for (let vuelta = 0; vuelta < (this.options.maxIteraciones ?? 12); vuelta++) {
			const respuesta = await llm.chat!({ sistema, mensajes, tools: specs, ...(this.options.model ? { modelo: this.options.model } : {}) });
			const llamadas = (respuesta.llamadas ?? []).map((l) => ({ ...l, id: l.id ?? `t${++calls}` }));
			mensajes.push({
				rol: 'agente',
				...(respuesta.texto ? { texto: respuesta.texto } : {}),
				...(llamadas.length ? { llamadas } : {}),
				...(respuesta.meta !== undefined ? { meta: respuesta.meta } : {})
			});
			if (respuesta.texto) last = respuesta.texto;
			if (!llamadas.length) break;
			let finished = false;
			for (const llamada of llamadas) {
				run = (await this.options.runs.obtener(id))!;
				const tool = tools.find((t) => t.nombre === llamada.nombre);
				const deArchivo = input.archivo ?? (typeof llamada.args?.archivo === 'string' ? run.archivos.find((f) => f.id === llamada.args.archivo || f.nombre === llamada.args.archivo)?.id : undefined);
				this.progreso(id, deArchivo, PASOS[llamada.nombre] ?? `usando ${llamada.nombre}…`);
				let resultado: unknown;
				try {
					if (!tool) throw new Error(`No existe la tool «${llamada.nombre}»`);
					const file = input.archivo ? archivoDe(run, input.archivo) : null;
					resultado = acotar(await tool.ejecutar(llamada.args ?? {}, this.toolContext(run, file)));
				} catch (error) {
					resultado = { error: (error as Error).message };
				}
				mensajes.push({ rol: 'tool', id: llamada.id, nombre: llamada.nombre, resultado });
				if (llamada.nombre === 'terminar' && !chat) finished = true;
			}
			if (finished) break;
		}
		return last;
	}

	// -- chat -------------------------------------------------------------------------------

	/** La persona escribe en el chat de la corrida; el agente responde (y puede volver a trabajar archivos). */
	async chat(id: string, texto: string, ctx: Record<string, unknown> = {}): Promise<ImportChatResponse> {
		if (!texto.trim()) throw new ValidationError('El mensaje está vacío');
		const before = await this.obtener(id, ctx);
		const user: ImportChatMessage = { id: randomUUID(), rol: 'usuario', texto: texto.trim(), fecha: now() };
		// Antes de analizar, lo que dice la persona son las instrucciones de la corrida: el análisis las lee.
		const previo = antesDeAnalizar(before);
		await this.mutar(id, (r) => {
			r.chat.push(user);
			if (previo) r.instrucciones = [r.instrucciones, user.texto].filter(Boolean).join('\n');
		});
		this.emit({ corrida: id, tipo: 'chat', mensaje: user.texto });
		let reply: string;
		if (this.options.brain) {
			try {
				reply = (await this.options.brain.manejar({ tipo: 'chat', texto: user.texto }, this.host(id)))?.respuesta || 'Listo.';
			} catch (error) {
				reply = `No pude responder: ${(error as Error).message}`;
			}
		} else if (this.options.llm?.chat) {
			try {
				reply = (await this.bucle(id, { mensaje: user.texto })) || 'Listo.';
			} catch (error) {
				reply = `No pude responder: ${(error as Error).message}`;
			}
		} else if (previo) {
			reply = 'Anotado: lo tomo en cuenta al analizar.';
		} else {
			// Sin modelo de chat: el mensaje se toma como instrucción para el próximo análisis.
			await this.mutar(id, (r) => {
				r.instrucciones = [r.instrucciones, user.texto].filter(Boolean).join('\n');
			});
			reply = 'No hay un modelo conectado para conversar: agregué tu mensaje a las instrucciones. Vuelve a analizar para aplicarlas.';
		}
		const mensaje: ImportChatMessage = { id: randomUUID(), rol: 'agente', texto: reply, fecha: now() };
		const run = await this.mutar(id, (r) => {
			r.chat.push(mensaje);
		});
		this.emit({ corrida: id, tipo: 'chat', mensaje: reply });
		return { mensaje, corrida: vista(run) };
	}

	// -- importar ---------------------------------------------------------------------------

	/**
	 * Encola la importación de cada archivo con destino. La ventana se puede cerrar.
	 *
	 * - `staging`: los destinos cuyo staging ya guardó el cliente en la hoja (§8.3): sus archivos se
	 *   marcan importados sin `apply`; lo demás (adjuntar, otros formatos) sigue igual.
	 * - `destinos` (§10): importar solo esos stagings (por su formato): entran los archivos que los
	 *   alimentan (filas de ese formato o adjuntos a una de sus columnas). La corrida vuelve a `lista`
	 *   al terminar si faltan otros archivos. Sin `destinos`, todo lo que no se importó.
	 */
	async importar(
		id: string,
		ctx: Record<string, unknown> = {},
		opciones: {
			staging?: { destino: string; resumen: { insert: number; update: number; delete: number }; sinEmparejar?: { archivo: string; motivo: string }[] }[];
			destinos?: string[];
		} = {}
	): Promise<ImportRun> {
		const destinos = opciones.destinos?.length ? [...new Set(opciones.destinos)] : null;
		for (const d of destinos ?? []) if (!this.formats.has(d)) throw new ValidationError(`No existe el destino «${d}»`);
		if (opciones.staging?.length) {
			await this.obtener(id, ctx);
			const fecha = now();
			await this.mutar(id, (r) => {
				r.staging ??= {};
				for (const s of opciones.staging!) {
					const prev = r.staging[s.destino];
					r.staging[s.destino] = {
						cambios: prev?.cambios ?? null,
						firma: prev?.firma ?? null,
						editado: prev?.editado ?? null,
						publicado: { fecha, resumen: s.resumen, ...(s.sinEmparejar?.length ? { sinEmparejar: s.sinEmparejar } : {}) }
					};
				}
			});
		}
		const run = await this.obtener(id, ctx);
		if (run.archivos.some((f) => f.estado === 'en_cola' || f.estado === 'analizando')) {
			throw new SpreadBaseError(409, 'still_analyzing', 'Espera a que termine el análisis');
		}
		const ids = run.archivos
			.filter((f) => f.estado !== 'importado' && f.estado !== 'importando')
			.filter((f) => !destinos || destinos.includes(this.stagingDeArchivo(f) ?? ''))
			.map((f) => f.id);
		if (!ids.length) throw new ValidationError(destinos ? `No hay archivos por importar en ${destinos.map((d) => this.etiquetaFormato(d)).join(', ')}` : 'No hay archivos por importar');
		const updated = await this.mutar(id, (r) => {
			for (const fid of ids) {
				const f = archivoDe(r, fid);
				f.estado = 'en_cola';
				f.resultado = null;
			}
			r.estado = 'importando';
			r.importacion = { destinos, archivos: ids };
		});
		for (const fid of ids) await this.runner.encolar({ tipo: 'importar', corrida: id, archivo: fid });
		this.emit({ corrida: id, tipo: 'corrida', estado: 'importando' });
		return updated;
	}

	private async importarArchivo(id: string, fid: string): Promise<void> {
		const run = await this.mutar(id, (r) => {
			archivoDe(r, fid).estado = 'importando';
		});
		this.emit({ corrida: id, tipo: 'archivo', archivo: fid, estado: 'importando' });
		const file = archivoDe(run, fid);
		this.progreso(id, fid, file.destino?.tipo === 'adjuntar' ? 'adjuntando…' : file.destino?.tipo === 'filas' ? `guardando ${file.filas.length} filas…` : 'cerrando…');
		let resultado: ImportFileResult;
		let issues = file.issues;
		try {
			const destino = file.destino;
			if (!destino) resultado = { status: 'error', ok: 0, error: 0, mensaje: 'Sin destino' };
			else if (destino.tipo === 'descartar') resultado = { status: 'ok', ok: 0, error: 0, mensaje: `Descartado${destino.motivo ? `: ${destino.motivo}` : ''}` };
			else if (destino.tipo === 'adjuntar') {
				const handler = this.attachments.get(destino.adjunto);
				if (!handler) throw new Error(`No existe el destino «${destino.adjunto}»`);
				// A una columna (SB-38): ya va en el staging, que se guardó con la hoja.
				const enColumna = handler.columna && run.staging?.[handler.columna.formato]?.publicado;
				const out = enColumna || !handler.attach ? null : await handler.attach({
					destino,
					archivo: { id: file.id, nombre: file.nombre, tipo: file.tipo, carpeta: file.carpeta, url: file.url, tamano: file.tamano },
					filas: file.filas,
					derivados: file.derivados,
					corrida: run,
					contexto: run.contexto
				});
				if (!enColumna && !handler.attach) throw new Error(`Va en la columna «${handler.columna?.campo}»: se guarda con el staging de ${handler.columna?.formato}`);
				// No emparejó con ninguna fila: no quedó en la tabla.
				const suelto = enColumna ? enColumna.sinEmparejar?.find((x) => x.archivo === file.id) : undefined;
				if (suelto) throw new Error(`No se emparejó con ninguna fila: ${suelto.motivo}`);
				resultado = { status: 'ok', ok: 1, error: 0, ...(enColumna ? { mensaje: `En la columna «${handler.columna!.campo}»` } : {}), ...(out?.resumen ? { resumen: out.resumen } : {}) };
			} else if (run.staging?.[destino.formato]?.publicado) {
				// El staging ya se guardó en la hoja (§8.3): el archivo quedó importado con él.
				resultado = { status: 'ok', ok: file.filas.length, error: 0, mensaje: 'Guardado con el staging', resumen: run.staging[destino.formato]!.publicado!.resumen };
				issues = [];
			} else {
				({ resultado, issues } = await this.publicar(run, file, destino));
			}
		} catch (error) {
			resultado = { status: 'error', ok: 0, error: file.filas.length, mensaje: (error as Error).message };
		}
		await this.mutar(id, (r) => {
			const f = archivoDe(r, fid);
			f.resultado = resultado;
			f.issues = issues;
			f.estado = resultado.status === 'error' ? 'error' : 'importado';
			if (resultado.status === 'error') f.error = resultado.mensaje ?? null;
		});
		this.emit({ corrida: id, tipo: 'archivo', archivo: fid, estado: resultado.status === 'error' ? 'error' : 'importado', resultado });
		await this.cerrarFase(id);
	}

	/**
	 * `apply` del formato. `replace`: cualquier error lo bloquea (reemplazar con
	 * datos incompletos borraría filas válidas). `upsert`: publica las filas
	 * buenas; las malas se quedan en la corrida con su error.
	 */
	private async publicar(run: ImportRun, file: ImportRunFile, destino: Extract<ImportDestination, { tipo: 'filas' }>): Promise<{ resultado: ImportFileResult; issues: ImportIssue[] }> {
		const format = this.formato(destino.formato);
		const context = { ...run.contexto, modo: destino.modo, corrida: run.id, archivo: file.id };
		const payload: ImportPayload = { rows: file.filas, fields: file.campos ?? {}, fileName: file.nombre, checksum: null, force: false };
		if (!file.filas.length) return { resultado: { status: 'error', ok: 0, error: 0, mensaje: 'No hay filas que importar' }, issues: file.issues };
		const review = await format.review(payload, context);
		const errors = review.issues.filter((i) => i.level === 'error');
		const global = errors.filter((i) => i.row === null);
		const bad = new Set(errors.filter((i) => i.row !== null).map((i) => i.row!));
		if (global.length || review.blocked || (destino.modo === 'replace' && bad.size)) {
			const motivo = global[0]?.message ?? review.blocked?.reasons[0] ?? `${bad.size} filas con error: con replace no se publica nada`;
			return { resultado: { status: 'error', ok: 0, error: bad.size || file.filas.length, mensaje: motivo }, issues: review.issues };
		}
		const good = file.filas.map((row, i) => ({ row, i })).filter(({ i }) => !bad.has(i));
		if (!good.length) return { resultado: { status: 'error', ok: 0, error: bad.size, mensaje: 'Ninguna fila sin error' }, issues: review.issues };
		const applied = await format.apply({ ...payload, rows: good.map((g) => g.row) }, context);
		// Los problemas de `apply` vienen por posición en las buenas: a la posición en el archivo.
		const applyIssues = applied.issues.map((i) => ({ ...i, row: i.row === null ? null : (good[i.row]?.i ?? i.row) }));
		const issues = [...review.issues.filter((i) => i.row !== null && bad.has(i.row)), ...applyIssues];
		if (!applied.applied || !applied.ok) {
			return { resultado: { status: 'error', ok: 0, error: file.filas.length, mensaje: applyIssues.find((i) => i.level === 'error')?.message ?? applied.blocked?.reasons[0] ?? 'No se aplicó', resumen: applied.summary }, issues };
		}
		return {
			resultado: { status: bad.size ? 'parcial' : 'ok', ok: good.length, error: bad.size, resumen: applied.summary },
			issues
		};
	}

	/** Si ya no queda nada en la cola de la corrida, cierra la fase: lista (tras analizar) o terminada (tras importar). */
	private async cerrarFase(id: string): Promise<void> {
		let closed: ImportRun | null = null;
		let importando = false;
		const run = await this.mutar(id, (r) => {
			// `mutar` puede reintentar: solo cuenta el intento que se guardó (si otro cerró antes, no se cierra dos veces).
			closed = null;
			if (r.archivos.some((f) => f.estado === 'en_cola' || f.estado === 'analizando' || f.estado === 'importando')) return;
			importando = r.estado === 'importando';
			if (r.estado === 'analizando') r.estado = 'lista';
			// Termina cuando todos los archivos pasaron por una importación; si se importó un solo destino
			// y faltan otros archivos, la corrida sigue abierta (§10).
			else if (r.estado === 'importando') r.estado = r.archivos.every((f) => f.resultado || f.estado === 'importado') ? 'terminada' : 'lista';
			else return;
			closed = r;
		});
		if (!closed) return;
		const importo = run.importacion;
		const despuesDeImportar = importando;
		const totales = despuesDeImportar
			? run.archivos
					.filter((f) => !importo || importo.archivos.includes(f.id))
					.reduce((t, f) => ({ ok: t.ok + (f.resultado?.ok ?? 0), error: t.error + (f.resultado?.error ?? 0), archivos: t.archivos + 1 }), { ok: 0, error: 0, archivos: 0 })
			: undefined;
		if (despuesDeImportar) {
			const veredicto = this.veredictoImportacion(run);
			await this.decir(id, veredicto);
			this.avisarCerebro(id, { tipo: 'importacion_terminada', resumen: veredicto, ...(importo?.destinos ? { destinos: importo.destinos } : {}) });
		}
		this.emit({ corrida: id, tipo: 'corrida', estado: run.estado, ...(totales ? { totales } : {}) });
	}

	/**
	 * El staging (formato destino) que alimenta un archivo: el de sus filas, o el de la tabla a cuya
	 * columna va (SB-38). `null` si no alimenta ninguno (adjuntar a otro lado, descartar, sin destino).
	 */
	stagingDeArchivo(f: Pick<ImportRunFile, 'destino'>): string | null {
		const d = f.destino;
		if (d?.tipo === 'filas') return this.formats.has(d.formato) ? d.formato : null;
		if (d?.tipo === 'adjuntar') return this.attachments.get(d.adjunto)?.columna?.formato ?? null;
		return null;
	}

	/**
	 * Una descripción por staging con archivos (§10): tabla, modo, conteos, errores y avisos con
	 * ejemplos, lo que no emparejó, qué archivos lo alimentan y si ya se importó. Para el prompt del
	 * agente (el básico en el chat; el cerebro arma la suya con `describirStaging`).
	 */
	async describirStagings(run: ImportRun): Promise<string[]> {
		const out: string[] = [];
		for (const [formato, { format }] of this.formats) {
			const archivos = run.archivos.filter((f) => this.stagingDeArchivo(f) === formato);
			if (!archivos.length && !run.staging?.[formato]) continue;
			const schema = format.schema();
			try {
				const { set } = await stagingDeCorrida(this, run.id, formato, null);
				out.push(
					describirStaging(set, {
						label: schema.label,
						columnas: schema.columns,
						publicado: run.staging?.[formato]?.publicado ?? null,
						importado: archivos.length > 0 && archivos.every((f) => f.estado === 'importado'),
						archivos: archivos.map((f) => `«${f.nombre}» (${f.destino?.tipo === 'adjuntar' ? `columna ${this.attachments.get(f.destino.adjunto)?.columna?.campo ?? f.destino.adjunto}` : `${f.filas.length} filas`}, ${f.estado})`)
					})
				);
			} catch (error) {
				out.push(`«${schema.label}» (${formato}): no se pudo calcular (${(error as Error).message})`);
			}
		}
		return out;
	}

	/** El nombre de la tabla de un formato («Planes GMF»). */
	etiquetaFormato(formato: string): string {
		return this.formats.get(formato)?.format.schema().label ?? formato;
	}

	// -- lo que hacen las tools ---------------------------------------------------------------

	private key = (file: ImportRunFile) => `${file.url}`;

	private remember(file: ImportRunFile) {
		const k = this.key(file);
		let m = this.memo.get(k);
		if (!m) {
			m = {};
			this.memo.set(k, m);
			// Memoria acotada: lo más viejo se olvida (se vuelve a extraer si hace falta).
			if (this.memo.size > 100) this.memo.delete(this.memo.keys().next().value!);
		}
		return m;
	}

	private toolContext(run: ImportRun, file: ImportRunFile | null): ImportToolContext {
		return { corrida: run, archivo: file, contexto: run.contexto, leer: (f) => this.options.storage.read(f.url, run.contexto) };
	}

	private formato(id: string): ImportFormat {
		const f = this.formats.get(id);
		if (!f) throw new ValidationError(`No existe el formato «${id}»`);
		return f.format;
	}

	private validarDestino(destino: ImportDestination) {
		if (destino.tipo === 'filas') {
			const f = this.formats.get(destino.formato);
			if (!f) throw new ValidationError(`No existe el formato «${destino.formato}»`);
			const modos = f.def.modos ?? ['upsert', 'replace'];
			if (!modos.includes(destino.modo)) throw new ValidationError(`El formato «${destino.formato}» no admite el modo ${destino.modo}`);
		} else if (destino.tipo === 'adjuntar') {
			if (!this.attachments.has(destino.adjunto)) throw new ValidationError(`No existe el destino «${destino.adjunto}»`);
		} else if (destino.tipo === 'descartar') {
			if (!this.discard) throw new ValidationError('Este asistente no permite descartar');
		} else throw new ValidationError('Destino inválido');
	}

	async extraerP(ctx: ImportToolContext, file: ImportRunFile, paginas?: number[]): Promise<Extraccion> {
		const m = this.remember(file);
		if (!m.P) {
			const bytes = await ctx.leer(file);
			if (extensionOf(file.nombre) === 'docx') {
				m.P = { archivo: { nombre: file.nombre, paginas: 1, tipo: 'texto' }, bloques: [{ pagina: 1, tipo: 'texto', contenido: docxText(bytes), confianza: 1 }] };
			} else {
				m.P = await extraerDeterminista(bytes, { nombre: file.nombre, mime: file.tipo });
			}
		}
		if (!paginas?.length) return m.P;
		return { ...m.P, bloques: m.P.bloques.filter((b) => paginas.includes(b.pagina)) };
	}

	async extraerX(ctx: ImportToolContext, file: ImportRunFile, paginas?: number[], formato?: string): Promise<Extraccion> {
		const llm = this.options.llm;
		if (!llm) throw new Error('No hay un modelo conectado para el método X');
		const bytes = await ctx.leer(file);
		const max = this.options.maxPaginasX ?? 30;
		const schema = formato && this.formats.has(formato) ? this.formato(formato).schema() : undefined;
		let pages: { pagina: number; imagen: Buffer; texto?: string }[];
		let total = 1;
		if (file.tipo === 'application/pdf') {
			const p = await this.extraerP(ctx, file).catch(() => null);
			total = p?.archivo.paginas ?? 1;
			const wanted = (paginas?.length ? paginas : Array.from({ length: total }, (_, i) => i + 1)).slice(0, max);
			pages = (await renderizarPdf(bytes, { paginas: wanted })).map((r) => ({ pagina: r.pagina, imagen: r.png, ...(p ? { texto: textoDePagina(p, r.pagina) } : {}) }));
		} else if (file.tipo.startsWith('image/')) {
			pages = [{ pagina: 1, imagen: Buffer.from(bytes) }];
		} else throw new Error('El método X lee PDFs e imágenes');
		const x = await extraerConLLM(pages, llm, {
			...(schema ? { schema } : {}),
			archivo: { nombre: file.nombre, paginas: total, tipo: file.tipo === 'application/pdf' ? 'pdf' : 'imagen' },
			...(this.options.model ? { modelo: this.options.model } : {}),
			concurrencia: 2
		});
		const m = this.remember(file);
		// Lo nuevo reemplaza lo de esas páginas; lo de otras páginas se conserva.
		const kept = (m.X?.bloques ?? []).filter((b) => !pages.some((p) => p.pagina === b.pagina));
		m.X = { ...x, bloques: [...kept, ...x.bloques].sort((a, b) => a.pagina - b.pagina), ...(x.avisos || m.X?.avisos ? { avisos: [...(m.X?.avisos ?? []), ...(x.avisos ?? [])] } : {}) };
		// Toda la X acumulada: los índices de sus bloques son los que usan verBloque y mapearTabla.
		return m.X;
	}

	private kernel(): Kernel {
		return {
			destinos: () => this.config().destinos,
			esquema: (formato) => this.formato(formato).schema(),
			extraerP: (ctx, f, p) => this.extraerP(ctx, f, p),
			extraerX: (ctx, f, p, formato) => this.extraerX(ctx, f, p, formato),
			extraccion: (f, metodo) => this.memo.get(this.key(f))?.[metodo],
			comparar: (f) => {
				const m = this.memo.get(this.key(f));
				if (!m?.P || !m.X) throw new Error('Primero extrae el archivo con P y con X');
				const pages = new Set(m.X.bloques.map((b) => b.pagina));
				const diffs = compararExtracciones({ ...m.P, bloques: m.P.bloques.filter((b) => pages.has(b.pagina)) }, m.X);
				return { total: diffs.length, diferencias: diffs.slice(0, 40) };
			},
			mapear: (f, formato, metodo, bloques, opciones) => {
				const r = this.mapear(f, formato, metodo, bloques, opciones);
				return { totalFilas: r.filas.length, muestra: r.filas.slice(0, 5), columnas: r.columnas, faltan: r.faltan, ignoradas: r.ignoradas };
			},
			proponer: (ctx, f, args) => this.proponer(ctx, f, args),
			editar: (ctx, f, args) => this.editar(ctx, f, args),
			revisar: async (ctx, f) => {
				const review = await this.revisarArchivo(ctx.corrida.id, f.id);
				return {
					ok: review.ok,
					errores: review.issues.filter((i) => i.level === 'error').length,
					avisos: review.issues.filter((i) => i.level !== 'error').length,
					issues: review.issues.slice(0, 30),
					resumen: review.summary,
					...(review.blocked ? { bloqueado: review.blocked } : {})
				};
			},
			actuales: async (ctx, formato, buscar, limite) => {
				const def = this.formats.get(formato)?.def;
				if (!def) throw new Error(`No existe el formato «${formato}»`);
				if (!def.actuales) return { filas: [], nota: 'La app no expone las filas actuales de este destino' };
				if (def.actuales instanceof SpreadBase) {
					const page = await def.actuales.list({ offset: 0, limit: limite, sort: null, filters: {}, search: buscar }, ctx.contexto);
					return { total: page.total, filas: page.rows };
				}
				const rows = await def.actuales({ buscar, limite }, ctx.contexto);
				return { total: rows.length, filas: rows.slice(0, limite) };
			},
			derivar: async (ctx, f, nombre, contenido, tipo) => {
				await this.mutar(ctx.corrida.id, (r) => {
					const file = archivoDe(r, f.id);
					file.derivados = [...file.derivados.filter((d) => d.nombre !== nombre), { nombre, tipo, contenido }];
				});
				return { ok: true, derivados: [nombre] };
			},
			destinar: (ctx, f, destino) => this.destinar(ctx, f, destino),
			terminar: (ctx, f, analisis, destino) => this.terminar(ctx, f, analisis, destino)
		};
	}

	private mapear(file: ImportRunFile, formato: string, metodo: 'P' | 'X', bloques: number[], opciones: MapeoOpciones): Mapeo {
		const m = this.remember(file);
		const e = m[metodo];
		if (!e) throw new Error(`Primero extrae el archivo con el método ${metodo}`);
		const blocks = bloques.map((i) => {
			const b = e.bloques[i];
			if (!b || b.tipo !== 'tabla') throw new Error(`El bloque ${i} no es una tabla`);
			return b;
		});
		const mapeo = mapearBloques(blocks, this.formato(formato).schema(), opciones);
		m.mapeo = { ...mapeo, formato };
		return mapeo;
	}

	/** Respeta lo que fijó la persona: devuelve el error para el modelo si intenta otro destino. */
	private puedeDestinar(file: ImportRunFile, destino: ImportDestination): string | null {
		if (!file.destinoFijadoPorUsuario || !file.destino) return null;
		const fixed = file.destino;
		const same = fixed.tipo === destino.tipo && (fixed.tipo !== 'filas' || (destino.tipo === 'filas' && fixed.formato === destino.formato));
		return same ? null : `La persona fijó el destino de «${file.nombre}» (${describirDestino(file)}): no se cambia`;
	}

	private async proponer(
		ctx: ImportToolContext,
		file: ImportRunFile,
		args: { formato: string; modo?: 'upsert' | 'replace'; filas?: Record<string, unknown>[]; agregar?: boolean; campos?: Record<string, CellValue> }
	): Promise<unknown> {
		const entry = this.formats.get(args.formato);
		if (!entry) throw new Error(`No existe el formato «${args.formato}»`);
		const modo = file.destinoFijadoPorUsuario && file.destino?.tipo === 'filas' ? file.destino.modo : (args.modo ?? entry.def.modo ?? (entry.def.modos ?? ['upsert'])[0]!);
		const destino: ImportDestination = { tipo: 'filas', formato: args.formato, modo };
		const refused = this.puedeDestinar(file, destino);
		if (refused) throw new Error(refused);
		const columns = Object.entries(entry.format.schema().columns).filter(([, c]) => c.from !== 'form');
		let rows: Record<string, CellValue>[];
		if (args.filas === undefined) {
			const mapeo = this.memo.get(this.key(file))?.mapeo;
			if (!mapeo || mapeo.formato !== args.formato) throw new Error('No hay un mapearTabla de este formato para usar');
			rows = mapeo.filas;
		} else {
			rows = args.filas.map((row) => Object.fromEntries(columns.map(([f, c]) => [f, coerceCell(row[f], c)])));
		}
		const run = await this.mutar(ctx.corrida.id, (r) => {
			const f = archivoDe(r, file.id);
			const same = f.destino?.tipo === 'filas' && f.destino.formato === args.formato;
			f.filas = args.agregar && same ? [...f.filas, ...rows] : rows;
			f.destino = destino;
			if (args.campos) f.campos = { ...f.campos, ...args.campos };
			f.issues = [];
			f.resumen = null;
		});
		return { total: archivoDe(run, file.id).filas.length, destino };
	}

	private async editar(ctx: ImportToolContext, file: ImportRunFile, args: EditarArgs): Promise<unknown> {
		let quitadas = 0;
		let cambiadas = 0;
		const run = await this.mutar(ctx.corrida.id, (r) => {
			const f = archivoDe(r, file.id);
			const columns = f.destino?.tipo === 'filas' && this.formats.has(f.destino.formato) ? this.formato(f.destino.formato).schema().columns : {};
			for (const c of args.cambiar ?? []) {
				const row = f.filas[c.fila];
				if (!row) continue;
				row[c.campo] = columns[c.campo] ? coerceCell(c.valor, columns[c.campo]!) : c.valor;
				cambiadas++;
			}
			const drop = new Set(args.quitar ?? []);
			const cond = args.quitarSi;
			const before = f.filas.length;
			f.filas = f.filas.filter((row, i) => {
				if (drop.has(i)) return false;
				if (!cond) return true;
				const v = row[cond.campo];
				if (cond.contiene !== undefined) return !String(v ?? '').toLowerCase().includes(cond.contiene.toLowerCase());
				return String(v ?? '') !== String(cond.igual ?? '');
			});
			quitadas = before - f.filas.length;
			for (const row of args.agregar ?? []) {
				f.filas.push(Object.fromEntries(Object.entries(columns).filter(([, c]) => c.from !== 'form').map(([k, c]) => [k, coerceCell(row[k], c)])));
			}
			f.issues = [];
		});
		return { total: archivoDe(run, file.id).filas.length, quitadas, cambiadas, agregadas: args.agregar?.length ?? 0 };
	}

	/** `review` del formato sobre las filas propuestas; guarda lo que encontró en el archivo. */
	private async revisarArchivo(id: string, fid: string) {
		const run = (await this.options.runs.obtener(id))!;
		const file = archivoDe(run, fid);
		if (file.destino?.tipo !== 'filas') throw new Error(`«${file.nombre}» no va a un formato: primero proponerFilas`);
		const destino = file.destino;
		const schema = this.formato(destino.formato).schema();
		// Filas idénticas en todo (el boletín repite tablas entre páginas): se unen en una, con un aviso.
		const { filas, unidas } = colapsarIdenticas(file.filas);
		const total = Number(file.resumen?.unidas ?? 0) + unidas;
		const review = await this.formato(destino.formato).review(
			{ rows: filas, fields: file.campos ?? {}, fileName: file.nombre, checksum: null, force: false },
			{ ...run.contexto, modo: destino.modo, corrida: id, archivo: fid }
		);
		const issues = explicarRepetidas(review.issues, filas, schema.columns);
		if (total) issues.push({ row: null, level: 'warning', message: `${total} ${total === 1 ? 'fila duplicada idéntica se unió' : 'filas duplicadas idénticas se unieron'}` });
		await this.mutar(id, (r) => {
			const f = archivoDe(r, fid);
			if (unidas && f.filas.length === file.filas.length) f.filas = filas;
			f.issues = issues;
			f.resumen = { formato: destino.formato, ...review.summary, ...(total ? { unidas: total } : {}) };
		});
		return { ...review, issues };
	}

	// -- el chat siempre reporta ---------------------------------------------------------------

	/** Un mensaje del agente en el chat, sin LLM (veredictos). */
	private async decir(id: string, texto: string): Promise<void> {
		if (!texto) return;
		const mensaje: ImportChatMessage = { id: randomUUID(), rol: 'agente', texto, fecha: now() };
		await this.mutar(id, (r) => {
			r.chat.push(mensaje);
		});
		this.emit({ corrida: id, tipo: 'chat', mensaje: texto });
	}

	/** Las columnas con más errores de un archivo, por su etiqueta («Precio Final»). */
	private columnasConError(f: ImportRunFile): string {
		const schema = f.destino?.tipo === 'filas' && this.formats.has(f.destino.formato) ? this.formato(f.destino.formato).schema() : null;
		const count = new Map<string, number>();
		for (const i of f.issues) if (i.level === 'error' && i.field) count.set(i.field, (count.get(i.field) ?? 0) + 1);
		const top = [...count].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([field]) => schema?.columns[field]?.label ?? field);
		return top.length ? ` en ${top.join(' y ')}` : '';
	}

	private etiquetaDestino(d: ImportDestination): string {
		const option = this.config().destinos.find((o) => (d.tipo === 'filas' ? o.tipo === 'filas' && o.formato === d.formato : d.tipo === 'adjuntar' ? o.tipo === 'adjuntar' && o.adjunto === d.adjunto : o.tipo === 'descartar'));
		return option?.label ?? (d.tipo === 'filas' ? d.formato : d.tipo === 'adjuntar' ? d.adjunto : 'Descartar');
	}

	/** Una línea por archivo al terminar su análisis: filas, errores y qué sigue. */
	private veredictoAnalisis(f: ImportRunFile): string {
		const n = f.nombre;
		if (f.estado === 'error') return `${n}: no se pudo analizar (${f.error ?? 'error'}).`;
		const d = f.destino;
		const nota = f.analisis ? ` ${f.analisis.replace(/\.?$/, '.')}` : '';
		if (!d) return `${n}: no encontré a dónde va; elige un destino.${nota}`;
		if (d.tipo === 'descartar') return `${n}: se descarta${d.motivo ? ` (${d.motivo})` : ''}.`;
		if (d.tipo === 'adjuntar') return `${n}: se adjunta a ${this.etiquetaDestino(d)}${d.fila ? ` · ${d.fila}` : ''}.${nota}`;
		const view = vistaArchivo(f);
		if (!view.totalFilas) return `${n}: no saqué filas para ${this.etiquetaDestino(d)}.${nota}`;
		const filas = `${view.totalFilas} ${view.totalFilas === 1 ? 'fila' : 'filas'}`;
		const avisos = f.issues.filter((i) => i.level === 'warning' && i.row === null).map((i) => ` ${i.message}.`).join('');
		// Con cerebro (§8.2), el veredicto lleva su Análisis: la columna y el chat dicen lo mismo.
		const analisis = this.options.brain ? nota : '';
		if (!view.totalErrores) return `${n}: ${filas}, 0 errores, listo para ${d.modo === 'replace' ? 'reemplazar' : 'actualizar o agregar'}.${avisos}${analisis}`;
		const bloqueo = d.modo === 'replace' ? ' Con reemplazar no se importa nada hasta corregirlos.' : '';
		return `${n}: ${filas}, ${view.totalErrores} con error${this.columnasConError(f)}; ábrelo para verlos.${bloqueo}${avisos}${analisis}`;
	}

	/** Al terminar de importar: los totales y una línea por archivo. */
	private veredictoImportacion(run: ImportRun): string {
		let filas = 0;
		let adjuntos = 0;
		let errores = 0;
		// Con un solo destino (§10): solo los archivos de esa importación, y lo que falta.
		const lote = run.importacion?.destinos ? run.importacion : null;
		const archivos = lote ? run.archivos.filter((f) => lote.archivos.includes(f.id)) : run.archivos;
		const lines = archivos.map((f) => {
			const r = f.resultado;
			const n = f.nombre;
			if (!r) return `${n}: ${f.error ?? 'sin resultado'}.`;
			errores += r.error;
			if (f.destino?.tipo === 'descartar') return `${n}: descartado.`;
			if (f.destino?.tipo === 'adjuntar') {
				if (r.status === 'ok') adjuntos += r.ok;
				return r.status === 'ok' ? `${n}: adjuntado a ${this.etiquetaDestino(f.destino)}.` : `${n}: no se adjuntó (${r.mensaje ?? 'error'}).`;
			}
			filas += r.ok;
			if (r.status === 'ok') return `${n}: ${r.ok} ${r.ok === 1 ? 'fila importada' : 'filas importadas'}.`;
			if (r.status === 'parcial') return `${n}: ${r.ok} importadas, ${r.error} con error${this.columnasConError(f)}; ábrelo para corregirlas.`;
			return `${n}: no se importó (${r.mensaje ?? 'error'}); ábrelo para verlo.`;
		});
		const cuenta = `${filas} ${filas === 1 ? 'fila importada' : 'filas importadas'}${adjuntos ? `, ${adjuntos} ${adjuntos === 1 ? 'adjunto' : 'adjuntos'}` : ''}${errores ? `, ${errores} con error` : ''}`;
		const head = lote ? `Importé ${lote.destinos!.map((d) => this.etiquetaFormato(d)).join(', ')}: ${cuenta}.` : `Importación terminada: ${cuenta}.`;
		// Lo guardado desde el staging (§8.3): qué cambió en cada tabla.
		const n = (k: number, uno: string, varios: string) => `${k} ${k === 1 ? uno : varios}`;
		const tablas = Object.entries(run.staging ?? {}).flatMap(([formato, s]) =>
			s.publicado && (!lote || lote.destinos!.includes(formato))
				? [`${this.etiquetaFormato(formato)}: ${n(s.publicado.resumen.insert, 'nueva', 'nuevas')}, ${n(s.publicado.resumen.update, 'actualizada', 'actualizadas')}, ${n(s.publicado.resumen.delete, 'eliminada', 'eliminadas')}.`]
				: []
		);
		const faltan = lote ? run.archivos.filter((f) => !f.resultado && f.estado !== 'importado') : [];
		const pendientes = [...new Set(faltan.map((f) => this.stagingDeArchivo(f)).filter((d): d is string => !!d))].map((d) => this.etiquetaFormato(d));
		const cola = faltan.length
			? [`Falta${faltan.length === 1 ? '' : 'n'} ${n(faltan.length, 'archivo', 'archivos')} por importar${pendientes.length ? ` (${pendientes.join(', ')})` : ''}: ${faltan.slice(0, 5).map((f) => f.nombre).join(', ')}${faltan.length > 5 ? '…' : ''}.`]
			: [];
		return [head, ...tablas, ...lines.map((l) => `• ${l}`), ...cola].join('\n');
	}

	private async destinar(ctx: ImportToolContext, file: ImportRunFile, destino: ImportDestination): Promise<unknown> {
		this.validarDestino(destino);
		const refused = this.puedeDestinar(file, destino);
		if (refused) throw new Error(refused);
		await this.mutar(ctx.corrida.id, (r) => {
			archivoDe(r, file.id).destino = destino;
		});
		return { ok: true, destino };
	}

	private async terminar(ctx: ImportToolContext, file: ImportRunFile, analisis: string, destino?: ImportDestination): Promise<unknown> {
		if (destino) {
			this.validarDestino(destino);
			const refused = this.puedeDestinar(file, destino);
			if (refused) destino = undefined;
		}
		await this.mutar(ctx.corrida.id, (r) => {
			const f = archivoDe(r, file.id);
			f.analisis = analisis.trim().slice(0, 500);
			if (destino) f.destino = destino;
		});
		return { ok: true };
	}

	// -- persistencia -----------------------------------------------------------------------

	/** Lee, cambia y guarda con control de versión; si otro se adelantó, vuelve a leer y reaplica. */
	private async mutar(id: string, change: (run: ImportRun) => void): Promise<ImportRun> {
		for (let attempt = 0; attempt < 20; attempt++) {
			const run = await this.options.runs.obtener(id);
			if (!run) throw new NotFoundError(`No existe la corrida ${id}`);
			const read = run.version;
			change(run);
			run.version = read + 1;
			run.actualizada = now();
			if (await this.options.runs.guardar(run, read)) return run;
		}
		throw new SpreadBaseError(409, 'run_conflict', 'La corrida cambió demasiadas veces a la vez; reintenta');
	}

	private emit(event: ImportRunEvent) {
		try {
			this.options.onEvent?.(event);
		} catch {
			// Un aviso que falla no detiene la corrida.
		}
		this.vivo(event.corrida, { tipo: 'corrida', evento: event });
	}

	// -- cerebro (fase B): eventos, en vivo y «Detener» ---------------------------------------

	/** El análisis de siempre: el bucle con `llm.chat`, o reglas. */
	private async analizarBasico(id: string, fid: string): Promise<void> {
		if (this.options.llm?.chat) await this.bucle(id, { archivo: fid });
		else await this.porReglas(id, fid);
	}

	/** Escuchar una corrida en vivo (SSE): texto del chat por partes, progreso, costo y eventos. */
	suscribir(id: string, listener: (e: ImportLiveEvent) => void): () => void {
		let set = this.vivos.get(id);
		if (!set) this.vivos.set(id, (set = new Set()));
		set.add(listener);
		return () => {
			set.delete(listener);
			if (!set.size) this.vivos.delete(id);
		};
	}

	/** Qué hace el agente con un archivo, en vivo (columna Estado: «Analizando… Leyendo «x.pdf»»). */
	private progreso(id: string, archivo: string | undefined, texto: string) {
		this.vivo(id, { tipo: 'progreso', texto, ...(archivo ? { archivo } : {}) });
	}

	private vivo(id: string, e: ImportLiveEvent) {
		for (const listener of this.vivos.get(id) ?? []) {
			try {
				listener(e);
			} catch {
				// Un oyente que truena no detiene la corrida.
			}
		}
	}

	private signal(id: string): AbortSignal {
		let c = this.aborts.get(id);
		if (!c || c.signal.aborted) this.aborts.set(id, (c = new AbortController()));
		return c.signal;
	}

	/** «Detener»: corta lo que hace el cerebro en la corrida (la llamada al modelo, la tool, la cola de eventos). */
	async detener(id: string, ctx: Record<string, unknown> = {}): Promise<{ detenido: boolean }> {
		await this.obtener(id, ctx);
		const c = this.aborts.get(id);
		const activo = Boolean(c && !c.signal.aborted);
		c?.abort(Object.assign(new Error('Detenido por la persona'), { name: 'AbortError', code: 'ABORTED' }));
		await this.options.brain?.detener?.(id);
		this.vivo(id, { tipo: 'detenido', motivo: 'Detenido por la persona' });
		return { detenido: activo };
	}

	/** El staging que armó el cerebro para un destino (§8.3), o `null` si no lleva uno. */
	async stagingDelCerebro(id: string, destino: string, ctx: Record<string, unknown> | null = {}) {
		await this.obtener(id, ctx);
		return (await this.options.brain?.staging?.(this.host(id), destino)) ?? null;
	}

	/** Lo que el cerebro suma al staging que calcula el servidor (emparejar por contenido, cambios pedidos en el chat). */
	async cambiosDelCerebro(id: string, destino: string, ctx: Record<string, unknown> | null = {}) {
		await this.obtener(id, ctx);
		return (await this.options.brain?.cambiosExtra?.(this.host(id), destino)) ?? null;
	}

	/**
	 * Un evento para el cerebro, sin esperar (subida, edición del staging, importación): el cerebro
	 * decide si habla. `analizar` y `chat` no van por aquí (los atiende el agente y espera su respuesta).
	 * Lo usan el agente y el staging (`PUT /runs/:run/staging` → `staging_editado`). Sin cerebro, nada.
	 */
	avisarCerebro(id: string, evento: ImportBrainEvent): void {
		const brain = this.options.brain;
		if (!brain || evento.tipo === 'analizar' || evento.tipo === 'chat') return;
		void brain.manejar(evento, this.host(id)).catch(() => undefined);
	}

	/** Lo que ve el cerebro de una corrida (`ImportBrainHost`). */
	host(id: string): ImportBrainHost {
		const leerRun = async () => {
			const run = await this.options.runs.obtener(id);
			if (!run) throw new NotFoundError(`No existe la corrida ${id}`);
			return run;
		};
		return {
			corrida: id,
			signal: this.signal(id),
			obtener: leerRun,
			config: () => this.config(),
			promptApp: async () => ({ base: PROMPT_BASE, app: this.options.prompt ?? null, contexto: (await this.options.context?.(await leerRun())) || null }),
			tools: () => this.tools(true),
			toolContext: async (archivo) => {
				const run = await leerRun();
				return this.toolContext(run, archivo ? archivoDe(run, archivo) : null);
			},
			esquema: (formato) => this.formato(formato).schema(),
			llave: (formato) => {
				const def = this.formats.get(formato)?.def;
				if (!def?.llave?.length) return llavePorOmision(this.formato(formato).schema());
				const campos = def.llave;
				const plano = (v: unknown) => fold(String(v ?? '')).replace(/[^a-z0-9]+/g, ' ').trim();
				return (fila) => campos.map((f) => plano(fila[f])).join(' | ');
			},
			stagingActual: async (destino) => (await stagingDeCorrida(this, id, destino, null)).set,
			filasActuales: async (formato) => {
				const def = this.formats.get(formato)?.def;
				if (!def?.actuales) return null;
				const run = await leerRun();
				if (def.actuales instanceof SpreadBase) {
					return (await def.actuales.list({ offset: 0, limit: 100_000, sort: null, filters: {}, search: '' }, run.contexto)).rows;
				}
				return [...(await def.actuales({ buscar: '', limite: 100_000 }, run.contexto))];
			},
			leer: async (file) => this.options.storage.read(file.url, (await leerRun()).contexto),
			extraerP: async (file) => this.extraerP(this.toolContext(await leerRun(), file), file),
			renderizar: async (file, paginas) => {
				const bytes = await this.options.storage.read(file.url, (await leerRun()).contexto);
				return (await renderizarPdf(bytes, { paginas })).map((p) => ({ pagina: p.pagina, png: p.png }));
			},
			decir: (texto) => this.decir(id, texto),
			emitir: (e) => this.vivo(id, e),
			basico: {
				analizar: (archivo) => this.analizarBasico(id, archivo),
				chat: async (texto) => (this.options.llm?.chat ? (await this.bucle(id, { mensaje: texto })) || 'Listo.' : 'Anotado: lo tomo en cuenta al analizar.')
			}
		};
	}

	/** Retención: borra las corridas vencidas y sus archivos (si el almacén sabe listar todas y borrar). */
	async purgar(): Promise<number> {
		const runs = await this.options.runs.listar({ limite: 10_000 });
		let n = 0;
		for (const run of runs) {
			if (Date.parse(run.expira) > Date.now() || !this.options.runs.borrar) continue;
			for (const f of run.archivos) await this.options.storage.remove?.(f.url, run.contexto).catch(() => undefined);
			await this.options.runs.borrar(run.id);
			n++;
		}
		return n;
	}
}

// -- vistas y utilidades -------------------------------------------------------------------

export function archivoDe(run: ImportRun, ref: string): ImportRunFile {
	const file = run.archivos.find((f) => f.id === ref) ?? run.archivos.find((f) => f.nombre === ref);
	if (!file) throw new NotFoundError(`No existe el archivo ${ref} en la corrida`);
	return file;
}

export function vistaArchivo(f: ImportRunFile): ImportRunFileView {
	const { filas, issues, derivados, ...rest } = f;
	return {
		...rest,
		totalFilas: filas.length,
		totalErrores: new Set(issues.filter((i) => i.level === 'error').map((i) => i.row ?? -1)).size,
		totalAvisos: issues.filter((i) => i.level !== 'error').length,
		derivados: derivados.map(({ nombre, tipo }) => ({ nombre, tipo }))
	};
}

export function vista(run: ImportRun): ImportRunView {
	return { ...run, archivos: run.archivos.map(vistaArchivo) };
}

function describirDestino(f: ImportRunFile): string {
	const d = f.destino;
	const fixed = f.destinoFijadoPorUsuario ? ' (fijado por la persona: no lo cambies)' : '';
	if (!d) return 'sin elegir';
	if (d.tipo === 'filas') return `filas del formato «${d.formato}», modo ${d.modo}${fixed}`;
	if (d.tipo === 'adjuntar') return `adjuntar a «${d.adjunto}»${d.tabla ? ` · ${d.tabla}` : ''}${d.fila ? ` · fila ${d.fila}` : ''}${fixed}`;
	return `descartar${d.motivo ? ` (${d.motivo})` : ''}${fixed}`;
}

/** Nombre para guardar: sin acentos, signos ni rutas, con su extensión (como `safeFileName` de SB-30). */
function storageName(nombre: string): string {
	const ext = extensionOf(nombre);
	const base = nombre
		.replace(/\.[^.]*$/, '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '')
		.slice(0, 80);
	return `${base || 'archivo'}${ext ? `.${ext}` : ''}`;
}

function resumenArchivo(f: ImportRunFile): string {
	if (f.destino?.tipo === 'filas') return `${f.filas.length} filas para ${f.destino.formato}`;
	if (f.destino?.tipo === 'descartar') return `Descartado${f.destino.motivo ? `: ${f.destino.motivo}` : ''}`;
	if (f.destino?.tipo === 'adjuntar') return 'Se adjunta';
	return 'Sin destino';
}

/** Antes de analizar: la corrida es nueva y ningún archivo pasó del análisis. */
function antesDeAnalizar(run: ImportRun): boolean {
	return run.estado === 'nueva' && run.archivos.every((f) => f.estado === 'pendiente');
}

/** El primer mensaje del chat (momento 0): qué hace, que las instrucciones van aquí y los destinos. */
export function bienvenidaBase(destinos: ImportDestinationOption[]): string {
	const modos = { upsert: 'actualizar o agregar', replace: 'reemplazar todo' } as const;
	const lista = destinos
		.map((d) =>
			d.tipo === 'filas'
				? `• Filas → ${d.label} (${d.modos.map((m) => modos[m]).join(', ')})`
				: d.tipo === 'adjuntar'
					? `• Adjuntar → ${d.label}`
					: `• ${d.label}`
		)
		.join('\n');
	return [
		'Hola, soy el asistente de importación. Suelta archivos o carpetas (PDF, fotos, Excel, CSV, zip): leo cada uno, propongo a dónde va y reviso sus filas antes de importar nada.',
		'Las instrucciones generales me las das aquí, en el chat. Por ejemplo: «los planes de octubre reemplazan a los de septiembre» o «ignora los seminuevos». Las tomo en cuenta al analizar.',
		`Destinos posibles:\n${lista}`
	].join('\n\n');
}

/** Une las filas idénticas en todo (se queda la primera). */
export function colapsarIdenticas(filas: Record<string, CellValue>[]): { filas: Record<string, CellValue>[]; unidas: number } {
	const seen = new Set<string>();
	const out: Record<string, CellValue>[] = [];
	for (const row of filas) {
		const key = JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k] ?? null]));
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(row);
	}
	return { filas: out, unidas: filas.length - out.length };
}

/**
 * «Repetido: igual que la fila N» (misma llave): ya no son idénticas, así que
 * el mensaje nombra las dos filas y en qué difieren.
 */
export function explicarRepetidas(issues: ImportIssue[], filas: Record<string, CellValue>[], columns: Record<string, { label: string; from?: string }>): ImportIssue[] {
	const show = (v: CellValue | undefined) => (v === null || v === undefined || v === '' ? 'vacío' : String(v));
	return issues.map((issue) => {
		const other = /(repetid|duplicad)/i.test(issue.message) ? /fila\s+(\d+)/i.exec(issue.message) : null;
		if (issue.level !== 'error' || issue.row === null || !other) return issue;
		const a = filas[Number(other[1]) - 1];
		const b = filas[issue.row];
		if (!a || !b) return issue;
		const diffs = Object.entries(columns)
			.filter(([field, c]) => c.from !== 'form' && show(a[field]) !== show(b[field]))
			.map(([field, c]) => `${c.label} (${show(a[field])} ≠ ${show(b[field])})`);
		if (!diffs.length) return issue;
		return { ...issue, message: `Misma llave que la fila ${other[1]} pero difieren en ${diffs.slice(0, 4).join(', ')}${diffs.length > 4 ? '…' : ''}` };
	});
}

/** Crea el agente importador (SB-36). */
export const importAgent = (options: ImportAgentOptions) => new ImportAgent(options);

export { resumenExtraccion };
