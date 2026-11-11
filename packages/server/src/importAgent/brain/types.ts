/**
 * El cerebro del asistente de importación (fase B, `docs/05-asistente-importacion.md` §7.2, §8.6 y §9).
 *
 * La librería define **la interfaz** y trae el agente actual como cerebro por omisión
 * (`cerebroBasico`, el bucle de `importAgent` de siempre). Un cerebro fuerte —un hilo por corrida con
 * memoria, reglas verificadas, staging y eventos en vivo— lo da la app, fuera de la librería, y se
 * enchufa con `importAgent({ brain })`. La librería no depende de ningún proveedor de modelos.
 *
 * El agente sigue siendo dueño de la corrida, la cola, el `review`, los veredictos sin LLM y la
 * importación. El cerebro decide **qué hacer con cada evento** de la corrida: analizar archivos,
 * contestar el chat, reaccionar a ediciones e importaciones. Lo hace con las mismas tools base (por
 * `host.tools()`), así que lo que deja en los archivos (filas, destino, análisis) se ve igual en la
 * interfaz.
 */
import type {
	ImportAssistantConfig,
	ImportChangeSet,
	ImportRun,
	ImportRunEvent,
	ImportRunFile,
	ImportSchema
} from '@spreadbase/core';
import type { Extraccion } from '../../extraction/types.ts';
import type { ImportTool, ImportToolContext } from '../types.ts';
import type { StagingExtra } from './staging.ts';

/** Lo que le pasa a la corrida y el cerebro atiende. Todos llevan la corrida en `host.corrida`. */
export type ImportBrainEvent =
	/** La persona subió archivos (aún sin analizar). El cerebro decide si dice algo. */
	| { tipo: 'archivos_subidos'; archivos: string[] }
	/** La cola pide analizar un archivo. Al resolver, el archivo debe tener análisis (y destino si lo hay). */
	| { tipo: 'analizar'; archivo: string }
	/** Un mensaje de la persona en el chat. La respuesta la publica el agente. */
	| { tipo: 'chat'; texto: string }
	/** La persona editó el staging o las filas de un archivo. */
	| { tipo: 'staging_editado'; archivo?: string; destino?: string; resumen: string }
	/**
	 * Terminó (o falló) una importación. `destinos`: los stagings que se importaron (por su formato);
	 * sin él, toda la corrida. Con un solo destino, la corrida sigue abierta mientras falten otros.
	 */
	| { tipo: 'importacion_terminada'; resumen: string; destinos?: string[] };

/** Lo que devuelve el cerebro al atender un evento. */
export interface ImportBrainReply {
	/** Para `chat`: el texto con que contesta (el agente lo publica). */
	respuesta?: string;
	/** Cuánto costó atender el evento (USD), si el cerebro lo mide. */
	costoUsd?: number;
}

/**
 * Eventos en vivo de una corrida (`GET /runs/:run/events`, SSE). El texto del chat llega por partes
 * mientras se escribe; el progreso dice qué hace el agente con cada archivo.
 */
export type ImportLiveEvent =
	| { tipo: 'texto'; delta: string }
	| { tipo: 'texto_fin'; texto: string }
	| { tipo: 'progreso'; texto: string; archivo?: string }
	| { tipo: 'herramienta'; fase: 'inicio' | 'fin'; nombre: string; archivo?: string; ok?: boolean; ms?: number }
	| { tipo: 'costo'; usd: number; totalUsd: number; vueltas?: number; ms?: number; motivo?: string }
	| { tipo: 'detenido'; motivo: string }
	| { tipo: 'corrida'; evento: ImportRunEvent };

/**
 * Lo que el agente le da al cerebro por corrida. Todo se lee fresco (la corrida cambia mientras el
 * cerebro trabaja: la persona fija destinos, otro archivo termina…).
 */
export interface ImportBrainHost {
	readonly corrida: string;
	/** Se aborta con «Detener» (`POST /runs/:run/stop`). Cambia tras cada detención: léelo por evento. */
	readonly signal: AbortSignal;
	obtener(): Promise<ImportRun>;
	config(): ImportAssistantConfig;
	/** El prompt de la app (`importAgent({ prompt })`) y el contexto por corrida (`context(run)`). */
	promptApp(): Promise<{ base: string; app: string | null; contexto: string | null }>;
	/** Las tools base y las de la app, listas para ejecutarse sobre la corrida. */
	tools(): ImportTool[];
	/** El contexto de una tool: la corrida al día y el archivo por omisión (o ninguno). */
	toolContext(archivo?: string | null): Promise<ImportToolContext>;
	esquema(formato: string): ImportSchema;
	/** La llave con que el staging compara las filas de un formato (§8.3.1). */
	llave(formato: string): (fila: Record<string, unknown>) => string;
	/** El staging de un destino tal como lo verá la persona (`GET /runs/:run/staging`). */
	stagingActual(destino: string): Promise<ImportChangeSet>;
	/** Todas las filas actuales de la tabla destino de un formato (para el staging), o `null` si la app no las expone. */
	filasActuales(formato: string): Promise<Record<string, unknown>[] | null>;
	/** Los bytes de un archivo de la corrida. */
	leer(archivo: ImportRunFile): Promise<Uint8Array>;
	/** Método P (en caché por archivo). */
	extraerP(archivo: ImportRunFile): Promise<Extraccion>;
	/** Páginas de un PDF dibujadas a PNG (visión). */
	renderizar(archivo: ImportRunFile, paginas: number[]): Promise<{ pagina: number; png: Buffer }[]>;
	/** Un mensaje del agente en el chat (sin LLM de por medio). */
	decir(texto: string): Promise<void>;
	/** Un evento en vivo para quien escucha la corrida (SSE). */
	emitir(evento: ImportLiveEvent): void;
	/** El agente de siempre, para el cerebro básico o como respaldo. */
	basico: {
		analizar(archivo: string): Promise<void>;
		chat(texto: string): Promise<string>;
	};
}

/** Un cerebro del asistente. Atiende los eventos de cada corrida; puede llevar estado por corrida. */
export interface ImportBrain {
	readonly nombre: string;
	manejar(evento: ImportBrainEvent, host: ImportBrainHost): Promise<ImportBrainReply | void>;
	/**
	 * El staging que armó el cerebro para un destino (§8.3), si lleva el suyo (cambios por
	 * emparejamiento además de las filas de cada archivo). `null`: que lo calcule el servidor.
	 */
	staging?(host: ImportBrainHost, destino: string): Promise<ImportChangeSet | null>;
	/**
	 * Cambios del cerebro que se SUMAN al staging que calcula el servidor: emparejamientos por
	 * contenido (no por nombre) y cambios que la persona pidió en el chat. `null`: ninguno.
	 */
	cambiosExtra?(host: ImportBrainHost, destino: string): Promise<{ extra: StagingExtra[]; sinEmparejar: { archivo: string; motivo: string }[] } | null>;
	/** Detener lo que esté haciendo en la corrida (además del `signal` del host). */
	detener?(corrida: string): Promise<void> | void;
	/** La corrida se borró: soltar su estado. */
	olvidar?(corrida: string): void;
}
