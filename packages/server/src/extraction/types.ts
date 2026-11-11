/**
 * La estructura intermedia de la extracción (SB-36): lo que sale de un archivo
 * antes de convertirlo en filas de un formato SB-34. La producen los dos
 * métodos —determinista («P», `extraerDeterminista`) y con un LLM («X»,
 * `extraerConLLM`)— para poder cruzarlos celda por celda
 * (`compararExtracciones`).
 *
 * Es deliberadamente plana: bloques de tabla, texto o imagen por página, con
 * celdas de texto tal como se leen (sin interpretar números ni fechas: eso es
 * del formato, con el tipo de cada columna).
 */

/** De qué archivo salió: `paginas` son las páginas de un PDF o las hojas de un libro. */
export interface ArchivoExtraido {
	nombre: string;
	paginas: number;
	tipo: 'pdf' | 'xlsx' | 'csv' | 'texto' | 'json' | 'imagen';
}

export interface BloqueExtraido {
	/** 1 = la primera página (u hoja). */
	pagina: number;
	tipo: 'tabla' | 'texto' | 'imagen';
	/** El título de la tabla (el texto que la precede) o el nombre de la hoja. */
	titulo?: string;
	/** Tablas: los encabezados, uno por columna (`''` si la columna no trae). */
	encabezados?: string[];
	/** Tablas: las filas de datos, con tantas celdas como encabezados. */
	filas?: string[][];
	/** Texto: el contenido, con saltos de línea. Imagen: una nota de por qué no hay texto. */
	contenido?: string;
	/** De 0 a 1: qué tan segura está la extracción de este bloque. */
	confianza?: number;
}

/** Una página dibujada a PNG, para que la lea un LLM (método X). */
export interface PaginaRenderizada {
	pagina: number;
	png: Buffer;
	ancho: number;
	alto: number;
}

export interface Extraccion {
	archivo: ArchivoExtraido;
	bloques: BloqueExtraido[];
	/** Con `imagenes: true` (PDF): cada página como PNG. */
	imagenes?: PaginaRenderizada[];
	/** Lo que no se pudo hacer o conviene revisar (sin canvas, páginas sin texto…). */
	avisos?: string[];
}
