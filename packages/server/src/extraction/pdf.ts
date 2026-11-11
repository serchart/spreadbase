/**
 * PDF con capa de texto → estructura intermedia (método P, SB-36).
 *
 * - **Texto con coordenadas**: `pdfjs-dist` (build `legacy`, la que corre en
 *   Node). Cada trozo trae su caja; `bloquesDePagina` reconstruye las tablas.
 * - **Páginas a PNG**: también con pdfjs, que en Node dibuja con
 *   `@napi-rs/canvas` (binarios precompilados por plataforma, sin compilar
 *   Cairo como el paquete `canvas`; pdfjs lo trae como dependencia opcional
 *   desde la v5 y lo busca solo). Las imágenes son para el método X (un LLM),
 *   y el método P las usa para dos cosas que la capa de texto no dice:
 *   - **Texto oculto**: hay PDFs con texto que no se ve —blanco sobre blanco,
 *     una columna auxiliar escondida— y que la capa de texto sí trae. Un trozo
 *     se ve si bajo él hay trazos que no están ni arriba ni abajo de su caja
 *     (así una línea de la tabla que lo cruza no cuenta como letra).
 *   - **Celdas combinadas**: las líneas horizontales de la tabla dicen qué
 *     filas abarca una celda combinada («AVEO HB 2026»).
 * - **Fuentes de símbolos**: una palomita de Wingdings llega como «P»; se
 *   traduce («✓») por el nombre de la fuente.
 *
 * Las dos librerías pesan y son opcionales: se cargan la primera vez.
 */
import { fileURLToPath } from 'node:url';
import { bloquesDePagina } from './layout.ts';
import type { OpcionesDisposicion, TextoPosicionado } from './layout.ts';
import type { BloqueExtraido, Extraccion, PaginaRenderizada } from './types.ts';

export interface OpcionesPdf {
	/** Devolver cada página como PNG (para el método X). Default: `false`. */
	imagenes?: boolean;
	/** Escala del PNG: 1 = 72 ppp. Default: 2. */
	escala?: number;
	/** Texto que no se ve en la página: `descartar` (default, exige canvas) o `conservar`. */
	ocultos?: 'descartar' | 'conservar';
	/** Solo estas páginas (1 = la primera). Default: todas. */
	paginas?: number[];
}

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type Canvas = typeof import('@napi-rs/canvas');

let pdfjs: Promise<Pdfjs> | null = null;
let canvasLib: Promise<Canvas | null> | null = null;

function loadPdfjs(): Promise<Pdfjs> {
	pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => {
		pdfjs = null;
		throw new Error('Extraer un PDF necesita el paquete `pdfjs-dist`: npm install pdfjs-dist');
	});
	return pdfjs;
}

/**
 * Las fuentes estándar (Helvetica, Times… sin incrustar), los mapas de
 * caracteres y los decodificadores de imagen vienen dentro de `pdfjs-dist`; en
 * Node hay que decirle dónde. Sin ellos, el texto con fuentes estándar no se
 * dibuja y parecería oculto.
 */
function pdfjsAssets(): Record<string, unknown> {
	try {
		const base = fileURLToPath(new URL('../../', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')));
		return { standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true, wasmUrl: `${base}wasm/` };
	} catch {
		return {};
	}
}

/** `null` si no está instalado: se extrae el texto igual, sin imágenes ni detección de ocultos. */
function loadCanvas(): Promise<Canvas | null> {
	canvasLib ??= import('@napi-rs/canvas').catch(() => null);
	return canvasLib;
}

/** Letras de fuentes de símbolos que son marcas: la palomita de Wingdings 2 es una «P». */
const SYMBOLS: [RegExp, Record<string, string>][] = [
	[/wingdings-?2/i, { P: '✓', O: '✗', R: '☑', T: '☒', Q: '☒', '£': '☐' }],
	[/wingdings/i, { ü: '✓', û: '✗', þ: '☑', ý: '☒', o: '☐', '¨': '☐', n: '■', l: '●' }],
	[/zapf ?dingbats|dingbats/i, { '3': '✓', '4': '✔', '7': '✗', '8': '✘', n: '■', l: '●' }]
];

function symbolOf(font: string | undefined, text: string): string {
	if (!font) return text;
	const map = SYMBOLS.find(([re]) => re.test(font))?.[1];
	return map ? [...text].map((c) => map[c] ?? c).join('') : text;
}

/** Luminancia de un píxel RGBA. */
const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;

interface Pagina {
	getViewport(o: { scale: number }): { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] };
	render(o: { canvas: never; viewport: unknown }): { promise: Promise<void> };
}

/** Una página dibujada y lo que el método P le pregunta a la imagen. */
async function dibujar(canvas: Canvas, page: Pagina, escala: number) {
	const viewport = page.getViewport({ scale: escala });
	const surface = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
	await page.render({ canvas: surface as never, viewport }).promise;
	const image = surface.getContext('2d').getImageData(0, 0, surface.width, surface.height);
	const W = image.width;
	const H = image.height;
	const at = (x: number, y: number) => luma(image.data, (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4);
	/** De coordenadas del PDF a píxeles: [izquierda, arriba, derecha, abajo]. */
	const box = (x0: number, x1: number, yTop: number, yBottom: number) => {
		const [ax, ay] = viewport.convertToViewportPoint(x0, yTop);
		const [bx, by] = viewport.convertToViewportPoint(x1, yBottom);
		return [Math.round(Math.min(ax!, bx!)), Math.round(Math.min(ay!, by!)), Math.round(Math.max(ax!, bx!)), Math.round(Math.max(ay!, by!))] as const;
	};
	return {
		surface,
		/**
		 * ¿Se ve el trozo? Cuenta píxeles de tinta: distintos de lo que hay arriba
		 * **y** abajo de la caja (una línea vertical que la cruza sigue fuera de
		 * ella: no cuenta) y de lo que hay a la izquierda **o** a la derecha (una
		 * línea horizontal tampoco).
		 */
		visible(t: TextoPosicionado): boolean {
			const [left, top, right, bottom] = box(t.x0, t.x1, t.y + t.h, t.y - 0.2 * t.h);
			const d = Math.max(2, Math.round(0.5 * t.h * escala));
			const differs = (l: number, x: number, y: number) => Math.abs(l - at(x, y)) > 40;
			let ink = 0;
			for (let y = top; y <= bottom; y++) {
				for (let x = left; x <= right; x++) {
					const l = at(x, y);
					if (!differs(l, x, top - d) || !differs(l, x, bottom + d)) continue;
					if (!differs(l, left - d, y) && !differs(l, right + d, y)) continue;
					if (++ink >= 2) return true;
				}
			}
			return false;
		},
		/**
		 * De dos trozos encimados, el que se ve: se escribe cada uno con una letra
		 * genérica sobre su caja y se mide cuánto coincide con la tinta de la
		 * página (intersección sobre unión). El recortado o tapado no dejó tinta
		 * propia y coincide menos. Sin fuentes en el sistema, empatan: el primero.
		 */
		preferir(a: TextoPosicionado, b: TextoPosicionado): TextoPosicionado {
			const [left, top, right, bottom] = box(Math.min(a.x0, b.x0), Math.max(a.x1, b.x1), Math.max(a.y + a.h, b.y + b.h), Math.min(a.y, b.y) - 0.25 * Math.max(a.h, b.h));
			const w = right - left + 1;
			const hh = bottom - top + 1;
			if (w <= 0 || hh <= 0) return a;
			// Tinta: lo que se aparta del fondo (el tono más claro de la zona).
			let paper = 0;
			for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) paper = Math.max(paper, at(x, y));
			const score = (t: TextoPosicionado) => {
				const mask = canvas.createCanvas(w, hh);
				const ctx = mask.getContext('2d');
				ctx.font = `${Math.max(1, t.h * escala)}px sans-serif`;
				const measured = ctx.measureText(t.texto).width;
				if (!measured) return 0;
				const [x0, baseline] = viewport.convertToViewportPoint(t.x0, t.y);
				const [x1] = viewport.convertToViewportPoint(t.x1, t.y);
				ctx.setTransform((x1! - x0!) / measured, 0, 0, 1, x0! - left, baseline! - top);
				ctx.fillText(t.texto, 0, 0);
				const data = ctx.getImageData(0, 0, w, hh).data;
				let inter = 0;
				let union = 0;
				for (let y = 0; y < hh; y++) {
					for (let x = 0; x < w; x++) {
						const glyph = data[(y * w + x) * 4 + 3]! > 100;
						const ink = paper - at(left + x, top + y) > 60;
						if (glyph && ink) inter++;
						if (glyph || ink) union++;
					}
				}
				return union ? inter / union : 0;
			};
			return score(b) > score(a) ? b : a;
		},
		/** ¿Hay una línea horizontal que cruce [x0, x1] entre `yArriba` y `yAbajo`? */
		lineaHorizontal(x0: number, x1: number, yArriba: number, yAbajo: number): boolean {
			const [left, top, right, bottom] = box(x0, x1, yArriba, yAbajo);
			if (right <= left) return false;
			for (let y = top; y <= bottom; y++) {
				let dark = 0;
				for (let x = left; x <= right; x++) if (at(x, y) < 128) dark++;
				if (dark >= 0.8 * (right - left + 1)) return true;
			}
			return false;
		}
	};
}

export async function extraerPdf(buffer: Uint8Array, nombre: string, opciones: OpcionesPdf = {}): Promise<Extraccion> {
	const lib = await loadPdfjs();
	const escala = opciones.escala ?? 2;
	const ocultos = opciones.ocultos ?? 'descartar';
	const avisos: string[] = [];
	// pdfjs se queda con el buffer (lo transfiere al worker): se le pasa una copia.
	// `fontExtraProperties`: el nombre de cada fuente, para las de símbolos.
	const task = lib.getDocument({ data: new Uint8Array(buffer), verbosity: 0, fontExtraProperties: true, ...pdfjsAssets() });
	const doc = await task.promise;
	try {
		const canvas = await loadCanvas();
		if (!canvas) {
			avisos.push(
				'Sin @napi-rs/canvas no se dibujan las páginas, no se detecta el texto oculto ni las celdas combinadas: npm install @napi-rs/canvas'
			);
		}

		const numeros = (opciones.paginas ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)).filter((n) => n >= 1 && n <= doc.numPages);
		const bloques: BloqueExtraido[] = [];
		const imagenes: PaginaRenderizada[] = [];
		for (const numero of numeros) {
			const page = await doc.getPage(numero);
			try {
				const content = await page.getTextContent();
				// Dibujar carga las fuentes; sin canvas, se cargan con la lista de operaciones.
				const image = canvas ? await dibujar(canvas, page as unknown as Pagina, escala) : null;
				if (!image) await page.getOperatorList();
				const fontName = (id: string) => {
					try {
						return (page.commonObjs.get(id) as { name?: string } | undefined)?.name;
					} catch {
						return undefined;
					}
				};

				let items: TextoPosicionado[] = [];
				for (const raw of content.items) {
					if (!('str' in raw) || raw.str.trim() === '') continue;
					const [a, b, , d, e, f] = raw.transform as number[];
					// Texto girado: su caja se aproxima con la altura de la letra.
					const rotated = Math.abs(b!) > 0.01 * Math.abs(a!);
					const h = raw.height || Math.abs(d!) || 1;
					items.push({ texto: symbolOf(fontName(raw.fontName), raw.str), x0: e!, x1: e! + (rotated ? h : raw.width), y: f!, h });
				}

				if (image && ocultos === 'descartar') {
					const seen = items.filter((t) => image.visible(t));
					// Ninguno se ve: más probable que la página no se haya dibujado bien (una fuente que no
					// cargó) que una página entera de texto oculto. Se conserva todo.
					if (!seen.length && items.length) avisos.push(`Página ${numero}: no se pudo comprobar qué texto se ve; se conserva todo`);
					else if (seen.length < items.length) {
						avisos.push(`Página ${numero}: ${items.length - seen.length} trozos de texto que no se ven, descartados`);
						items = seen;
					}
				}
				if (image && opciones.imagenes) {
					imagenes.push({ pagina: numero, png: image.surface.toBuffer('image/png'), ancho: image.surface.width, alto: image.surface.height });
				}

				const disposicion: OpcionesDisposicion = image ? { lineaHorizontal: image.lineaHorizontal, preferir: image.preferir } : {};
				const found = bloquesDePagina(items, numero, disposicion);
				if (!found.length) {
					// Sin capa de texto (un escaneo): solo la puede leer el método X.
					bloques.push({ pagina: numero, tipo: 'imagen', contenido: 'La página no tiene capa de texto', confianza: 0 });
				} else bloques.push(...found);
			} finally {
				page.cleanup();
			}
		}
		return {
			archivo: { nombre, paginas: doc.numPages, tipo: 'pdf' },
			bloques,
			...(opciones.imagenes ? { imagenes } : {}),
			...(avisos.length ? { avisos } : {})
		};
	} finally {
		await task.destroy();
	}
}

/** Solo las páginas a PNG, para el método X sin extraer texto. */
export async function renderizarPdf(buffer: Uint8Array, opciones: { escala?: number; paginas?: number[] } = {}): Promise<PaginaRenderizada[]> {
	const lib = await loadPdfjs();
	const canvas = await loadCanvas();
	if (!canvas) throw new Error('Dibujar las páginas necesita el paquete `@napi-rs/canvas`: npm install @napi-rs/canvas');
	const task = lib.getDocument({ data: new Uint8Array(buffer), verbosity: 0, ...pdfjsAssets() });
	const doc = await task.promise;
	try {
		const numeros = (opciones.paginas ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)).filter((n) => n >= 1 && n <= doc.numPages);
		const out: PaginaRenderizada[] = [];
		for (const numero of numeros) {
			const page = await doc.getPage(numero);
			const { surface } = await dibujar(canvas, page as unknown as Pagina, opciones.escala ?? 2);
			out.push({ pagina: numero, png: surface.toBuffer('image/png'), ancho: surface.width, alto: surface.height });
			page.cleanup();
		}
		return out;
	} finally {
		await task.destroy();
	}
}
