/**
 * Las tools base del agente importador (SB-36). El modelo las ve por nombre,
 * descripción y parámetros; las ejecuta el agente sobre la corrida. Todas
 * aceptan `archivo` (id o nombre) para trabajar sobre otro archivo que el que
 * se analiza (en el chat no hay uno por omisión).
 */
import type { CellValue, ImportDestination, ImportRunFile } from '@spreadbase/core';
import type { Extraccion } from '../extraction/types.ts';
import type { MapeoOpciones } from './mapping.ts';
import type { ImportTool, ImportToolContext } from './types.ts';

/** Lo que las tools necesitan del agente. */
export interface Kernel {
	destinos(): unknown;
	esquema(formato: string): unknown;
	extraerP(ctx: ImportToolContext, archivo: ImportRunFile, paginas?: number[]): Promise<Extraccion>;
	extraerX(ctx: ImportToolContext, archivo: ImportRunFile, paginas?: number[], formato?: string): Promise<Extraccion>;
	extraccion(archivo: ImportRunFile, metodo: 'P' | 'X'): Extraccion | undefined;
	comparar(archivo: ImportRunFile): unknown;
	mapear(archivo: ImportRunFile, formato: string, metodo: 'P' | 'X', bloques: number[], opciones: MapeoOpciones): unknown;
	proponer(
		ctx: ImportToolContext,
		archivo: ImportRunFile,
		args: { formato: string; modo?: 'upsert' | 'replace'; filas?: Record<string, unknown>[]; agregar?: boolean; campos?: Record<string, CellValue> }
	): Promise<unknown>;
	editar(ctx: ImportToolContext, archivo: ImportRunFile, args: EditarArgs): Promise<unknown>;
	revisar(ctx: ImportToolContext, archivo: ImportRunFile): Promise<unknown>;
	actuales(ctx: ImportToolContext, formato: string, buscar: string, limite: number): Promise<unknown>;
	derivar(ctx: ImportToolContext, archivo: ImportRunFile, nombre: string, contenido: string, tipo: string): Promise<unknown>;
	destinar(ctx: ImportToolContext, archivo: ImportRunFile, destino: ImportDestination): Promise<unknown>;
	terminar(ctx: ImportToolContext, archivo: ImportRunFile, analisis: string, destino?: ImportDestination): Promise<unknown>;
}

export interface EditarArgs {
	quitar?: number[];
	quitarSi?: { campo: string; contiene?: string; igual?: unknown };
	cambiar?: { fila: number; campo: string; valor: CellValue }[];
	agregar?: Record<string, unknown>[];
}

const archivoParam = { type: 'string', description: 'Id o nombre del archivo. Default: el que se analiza.' };
const DESTINO = {
	type: 'object',
	description: '{ tipo: "filas", formato, modo: "upsert"|"replace" } | { tipo: "adjuntar", adjunto, tabla?, fila?, campo? } | { tipo: "descartar", motivo }',
	properties: {
		tipo: { type: 'string', enum: ['filas', 'adjuntar', 'descartar'] },
		formato: { type: 'string' },
		modo: { type: 'string', enum: ['upsert', 'replace'] },
		adjunto: { type: 'string' },
		tabla: { type: 'string' },
		fila: { type: 'string' },
		campo: { type: 'string' },
		motivo: { type: 'string' }
	},
	required: ['tipo']
};

/** El archivo de la llamada: el que nombra `archivo`, o el que se analiza. */
function target(args: Record<string, unknown>, ctx: ImportToolContext): ImportRunFile {
	const ref = typeof args.archivo === 'string' ? args.archivo : null;
	const file = ref ? ctx.corrida.archivos.find((f) => f.id === ref || f.nombre === ref) : ctx.archivo;
	if (!file) throw new Error(ref ? `No hay un archivo «${ref}» en la corrida` : 'Falta `archivo`: di sobre qué archivo trabajar');
	return file;
}

const numbers = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n)) : undefined);
const metodo = (v: unknown): 'P' | 'X' => (v === 'X' ? 'X' : 'P');

/**
 * La extracción en corto que cabe en una respuesta de tool: con 5 filas de
 * muestra por bloque, o menos si el documento es grande (24 páginas de tablas
 * no caben con muestra: quedan los encabezados y el total; el detalle, con
 * verBloque).
 */
export function resumenAcotado(e: Extraccion, paginas?: number[]) {
	for (const filas of [5, 2, 0]) {
		const r = resumenExtraccion(e, filas, paginas);
		if (JSON.stringify(r).length <= 25_000 || filas === 0) return r;
	}
	return resumenExtraccion(e, 0, paginas);
}

/**
 * Una extracción en corto para el modelo: cada bloque con sus primeras filas.
 * `indice` es la posición en la extracción completa (la que usan verBloque y
 * mapearTabla), aunque se pidan solo algunas páginas.
 */
export function resumenExtraccion(e: Extraccion, filas = 5, paginas?: number[]) {
	return {
		archivo: e.archivo,
		bloques: e.bloques.map((b, indice) => ({ b, indice })).filter(({ b }) => !paginas?.length || paginas.includes(b.pagina)).map(({ b, indice }) => ({
			indice,
			pagina: b.pagina,
			tipo: b.tipo,
			...(b.titulo ? { titulo: b.titulo } : {}),
			...(b.encabezados ? { encabezados: b.encabezados } : {}),
			...(b.filas ? { totalFilas: b.filas.length, ...(filas ? { filas: b.filas.slice(0, filas) } : {}) } : {}),
			...(b.contenido ? { contenido: b.contenido.length > 600 ? `${b.contenido.slice(0, 600)}…` : b.contenido } : {}),
			...(b.confianza !== undefined ? { confianza: b.confianza } : {})
		})),
		...(e.avisos?.length ? { avisos: e.avisos } : {})
	};
}

export function baseTools(k: Kernel, opciones: { conX: boolean }): ImportTool[] {
	const tools: ImportTool[] = [
		{
			nombre: 'leerDestino',
			descripcion: 'Sin formato: los destinos posibles. Con formato: sus columnas (tipo, obligatoria, otros nombres, opciones), su llave y descripción.',
			parametros: { type: 'object', properties: { formato: { type: 'string' } } },
			ejecutar: (args) => (typeof args.formato === 'string' ? k.esquema(args.formato) : k.destinos())
		},
		{
			nombre: 'extraerDeterminista',
			descripcion:
				'Método P: lee el archivo sin LLM (PDF con capa de texto: tablas por alineación; Excel/CSV: cada hoja; texto). Devuelve los bloques con sus primeras filas; el detalle, con verBloque.',
			parametros: { type: 'object', properties: { archivo: archivoParam, paginas: { type: 'array', items: { type: 'integer' } } } },
			ejecutar: async (args, ctx) => resumenAcotado(await k.extraerP(ctx, target(args, ctx)), numbers(args.paginas))
		},
		{
			nombre: 'compararExtracciones',
			descripcion: 'Cruza P y X del archivo celda por celda: dónde no coinciden (artefactos de la capa de texto o errores de lectura).',
			parametros: { type: 'object', properties: { archivo: archivoParam } },
			ejecutar: (args, ctx) => k.comparar(target(args, ctx))
		},
		{
			nombre: 'verBloque',
			descripcion: 'Las filas de un bloque de una extracción (P o X), de `desde` a `hasta` (máx. 100).',
			parametros: {
				type: 'object',
				properties: {
					archivo: archivoParam,
					metodo: { type: 'string', enum: ['P', 'X'] },
					bloque: { type: 'integer' },
					desde: { type: 'integer' },
					hasta: { type: 'integer' }
				},
				required: ['bloque']
			},
			ejecutar: (args, ctx) => {
				const file = target(args, ctx);
				const e = k.extraccion(file, metodo(args.metodo));
				if (!e) throw new Error(`Primero extrae el archivo con el método ${metodo(args.metodo)}`);
				const b = e.bloques[Number(args.bloque)];
				if (!b) throw new Error(`No hay bloque ${String(args.bloque)}`);
				const desde = Math.max(0, Number(args.desde ?? 0));
				const hasta = Math.min(desde + 100, Number(args.hasta ?? desde + 50));
				return { ...b, filas: b.filas?.slice(desde, hasta), desde, totalFilas: b.filas?.length ?? 0 };
			}
		},
		{
			nombre: 'mapearTabla',
			descripcion:
				'Convierte bloques de tabla (de P o X; varios si es la misma tabla en varias páginas) en filas del formato: empareja encabezados por nombre u otros nombres e interpreta cada valor con el tipo de su columna ($319,100 → 319100; ($60,000) → -60000). `columnas` fija de qué encabezado o índice sale un campo; `fijos`, un valor para todas las filas. Devuelve una muestra; para usarlas, proponerFilas con desdeMapeo.',
			parametros: {
				type: 'object',
				properties: {
					archivo: archivoParam,
					formato: { type: 'string' },
					metodo: { type: 'string', enum: ['P', 'X'] },
					bloques: { type: 'array', items: { type: 'integer' } },
					columnas: { type: 'object', additionalProperties: { type: ['string', 'integer'] } },
					fijos: { type: 'object' }
				},
				required: ['formato', 'bloques']
			},
			ejecutar: (args, ctx) =>
				k.mapear(target(args, ctx), String(args.formato), metodo(args.metodo), numbers(args.bloques) ?? [], {
					columnas: args.columnas as MapeoOpciones['columnas'],
					fijos: args.fijos as MapeoOpciones['fijos']
				})
		},
		{
			nombre: 'proponerFilas',
			descripcion:
				'Escribe en la corrida las filas que se importarían a un formato (y deja ese destino si la persona no fijó otro). `desdeMapeo: true` usa el último mapearTabla; si no, `filas` (objetos con los campos del formato). `agregar: true` las suma a las que ya hay. `campos`: los datos del formulario del formato.',
			parametros: {
				type: 'object',
				properties: {
					archivo: archivoParam,
					formato: { type: 'string' },
					modo: { type: 'string', enum: ['upsert', 'replace'] },
					desdeMapeo: { type: 'boolean' },
					filas: { type: 'array', items: { type: 'object' } },
					agregar: { type: 'boolean' },
					campos: { type: 'object' }
				},
				required: ['formato']
			},
			ejecutar: (args, ctx) =>
				k.proponer(ctx, target(args, ctx), {
					formato: String(args.formato),
					modo: args.modo === 'replace' || args.modo === 'upsert' ? args.modo : undefined,
					filas: args.desdeMapeo ? undefined : Array.isArray(args.filas) ? (args.filas as Record<string, unknown>[]) : [],
					agregar: args.agregar === true,
					campos: args.campos as Record<string, CellValue> | undefined
				})
		},
		{
			nombre: 'editarFilas',
			descripcion:
				'Corrige las filas propuestas: `quitar` (posiciones), `quitarSi` ({ campo, contiene } o { campo, igual }), `cambiar` ([{ fila, campo, valor }]), `agregar` (filas nuevas).',
			parametros: {
				type: 'object',
				properties: {
					archivo: archivoParam,
					quitar: { type: 'array', items: { type: 'integer' } },
					quitarSi: { type: 'object', properties: { campo: { type: 'string' }, contiene: { type: 'string' }, igual: {} } },
					cambiar: { type: 'array', items: { type: 'object', properties: { fila: { type: 'integer' }, campo: { type: 'string' }, valor: {} } } },
					agregar: { type: 'array', items: { type: 'object' } }
				}
			},
			ejecutar: (args, ctx) => k.editar(ctx, target(args, ctx), args as EditarArgs)
		},
		{
			nombre: 'revisar',
			descripcion: 'Valida las filas propuestas con el formato (review de SB-34: tipos, obligatorias, catálogos, llave y reglas de la app). Devuelve los problemas por fila y campo.',
			parametros: { type: 'object', properties: { archivo: archivoParam } },
			ejecutar: (args, ctx) => k.revisar(ctx, target(args, ctx))
		},
		{
			nombre: 'leerFilasActuales',
			descripcion: 'Lo que ya hay en la tabla destino de un formato (para completar o comparar). `buscar` filtra por texto.',
			parametros: { type: 'object', properties: { formato: { type: 'string' }, buscar: { type: 'string' }, limite: { type: 'integer' } }, required: ['formato'] },
			ejecutar: (args, ctx) => k.actuales(ctx, String(args.formato), String(args.buscar ?? ''), Math.min(200, Number(args.limite ?? 50)))
		},
		{
			nombre: 'crearDerivado',
			descripcion: 'Guarda un archivo derivado (ej. ficha.md con lo que dice una ficha técnica) para adjuntarlo junto al original.',
			parametros: {
				type: 'object',
				properties: { archivo: archivoParam, nombre: { type: 'string' }, contenido: { type: 'string' }, tipo: { type: 'string' } },
				required: ['nombre', 'contenido']
			},
			ejecutar: (args, ctx) => k.derivar(ctx, target(args, ctx), String(args.nombre), String(args.contenido), String(args.tipo ?? 'text/markdown'))
		},
		{
			nombre: 'fijarDestino',
			descripcion: 'Elige el destino de un archivo (adjuntar o descartar; para filas, mejor proponerFilas). Si la persona ya lo fijó, no se cambia.',
			parametros: { type: 'object', properties: { archivo: archivoParam, destino: DESTINO }, required: ['destino'] },
			ejecutar: (args, ctx) => k.destinar(ctx, target(args, ctx), args.destino as ImportDestination)
		},
		{
			nombre: 'terminar',
			descripcion:
				'Cierra el análisis del archivo: `analisis` es el texto corto para la persona («57 planes de 6 modelos, 4 ramas»; o por qué se descarta). `destino`, si no lo dejaste ya.',
			parametros: { type: 'object', properties: { archivo: archivoParam, analisis: { type: 'string' }, destino: DESTINO }, required: ['analisis'] },
			ejecutar: (args, ctx) => k.terminar(ctx, target(args, ctx), String(args.analisis), args.destino as ImportDestination | undefined)
		}
	];
	if (opciones.conX) {
		tools.splice(2, 0, {
			nombre: 'extraerConLLM',
			descripcion:
				'Método X: lee las páginas (o la imagen) con visión, a la misma estructura que P. Úsalo para fotos y escaneos, y en PDFs para cruzar con P en las páginas con tablas. Cuesta: pide solo las páginas que hacen falta.',
			parametros: {
				type: 'object',
				properties: { archivo: archivoParam, paginas: { type: 'array', items: { type: 'integer' } }, formato: { type: 'string' } }
			},
			ejecutar: async (args, ctx) => {
				const paginas = numbers(args.paginas);
				const x = await k.extraerX(ctx, target(args, ctx), paginas, typeof args.formato === 'string' ? args.formato : undefined);
				return resumenAcotado(x, paginas);
			}
		});
	}
	return tools;
}
