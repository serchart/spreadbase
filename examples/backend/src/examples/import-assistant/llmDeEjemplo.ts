/**
 * Un «modelo» de ejemplo, sin red ni llaves: sigue siempre el mismo guion con
 * las tools del agente. Sirve para probar el asistente de punta a punta; no
 * entiende fotos ni instrucciones libres (para eso, un modelo de verdad:
 * `IMPORT_ASSISTANT_LLM=gemini`).
 *
 * - Analizar un archivo: extraerDeterminista → mapearTabla con todas las
 *   tablas que traen columnas del formato → proponerFilas → revisar → terminar.
 * - Chat antes de analizar: «Anotado» (el agente ya lo guardó como instrucción).
 * - Chat: «excluye <texto>» quita las filas cuyo tipo de pago lo contiene; lo
 *   demás se contesta con el estado de la corrida.
 * - Un archivo con «lento» en el nombre se analiza despacio (0.7 s por paso):
 *   para ver en el navegador el progreso en vivo de la columna Estado.
 */
import type { ImportLLM, LLMMensaje } from '@spreadbase/server';

const ultimo = (mensajes: LLMMensaje[], nombre: string) =>
	[...mensajes].reverse().find((m): m is Extract<LLMMensaje, { rol: 'tool' }> => m.rol === 'tool' && m.nombre === nombre)?.resultado as Record<string, any> | undefined;

const textoDe = (m: LLMMensaje | undefined) => (m?.rol === 'usuario' ? m.partes.map((p) => (p.tipo === 'texto' ? p.texto : '')).join('\n') : '');

export function llmDeEjemplo(formato: string): ImportLLM {
	return {
		async generateStructured() {
			// Sin visión: no «ve» nada en las imágenes.
			return { bloques: [{ tipo: 'texto', contenido: 'El modelo de ejemplo no lee imágenes', confianza: 0 }] };
		},
		async chat({ sistema, mensajes }) {
			const usuario = [...mensajes].reverse().find((m) => m.rol === 'usuario');
			const desde = mensajes.lastIndexOf(usuario!);
			const vuelta = mensajes.slice(desde).filter((m) => m.rol === 'agente').length;
			const pedido = textoDe(usuario);

			// Analizar un archivo.
			if (pedido.startsWith('Archivo a analizar')) {
				if (/lento/i.test(pedido.split('\n')[0] ?? '')) await new Promise((r) => setTimeout(r, 700));
				if (vuelta === 0) return { llamadas: [{ nombre: 'extraerDeterminista', args: {} }] };
				if (vuelta === 1) {
					const tablas = (ultimo(mensajes, 'extraerDeterminista')?.bloques ?? []).filter((b: any) => b.tipo === 'tabla').map((b: any) => b.indice);
					if (!tablas.length) return { llamadas: [{ nombre: 'terminar', args: { analisis: 'No encontré tablas: elige un destino o descártalo' } }] };
					return { llamadas: [{ nombre: 'mapearTabla', args: { formato, bloques: tablas } }] };
				}
				if (vuelta === 2) {
					const mapeo = ultimo(mensajes, 'mapearTabla');
					if (!mapeo || mapeo.error || Object.keys(mapeo.columnas ?? {}).length < 3) return { llamadas: [{ nombre: 'terminar', args: { analisis: 'Las tablas no se parecen al formato' } }] };
					return { llamadas: [{ nombre: 'proponerFilas', args: { formato, desdeMapeo: true } }, { nombre: 'revisar', args: {} }] };
				}
				const r = ultimo(mensajes, 'revisar');
				const analisis = r?.resumen
					? `${r.resumen.rows} filas${r.resumen.modelos ? ` de ${r.resumen.modelos} modelos` : ''}${r.errores ? `, ${r.errores} problemas` : ''}`
					: 'Revisa el destino';
				return { llamadas: [{ nombre: 'terminar', args: { analisis } }] };
			}

			// Chat antes de analizar: el agente ya guardó el mensaje como instrucción de la corrida.
			if (sistema.includes('Todavía no se analiza')) return { texto: 'Anotado: lo tomo en cuenta al analizar.' };

			// Chat.
			const excluir = /excluye\s+(?:los\s+|las\s+)?(?:planes\s+de\s+)?(.+)/i.exec(pedido)?.[1]?.trim();
			const archivos = [...sistema.matchAll(/^- (\S+) «([^»]+)».* (\d+) filas/gm)].filter((m) => Number(m[3]) > 0);
			if (excluir && vuelta === 0 && archivos.length) {
				return {
					llamadas: archivos.flatMap((m) => [
						{ nombre: 'editarFilas', args: { archivo: m[1], quitarSi: { campo: 'tipoPago', contiene: excluir } } },
						{ nombre: 'revisar', args: { archivo: m[1] } }
					])
				};
			}
			if (excluir) {
				const quitadas = mensajes.filter((m) => m.rol === 'tool' && m.nombre === 'editarFilas').reduce((a, m: any) => a + (m.resultado?.quitadas ?? 0), 0);
				return { texto: `Listo: quité ${quitadas} filas con «${excluir}» en el tipo de pago.` };
			}
			return { texto: `Soy el modelo de ejemplo: solo sé «excluye <texto>». La corrida tiene ${archivos.length} archivos con filas.` };
		}
	};
}
