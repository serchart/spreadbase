/**
 * El contrato del asistente de importación (SB-36): la corrida, sus archivos,
 * el chat y lo que viaja por HTTP entre `importAssistantRoutes` (server) y el
 * asistente del cliente. Vive en core porque lo usan los dos lados.
 *
 * Los nombres van en español, como en la especificación de la corrida: es un
 * documento que la app guarda (`ImportRunStore`) y que también lee una persona.
 */
import type { CellValue } from './values.ts';
import type { ImportIssue, ImportSchema } from './imports.ts';

/** A dónde va un archivo. */
export type ImportDestination =
	/** Sus filas, a un formato SB-34. `replace` se bloquea con cualquier error; `upsert` publica las buenas. */
	| { tipo: 'filas'; formato: string; modo: 'upsert' | 'replace' }
	/** El archivo (y lo que se derive de él), adjunto donde diga la app: una fila, un folder… */
	| { tipo: 'adjuntar'; adjunto: string; tabla?: string; fila?: string; campo?: string; [k: string]: unknown }
	| { tipo: 'descartar'; motivo?: string };

export type ImportRunStatus = 'nueva' | 'analizando' | 'lista' | 'importando' | 'terminada';
export type ImportFileStatus = 'pendiente' | 'en_cola' | 'analizando' | 'analizado' | 'importando' | 'importado' | 'error';

/** Lo que pasó al importar un archivo. */
export interface ImportFileResult {
	status: 'ok' | 'parcial' | 'error';
	/** Filas publicadas (o 1 si se adjuntó). */
	ok: number;
	/** Filas que se quedaron con su error en la corrida. */
	error: number;
	mensaje?: string;
	/** Lo que devolvió `apply` o `attach`. */
	resumen?: Record<string, unknown>;
}

/** Un archivo derivado que produjo el agente (ej. `ficha.md`), para adjuntar junto al original. */
export interface ImportDerived {
	nombre: string;
	tipo: string;
	contenido: string;
}

export interface ImportRunFile {
	id: string;
	nombre: string;
	/** Tipo real (por el contenido): `application/pdf`, `image/png`… */
	tipo: string;
	/** Ruta dentro de la carpeta o el zip de donde salió (`imagenesSeptiembre/fotos`), o `null`. */
	carpeta: string | null;
	url: string;
	tamano: number;
	estado: ImportFileStatus;
	/** Texto corto para la columna Análisis («57 planes de 6 modelos, 4 ramas»). */
	analisis: string | null;
	destino: ImportDestination | null;
	/** La persona lo fijó: el agente no lo cambia. */
	destinoFijadoPorUsuario: boolean;
	/** Instrucción de la persona para este archivo («solo págs. 2–7»), además de las de la corrida. */
	instruccion: string | null;
	/** Filas propuestas para un destino `filas` (las columnas del formato). */
	filas: Record<string, CellValue>[];
	/** Los datos del formulario del formato (columnas `form`/`either`): un valor para todas las filas. */
	campos: Record<string, CellValue>;
	/** Lo que encontró `review` (SB-34): `row` es la posición en `filas`. */
	issues: ImportIssue[];
	/** El `summary` del último `review`. */
	resumen: Record<string, unknown> | null;
	derivados: ImportDerived[];
	resultado: ImportFileResult | null;
	/** Un fallo del análisis o de la importación. */
	error: string | null;
}

export interface ImportChatMessage {
	id: string;
	rol: 'usuario' | 'agente' | 'sistema';
	texto: string;
	fecha: string;
}

export interface ImportRun {
	id: string;
	/** Lo que la app quiera guardar de quién y dónde (cuenta, tabla de origen, usuario). */
	contexto: Record<string, unknown>;
	/** De quién es la corrida (para listar y para que nadie más la abra). */
	propietario: string | null;
	instrucciones: string;
	archivos: ImportRunFile[];
	chat: ImportChatMessage[];
	estado: ImportRunStatus;
	/**
	 * El staging por destino (formato), §8.3: las ediciones de la persona
	 * (`PUT /runs/:run/staging`) y, al importar, lo que se guardó en la hoja.
	 */
	staging?: Record<string, ImportStagingState>;
	/**
	 * La importación en curso (o la última): qué destinos de staging pidió la
	 * persona (`null` = todo, «Importar todo») y qué archivos entraron. Con un
	 * solo destino, la corrida vuelve a `lista` mientras falten otros (§10).
	 */
	importacion?: { destinos: string[] | null; archivos: string[] } | null;
	/** Sube con cada cambio: el almacén lo usa para no pisar escrituras concurrentes. */
	version: number;
	creada: string;
	actualizada: string;
	/** Después de esto, la app puede borrarla (retención). */
	expira: string;
}

/** Un archivo en la vista de la corrida: sin sus filas (van aparte), con cuántas y cuántos errores. */
export type ImportRunFileView = Omit<ImportRunFile, 'filas' | 'issues' | 'derivados'> & {
	totalFilas: number;
	totalErrores: number;
	totalAvisos: number;
	derivados: { nombre: string; tipo: string }[];
};

/** `GET /runs/:id`: la corrida sin las filas de cada archivo. */
export type ImportRunView = Omit<ImportRun, 'archivos'> & { archivos: ImportRunFileView[] };

/** Un destino que se puede elegir, en `GET /config`. */
export type ImportDestinationOption =
	| {
			tipo: 'filas';
			formato: string;
			label: string;
			description: string | null;
			modos: ('upsert' | 'replace')[];
			modo: 'upsert' | 'replace';
			/** La URL de la hoja de la tabla destino (para abrir el staging sobre ella), si la app la dio. */
			sheetUrl?: string | null;
	  }
	| {
			tipo: 'adjuntar';
			adjunto: string;
			label: string;
			description: string | null;
			/** El archivo va a esta columna de la fila que empareja (SB-38), en el staging del formato. */
			columna?: { formato: string; campo: string } | null;
	  }
	| { tipo: 'descartar'; label: string };

export interface ImportLimits {
	/** Tamaño máximo de un archivo, en MB. Default: 50. */
	maxArchivoMB: number;
	/** Suma de los archivos de una corrida, en MB. Default: 200. */
	maxLoteMB: number;
	/** Días que se guarda una corrida. Default: 30. */
	retencionDias: number;
	/** Extensiones aceptadas. Default: pdf, png, jpg, jpeg, webp, heic, xlsx, csv, txt, json, md, docx, zip. */
	tipos: string[];
}

/** `GET /config`: qué destinos hay, los límites y el primer mensaje del chat. */
export interface ImportAssistantConfig {
	destinos: ImportDestinationOption[];
	limites: ImportLimits;
	/**
	 * El primer mensaje del agente, en el momento 0 (sin LLM): qué hace, que las
	 * instrucciones generales van en el chat y qué destinos hay. Lo arma el
	 * servidor (la app puede poner el suyo con `bienvenida`).
	 */
	bienvenida: string;
}

/** `GET /runs/:id/files/:file/rows`: las filas de un archivo con su detalle, para abrirlas como hoja. */
export interface ImportFileRows {
	archivo: ImportRunFileView;
	/** El esquema del formato destino, si el destino es `filas`. */
	schema: ImportSchema | null;
	filas: Record<string, CellValue>[];
	issues: ImportIssue[];
	resumen: Record<string, unknown> | null;
}

/** `POST /runs/:id/chat`. */
export interface ImportChatResponse {
	mensaje: ImportChatMessage;
	corrida: ImportRunView;
}

/** Avisos de progreso (`onEvent`): la app los manda por socket, WhatsApp… */
export interface ImportRunEvent {
	corrida: string;
	tipo: 'corrida' | 'archivo' | 'chat';
	estado?: ImportRunStatus | ImportFileStatus;
	archivo?: string;
	mensaje?: string;
	resultado?: ImportFileResult;
	/** Al terminar de importar: los conteos de toda la corrida. */
	totales?: { ok: number; error: number; archivos: number };
}

// ---------------------------------------------------------------------------
// Staging (§8.3 de `05-asistente-importacion.md`): la tabla destino con los
// cambios de toda la corrida. Lo comparten el servidor (que lo calcula, o el
// agente que lo escribe) y el cliente (que lo aplica como pendientes en la
// hoja real).

/** De dónde salió un valor: para «¿por qué pusiste esto?» y para saltar al documento. */
export interface ImportOrigin {
	/** Id del archivo de la corrida. */
	archivo: string;
	pagina?: number;
	bloque?: string;
	/** Posición de la fila en lo que propuso ese archivo. */
	fila?: number;
	nota?: string;
}

/**
 * Un cambio sobre la tabla destino, por llave (la llave del formato, o la del
 * destino: `llave`). `update` y `delete` traen además `id`, el id de la fila
 * en la hoja de la tabla destino (su `idField`), para aplicarlo en ella.
 */
export type ImportChange =
	| { op: 'insert'; key: string; valores: Record<string, unknown>; origen: ImportOrigin[] }
	| { op: 'update'; key: string; id?: string; campos: Record<string, { antes: unknown; despues: unknown; origen: ImportOrigin[] }> }
	/** Solo con `replace` (lo que existe y no viene) o si la persona lo pide. */
	| { op: 'delete'; key: string; id?: string; motivo: string };

/** `GET /runs/:run/staging?destino=`: lo que la importación haría en la tabla destino. */
export interface ImportChangeSet {
	/** Id del formato / tabla. */
	destino: string;
	modo: 'upsert' | 'replace';
	/** La tabla destino al calcularlo. */
	base: { version?: unknown; filas: number };
	cambios: ImportChange[];
	problemas: { key: string; campo?: string; nivel: 'error' | 'aviso'; mensaje: string }[];
	sinEmparejar: { archivo: string; motivo: string }[];
	resumen: { insert: number; update: number; delete: number; errores: number; avisos: number };
}

/** Lo que la corrida guarda del staging de un destino. */
export interface ImportStagingState {
	/**
	 * Los cambios como los dejó la persona (o `null`). Valen mientras los
	 * archivos no cambien (`firma`): si el agente rehace un análisis, se vuelve
	 * a calcular desde los archivos.
	 */
	cambios: ImportChange[] | null;
	firma: string | null;
	editado: string | null;
	/** Al importar: la hoja ya se guardó con estos cambios. */
	publicado: {
		fecha: string;
		resumen: { insert: number; update: number; delete: number };
		/** Los archivos que iban a una columna y no emparejaron con ninguna fila: no se guardaron. */
		sinEmparejar?: { archivo: string; motivo: string }[];
	} | null;
}

/** `PUT /runs/:run/staging`: las ediciones de la persona sobre el staging de un destino, o el error al guardarlo. */
export interface ImportStagingEdit {
	destino: string;
	cambios?: ImportChange[];
	/** No se pudo guardar la hoja: el agente lo dice en el chat. */
	error?: { mensaje: string; problemas?: { key?: string; campo?: string; mensaje: string }[] };
}
