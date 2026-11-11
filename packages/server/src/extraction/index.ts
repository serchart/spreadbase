/**
 * Extracción de archivos para el asistente de importación (SB-36): de
 * cualquier archivo a una estructura intermedia de bloques (tabla, texto,
 * imagen) por página, por dos caminos que se cruzan.
 *
 * - **P** `extraerDeterminista`: sin LLM (pdfjs, exceljs, CSV, texto).
 * - **X** `extraerConLLM`: con un `ImportLLM` que inyecta la app.
 * - `compararExtracciones`: las diferencias celda por celda.
 */
export type { ArchivoExtraido, BloqueExtraido, Extraccion, PaginaRenderizada } from './types.ts';
export { extraerDeterminista } from './deterministic.ts';
export type { OpcionesExtraccion } from './deterministic.ts';
export { renderizarPdf } from './pdf.ts';
export type { OpcionesPdf } from './pdf.ts';
export { bloquesDePagina } from './layout.ts';
export type { OpcionesDisposicion, TextoPosicionado } from './layout.ts';
export { extraerConLLM, armarInstrucciones, textoDePagina, ESQUEMA_PAGINA } from './llm.ts';
export type { ImportLLM, JsonSchema, LLMLlamada, LLMMensaje, LLMParte, LLMRespuesta, LLMTool, OpcionesLLM, PaginaParaLLM } from './llm.ts';
export { compararExtracciones } from './compare.ts';
export type { Diferencia, OpcionesComparacion } from './compare.ts';
