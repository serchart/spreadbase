/**
 * El caso real de SB-36 con el agente: el boletín de planes (fuera del repo;
 * `EXTRACTION_PDF`). Un modelo de guion hace lo que haría el de verdad con la
 * instrucción «solo la guía para vendedor (págs. 2–9)»: extrae con P, cruza la
 * página 2 con X, mapea al formato «Planes», propone, revisa y termina; luego
 * se importa con replace. Si no está el PDF, se omite.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extraerDeterminista, importAgent, inProcessRunner, memoryFileStorage, memoryRunStore } from '@spreadbase/server';
import type { ImportLLM, LLMMensaje } from '@spreadbase/server';
import { planes } from '../support/planes.ts';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (!process.env.EXTRACTION_PDF && existsSync(envFile)) process.loadEnvFile(envFile);
const file = process.env.EXTRACTION_PDF;
const available = Boolean(file && existsSync(file));

const ultimo = (mensajes: LLMMensaje[], nombre: string) =>
	[...mensajes].reverse().find((m): m is Extract<LLMMensaje, { rol: 'tool' }> => m.rol === 'tool' && m.nombre === nombre)?.resultado as Record<string, any>;
const PAGINAS = [2, 3, 4, 5, 6, 7, 8, 9];

describe.skipIf(!available)('boletín real con el agente (EXTRACTION_PDF)', () => {
	it('las 264 filas de la guía para vendedor: P y X coinciden en la página 2, review sin errores, replace importa todas', { timeout: 120_000 }, async () => {
		const bytes = readFileSync(file!);
		let comparacion: Record<string, any> | undefined;
		const p2 = (await extraerDeterminista(bytes, { nombre: 'b.pdf', paginas: [2] })).bloques.find((b) => b.tipo === 'tabla')!;
		const llm: ImportLLM = {
			// X de mentira: «ve» en la imagen lo mismo que P (el cruce no debe marcar nada).
			generateStructured: async () => ({ bloques: [{ tipo: 'tabla', encabezados: p2.encabezados, filas: p2.filas }] }),
			async chat({ mensajes }) {
				const n = mensajes.filter((m) => m.rol === 'agente').length;
				if (n === 0) return { llamadas: [{ nombre: 'extraerDeterminista', args: { paginas: PAGINAS } }] };
				if (n === 1) return { llamadas: [{ nombre: 'extraerConLLM', args: { paginas: [2], formato: 'planes' } }, { nombre: 'compararExtracciones', args: {} }] };
				if (n === 2) {
					comparacion = ultimo(mensajes, 'compararExtracciones');
					const tablas = ultimo(mensajes, 'extraerDeterminista').bloques.filter((b: any) => b.tipo === 'tabla').map((b: any) => b.indice);
					return { llamadas: [{ nombre: 'mapearTabla', args: { formato: 'planes', bloques: tablas } }] };
				}
				if (n === 3) return { llamadas: [{ nombre: 'proponerFilas', args: { formato: 'planes', modo: 'replace', desdeMapeo: true } }, { nombre: 'revisar', args: {} }] };
				const r = ultimo(mensajes, 'revisar');
				return { llamadas: [{ nombre: 'terminar', args: { analisis: `${r.resumen.rows} planes de ${r.resumen.modelos} modelos, ${r.errores} errores` } }] };
			}
		};
		const p = planes();
		const runner = inProcessRunner();
		const agent = importAgent({ llm, destinations: [{ tipo: 'filas', formato: p.formato, modo: 'replace' }], runs: memoryRunStore(), storage: memoryFileStorage(), runner });
		const run = await agent.crearCorrida({ instrucciones: 'Solo la guía para vendedor (págs. 2 a 9)' });
		await agent.agregarArchivo(run.id, { bytes, nombre: '01 Oct Planes Chevrolet MY26.pdf' });
		await agent.analizar(run.id);
		await runner.vacia();

		const f = (await agent.obtener(run.id)).archivos[0]!;
		expect(f.error).toBeNull();
		expect(f.issues.filter((i) => i.level === 'error')).toEqual([]);
		expect(f.filas).toHaveLength(264);
		expect(f.analisis).toBe('264 planes de 26 modelos, 0 errores');
		expect(f.filas[4]).toEqual({
			modelo: 'AVEO HB 2026',
			paquete: 'A',
			version: 'LS Manual',
			tipoPago: 'GMF TASA SUBSIDIADA CON SEGURO',
			codigoGMM: 'RCC',
			codigoGMF: 'HCAM',
			precioLista: 319100,
			descuento: -60000,
			precioFinal: 259100,
			cxa0: true,
			seguro: '1 AÑO HDI',
			tasa: 'Tasa Especial desde 14.59%',
			otros: null
		});
		// Lo que respondió compararExtracciones al modelo: P y X coinciden en la página 2.
		expect(comparacion).toEqual({ total: 0, diferencias: [] });

		await agent.importar(run.id);
		await runner.vacia();
		expect((await agent.obtener(run.id)).archivos[0]!.resultado).toMatchObject({ status: 'ok', ok: 264, error: 0 });
		expect(await p.leer()).toHaveLength(264);
	});
});
