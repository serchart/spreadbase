/**
 * Método X (SB-36): extraer con un LLM que mira cada página, a la misma
 * estructura intermedia que el método P.
 *
 * SpreadBase **no llama a ningún proveedor** (mismo principio que SB-2 con la
 * base): la app inyecta un `ImportLLM` con su modelo, su llave y sus límites.
 * Aquí solo se arman las instrucciones y el esquema de la respuesta, se
 * recorre el archivo página por página y se normaliza lo que vuelve.
 */
import type { ImportSchema } from '@spreadbase/core';
import type { ArchivoExtraido, BloqueExtraido, Extraccion } from './types.ts';

/** Un JSON Schema (el subconjunto que entienden los modelos con salida estructurada). */
export type JsonSchema = Record<string, unknown>;

/** Una parte de un mensaje para el modelo: texto o una imagen (bytes o URL). */
export type LLMParte = { tipo: 'texto'; texto: string } | { tipo: 'imagen'; datos: Buffer | string; mime?: string };

/** Una llamada a una tool que pidió el modelo. `id` lo pone el adaptador (o se genera) para casar la respuesta. */
export interface LLMLlamada {
	id?: string;
	nombre: string;
	args: Record<string, unknown>;
}

/** El historial del bucle, en el orden en que pasó. */
export type LLMMensaje =
	| { rol: 'usuario'; partes: LLMParte[] }
	| { rol: 'agente'; texto?: string; llamadas?: LLMLlamada[]; meta?: unknown }
	/** Lo que devolvió una tool (JSON), con imágenes si las trae (una página dibujada). */
	| { rol: 'tool'; id: string; nombre: string; resultado: unknown; imagenes?: Buffer[] };

/** Una tool que el modelo puede llamar: nombre, para qué sirve y sus parámetros (JSON Schema). */
export interface LLMTool {
	nombre: string;
	descripcion: string;
	parametros: JsonSchema;
}

/** Lo que responde el modelo en una vuelta: texto para la persona, llamadas a tools, o las dos. */
export interface LLMRespuesta {
	texto?: string;
	llamadas?: LLMLlamada[];
	/**
	 * Lo que el proveedor necesita de vuelta tal cual en la siguiente vuelta
	 * (opaco para SpreadBase): las `thoughtSignature` de Gemini 3, por ejemplo,
	 * que exige junto a cada `functionCall`. El agente lo guarda en el mensaje
	 * `agente` del historial y el adaptador lo usa al traducirlo.
	 */
	meta?: unknown;
}

/**
 * Lo que la app conecta: su modelo, detrás de esta interfaz (SB-2: el LLM es
 * de la app). SpreadBase no depende de ningún proveedor.
 *
 * - `generateStructured`: una respuesta que cumple un JSON Schema (método X).
 * - `chat`: una vuelta del bucle del agente con tools (`importAgent`). Opcional:
 *   sin ella, el agente analiza con reglas (P y mapeo por encabezados).
 */
export interface ImportLLM {
	generateStructured(input: {
		instrucciones: string;
		/** Las páginas dibujadas (PNG) o sus URLs. */
		imagenes: (Buffer | string)[];
		/** Texto de apoyo: lo que sacó el método P de la misma página, si lo hay. */
		texto?: string;
		schema: JsonSchema;
		/** El modelo que pidió la app (`importAgent({ model })`), si el adaptador elige. */
		modelo?: string;
	}): Promise<unknown>;
	chat?(input: { sistema: string; mensajes: LLMMensaje[]; tools: LLMTool[]; modelo?: string }): Promise<LLMRespuesta>;
}

/** Una página para el LLM: su imagen y, si se tiene, su texto. */
export interface PaginaParaLLM {
	pagina: number;
	imagen?: Buffer | string;
	texto?: string;
}

export interface OpcionesLLM {
	/** El formato destino (SB-34): qué columnas buscar y con qué otros nombres pueden venir. */
	schema?: ImportSchema;
	/** Del archivo, para el resultado. */
	archivo?: Partial<ArchivoExtraido>;
	/** Indicaciones de la app («los importes van sin signo de pesos»…). */
	instrucciones?: string;
	/** Cuántas páginas a la vez. Default: 1 (en orden). */
	concurrencia?: number;
	/** El modelo, para el adaptador. */
	modelo?: string;
}

/** El esquema de la respuesta de una página: los bloques, como la estructura intermedia. */
export const ESQUEMA_PAGINA: JsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['bloques'],
	properties: {
		bloques: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['tipo'],
				properties: {
					tipo: { type: 'string', enum: ['tabla', 'texto', 'imagen'] },
					titulo: { type: 'string' },
					encabezados: { type: 'array', items: { type: 'string' } },
					filas: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
					contenido: { type: 'string' },
					confianza: { type: 'number', minimum: 0, maximum: 1 }
				}
			}
		}
	}
};

/** Las instrucciones para una página. Puras: se prueban y se ajustan sin llamar a un modelo. */
export function armarInstrucciones(pagina: number, opciones: Pick<OpcionesLLM, 'schema' | 'instrucciones'> & { total?: number; conTexto?: boolean } = {}): string {
	const lines = [
		`Extrae el contenido de la página ${pagina}${opciones.total ? ` de ${opciones.total}` : ''} de un documento, tal como se ve en la imagen.`,
		'Devuelve bloques en orden de lectura:',
		'- «tabla»: `encabezados` (uno por columna, como aparecen; varios renglones de un encabezado van unidos con un espacio) y `filas` (cada fila con tantas celdas como encabezados).',
		'- «texto»: títulos, notas y párrafos fuera de las tablas, en `contenido`.',
		'- «imagen»: logotipos o figuras sin texto útil; describe en `contenido` en una línea.',
		'Reglas de las celdas:',
		'- Copia el texto exacto de cada celda: no traduzcas, no calcules, no cambies formatos («$319,100», «($60,000)», «16.09%» se copian igual).',
		'- Una celda vacía es "" ; un guion que se ve en la celda se copia como "-".',
		'- Una celda de varios renglones va en una sola cadena, unida con un espacio.',
		'- Una celda combinada que abarca varias filas (p. ej. el modelo a la izquierda) se repite en cada fila que abarca.',
		'- Una marca de verificación (✓) se escribe "✓".',
		'- Solo lo que se ve: ignora texto oculto o encimado.',
		'En `confianza` (0 a 1) di qué tan seguro estás de cada bloque.'
	];
	if (opciones.conTexto) {
		lines.push('Se adjunta el texto que trae el archivo para esta página: úsalo para copiar exacto, pero manda lo que se ve en la imagen.');
	}
	const columns = Object.values(opciones.schema?.columns ?? {}).filter((c) => c.from !== 'form');
	if (columns.length) {
		lines.push(
			`Se buscan sobre todo tablas con estas columnas (${opciones.schema!.label}); usa los encabezados del documento, no estos nombres:`,
			...columns.map((c) => `- ${c.label}${c.aliases?.length ? ` (también: ${c.aliases.join(', ')})` : ''}`)
		);
	}
	if (opciones.instrucciones) lines.push(opciones.instrucciones);
	return lines.join('\n');
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Lo que devolvió el modelo, a bloques válidos: lo que no tiene forma de bloque se descarta. */
function normalize(raw: unknown, pagina: number): BloqueExtraido[] {
	const list = (raw as { bloques?: unknown } | null)?.bloques;
	if (!Array.isArray(list)) return [];
	const out: BloqueExtraido[] = [];
	for (const b of list as Record<string, unknown>[]) {
		if (!b || typeof b !== 'object') continue;
		const tipo = b.tipo === 'tabla' || b.tipo === 'texto' || b.tipo === 'imagen' ? b.tipo : null;
		if (!tipo) continue;
		const block: BloqueExtraido = { pagina, tipo };
		if (typeof b.titulo === 'string' && b.titulo.trim()) block.titulo = b.titulo.trim();
		if (tipo === 'tabla') {
			const encabezados = Array.isArray(b.encabezados) ? b.encabezados.map(str) : undefined;
			const filas = Array.isArray(b.filas) ? (b.filas as unknown[]).filter(Array.isArray).map((r) => (r as unknown[]).map(str)) : [];
			const width = Math.max(encabezados?.length ?? 0, ...filas.map((r) => r.length));
			const pad = (r: string[]) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim());
			if (encabezados) block.encabezados = pad(encabezados);
			block.filas = filas.map(pad);
		} else if (b.contenido !== undefined) block.contenido = str(b.contenido);
		if (typeof b.confianza === 'number' && Number.isFinite(b.confianza)) block.confianza = Math.min(1, Math.max(0, b.confianza));
		out.push(block);
	}
	return out;
}

/**
 * Extrae con el LLM, página por página. Una página que falla no detiene el
 * resto: queda en `avisos` y sin bloques.
 */
export async function extraerConLLM(paginas: PaginaParaLLM[], llm: ImportLLM, opciones: OpcionesLLM = {}): Promise<Extraccion> {
	const total = opciones.archivo?.paginas ?? paginas.length;
	const results: { bloques: BloqueExtraido[]; aviso?: string }[] = new Array(paginas.length);
	let next = 0;
	const worker = async () => {
		while (next < paginas.length) {
			const index = next++;
			const p = paginas[index]!;
			try {
				const raw = await llm.generateStructured({
					instrucciones: armarInstrucciones(p.pagina, { ...opciones, total, conTexto: Boolean(p.texto) }),
					imagenes: p.imagen === undefined ? [] : [p.imagen],
					...(p.texto ? { texto: p.texto } : {}),
					schema: ESQUEMA_PAGINA,
					...(opciones.modelo ? { modelo: opciones.modelo } : {})
				});
				results[index] = { bloques: normalize(raw, p.pagina) };
			} catch (error) {
				results[index] = { bloques: [], aviso: `Página ${p.pagina}: el LLM falló (${(error as Error).message})` };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(opciones.concurrencia ?? 1, paginas.length)) }, worker));
	const avisos = results.flatMap((r) => (r.aviso ? [r.aviso] : []));
	return {
		archivo: { nombre: opciones.archivo?.nombre ?? '', paginas: total, tipo: opciones.archivo?.tipo ?? 'pdf' },
		bloques: results.flatMap((r) => r.bloques),
		...(avisos.length ? { avisos } : {})
	};
}

/** El texto de una página según el método P, como apoyo para el LLM (tablas separadas por tabuladores). */
export function textoDePagina(extraccion: Extraccion, pagina: number): string {
	return extraccion.bloques
		.filter((b) => b.pagina === pagina)
		.map((b) =>
			b.tipo === 'tabla'
				? [b.titulo, b.encabezados?.join('\t'), ...(b.filas ?? []).map((r) => r.join('\t'))].filter((l) => l !== undefined && l !== '').join('\n')
				: (b.contenido ?? '')
		)
		.filter(Boolean)
		.join('\n\n');
}
