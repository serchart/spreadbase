/**
 * Lo que la app conecta al agente importador (SB-36). Mismo principio que la
 * fuente de datos (SB-2): **el LLM, el almacenamiento, la persistencia de la
 * corrida y la cola son de la app**; SpreadBase define estas interfaces, el
 * flujo y las rutas, y trae una versión en memoria / en proceso de cada una.
 */
import type {
	CellValue,
	ImportDerived,
	ImportDestination,
	ImportDestinationOption,
	ImportLimits,
	ImportRun,
	ImportRunEvent,
	ImportRunFile
} from '@spreadbase/core';
import type { ImportFormat } from '../imports.ts';
import type { SpreadBase } from '../SpreadBase.ts';
import type { ImportLLM, JsonSchema } from '../extraction/llm.ts';
import type { ImportFileStorage } from './files.ts';
import type { ImportBrain } from './brain/types.ts';

type MaybePromise<T> = T | Promise<T>;

/** Dónde se guardan las corridas. `memoryRunStore()` en memoria; Aggy, en Mongo. */
export interface ImportRunStore {
	crear(run: ImportRun): Promise<void>;
	obtener(id: string): Promise<ImportRun | null>;
	/**
	 * Guarda la corrida solo si nadie la cambió desde que se leyó (su `version`
	 * guardada es `versionLeida`). Devuelve `false` si alguien se adelantó: el
	 * agente la vuelve a leer y reaplica su cambio. Con Mongo:
	 * `replaceOne({ _id, version: versionLeida }, run)`.
	 */
	guardar(run: ImportRun, versionLeida: number): Promise<boolean>;
	listar(filtro: { propietario?: string | null; limite?: number }): Promise<ImportRun[]>;
	/** Retención: borrar las vencidas. Opcional. */
	borrar?(id: string): Promise<void>;
}

/** Un trabajo de la cola: analizar o importar un archivo de una corrida. */
export interface ImportJob {
	tipo: 'analizar' | 'importar';
	corrida: string;
	archivo: string;
}

/**
 * La cola. `inProcessRunner()` corre los trabajos en el mismo proceso; Aggy
 * pone su worker: `encolar` lo mete en su cola y su worker llama a
 * `agente.procesar(trabajo)`.
 */
export interface ImportRunner {
	/** El agente le da, una vez, con qué procesar cada trabajo (solo lo usan las colas en proceso). */
	iniciar?(procesar: (trabajo: ImportJob) => Promise<void>): void;
	encolar(trabajo: ImportJob): MaybePromise<void>;
}

/** Lo que recibe el `attach` de un destino `adjuntar`. */
export interface ImportAttachInput {
	destino: Extract<ImportDestination, { tipo: 'adjuntar' }>;
	archivo: Pick<ImportRunFile, 'id' | 'nombre' | 'tipo' | 'carpeta' | 'url' | 'tamano'>;
	/** Lo que extrajo el agente para ese destino (atributos de una ficha), si lo hay. */
	filas: Record<string, CellValue>[];
	derivados: ImportDerived[];
	corrida: ImportRun;
	contexto: Record<string, unknown>;
}

/** Destinos que puede elegir el agente (o la persona). */
export type ImportAgentDestination =
	| {
			tipo: 'filas';
			formato: ImportFormat;
			/** Modos que admite. Default: los dos. */
			modos?: ('upsert' | 'replace')[];
			/** Modo por omisión. Default: `upsert`. */
			modo?: 'upsert' | 'replace';
			/**
			 * Lo que ya hay en la tabla destino, para que el agente complemente y
			 * compare (`leerFilasActuales`): la hoja de esa tabla o una función.
			 */
			actuales?: SpreadBase | ((q: { buscar: string; limite: number }, ctx: Record<string, unknown>) => MaybePromise<Record<string, unknown>[]>);
			/**
			 * Los campos que identifican una fila en el staging (§8.3.1): se compara
			 * por ellos contra la tabla actual. Default: la `key` del formato o sus
			 * columnas de texto obligatorias.
			 */
			llave?: string[];
			/**
			 * La URL de la hoja de la tabla destino, para que el cliente abra el
			 * staging sobre ella (`GET /config`). Absoluta o relativa a la base de
			 * `importAssistantRoutes` (`'planes'` → `<base>/planes`).
			 */
			sheetUrl?: string;
	  }
	| {
			tipo: 'adjuntar';
			/** Identifica este destino (`{ tipo: 'adjuntar', adjunto: id }`). */
			id: string;
			label: string;
			description?: string;
			/**
			 * El archivo va a una columna de un formato (`IMAGE`, `FILE`, `FOLDER` o
			 * texto, SB-38): en el staging, la fila que empareja por nombre (los
			 * campos de `emparejar`, default la llave del destino) recibe el archivo
			 * como `update`. Se guarda con la hoja; `attach` no hace falta.
			 */
			columna?: { formato: string; campo: string; emparejar?: string[] };
			/** Hacerlo: guardar el archivo donde diga `destino` (una fila, un folder). Opcional con `columna`. */
			attach?(input: ImportAttachInput): MaybePromise<{ resumen?: Record<string, unknown> } | void>;
	  }
	| { tipo: 'descartar'; label?: string };

/** Lo que recibe una tool al ejecutarse. */
export interface ImportToolContext {
	corrida: ImportRun;
	/** El archivo sobre el que trabaja (el que se analiza, o el que nombró el modelo en `archivo`). */
	archivo: ImportRunFile | null;
	contexto: Record<string, unknown>;
	/** Los bytes de un archivo de la corrida. */
	leer(archivo: ImportRunFile): Promise<Uint8Array>;
}

/** Una tool: la ve el modelo (nombre, descripción, parámetros) y la ejecuta el agente. */
export interface ImportTool {
	nombre: string;
	descripcion: string;
	parametros: JsonSchema;
	ejecutar(args: Record<string, unknown>, ctx: ImportToolContext): MaybePromise<unknown>;
}

export interface ImportAgentOptions {
	/** El modelo de la app (SB-2: es de la app). Sin `chat`, el agente analiza con reglas. */
	llm?: ImportLLM;
	/** Nombre del modelo, para el adaptador (`gemini-3.8-flash`…). */
	model?: string;
	/** Instrucciones de la app o de la cuenta: se suman al prompt base. */
	prompt?: string;
	/**
	 * El primer mensaje del chat (momento 0, sin LLM), en `GET /config`. Texto
	 * fijo o una función que recibe los destinos. Default: qué hace el
	 * asistente, que las instrucciones generales van en el chat y los destinos.
	 */
	bienvenida?: string | ((destinos: ImportDestinationOption[]) => string);
	destinations: ImportAgentDestination[];
	/** Más contexto para el modelo, por corrida (resumen de la tabla destino, filas del mes anterior). */
	context?: (run: ImportRun) => MaybePromise<string>;
	/** Tools de la app (consultar otro sistema); se suman a las base. */
	tools?: ImportTool[];
	runs: ImportRunStore;
	/** Default: `inProcessRunner()`. */
	runner?: ImportRunner;
	storage: ImportFileStorage;
	limits?: Partial<ImportLimits>;
	/** Vueltas máximas del bucle por análisis (o por mensaje del chat). Default: 12. */
	maxIteraciones?: number;
	/** Páginas máximas que se mandan al método X por archivo. Default: 30. */
	maxPaginasX?: number;
	/** De quién es una corrida, por el contexto de la petición (el usuario). Sin esto, todas de nadie. */
	owner?: (ctx: Record<string, unknown>) => string | null;
	/** Avisos de progreso: la app los manda por socket, WhatsApp… */
	onEvent?: (event: ImportRunEvent) => void;
	/**
	 * El cerebro (fase B, `docs/05` §9): quién atiende los eventos de la corrida —analizar, chat,
	 * subidas, ediciones, importación— en un solo hilo por corrida. Sin él, el agente de siempre
	 * (`cerebroBasico`). El fuerte vive fuera de la librería (servicio privado) y se enchufa aquí.
	 */
	brain?: ImportBrain;
	/**
	 * Cuánto esperar, tras la última edición del staging (`PUT /runs/:run/staging`), para avisarle al
	 * cerebro (`staging_editado`): las ediciones seguidas se agrupan en un solo aviso. Default: 2 000 ms.
	 */
	esperaEdicionMs?: number;
}
