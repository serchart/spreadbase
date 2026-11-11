/**
 * El agente importador (SB-36) sin HTTP: analizar → revisar → importar, con
 * reglas (sin modelo) y con un `ImportLLM` falso de respuestas guionadas que
 * llama tools. El formato «Planes» escribe en una fuente en memoria.
 */
import { describe, expect, it } from 'vitest';
import { importAgent, inProcessRunner, memoryFileStorage, memoryRunStore } from '@spreadbase/server';
import type { ImportAgentOptions, ImportLLM, ImportRunEvent, LLMMensaje, LLMRespuesta, LLMTool } from '@spreadbase/server';
import { pdfMinimo, texto } from '../support/pdf.ts';
import { csvPlanes, FILAS_OK, planes } from '../support/planes.ts';

type ChatInput = { sistema: string; mensajes: LLMMensaje[]; tools: LLMTool[]; modelo?: string };

/** Lo que devolvió la última tool, para que el guion decida el siguiente paso. */
const ultimo = (mensajes: LLMMensaje[], nombre: string) =>
	[...mensajes].reverse().find((m): m is Extract<LLMMensaje, { rol: 'tool' }> => m.rol === 'tool' && m.nombre === nombre)?.resultado as Record<string, any> | undefined;
/** Cuántas vueltas lleva el bucle (respuestas del modelo en esta conversación). */
const vuelta = (mensajes: LLMMensaje[]) => mensajes.filter((m) => m.rol === 'agente').length;

function agente(extra: Partial<ImportAgentOptions> = {}) {
	const p = planes();
	const runner = inProcessRunner({ concurrencia: 3 });
	const eventos: ImportRunEvent[] = [];
	const agent = importAgent({
		destinations: [{ tipo: 'filas', formato: p.formato, modo: 'upsert' }, { tipo: 'descartar' }],
		runs: memoryRunStore(),
		storage: memoryFileStorage(),
		runner,
		onEvent: (e) => eventos.push(e),
		...extra
	});
	return { agent, runner, p, eventos };
}

/** Un PDF con la tabla de planes en la página 1 y una nota en la 2. */
const pdfPlanes = pdfMinimo([
	[
		texto(40, 720, 'GUIA RAPIDA PARA VENDEDOR'),
		...['Modelo', 'Paq', 'Versión', 'Tipo de Pago', 'MSRP', 'Descuento', 'Precio Final'].map((h, i) => texto(40 + i * 75, 700, h)),
		...[
			['AVEO HB 2026', 'A', 'LS Manual', 'CONTADO', '$319,100', '-', '$319,100'],
			['AVEO HB 2026', 'B', 'LT Manual', 'CONTADO', '$346,500', '-', '$346,500'],
			['AVEO HB 2026', 'A', 'LS Manual', 'LEASING', '$319,100', '($81,000)', '$238,100']
		].flatMap((r, j) => r.map((c, i) => texto(40 + i * 75, 685 - j * 15, c)))
	].join('\n'),
	texto(40, 700, 'Notas: vigencia octubre.')
]);

describe('importAgent · con reglas (sin modelo)', () => {
	it('CSV → analizar (P, la tabla del formato, mapeo, review) → importar con upsert', async () => {
		const { agent, runner, p, eventos } = agente();
		const run = await agent.crearCorrida({ instrucciones: 'planes de octubre' });
		const [file] = await agent.agregarArchivo(run.id, { bytes: csvPlanes(FILAS_OK), nombre: 'planes.csv' });
		expect(file).toMatchObject({ nombre: 'planes.csv', tipo: 'text/csv', estado: 'pendiente', carpeta: null });

		await agent.analizar(run.id);
		await runner.vacia();
		let r = await agent.obtener(run.id);
		expect(r.estado).toBe('lista');
		const f = r.archivos[0]!;
		expect(f).toMatchObject({ estado: 'analizado', destino: { tipo: 'filas', formato: 'planes', modo: 'upsert' }, analisis: '3 filas para Planes GMF (pág. 1)' });
		expect(f.filas[1]).toMatchObject({ modelo: 'AVEO HB 2026', paquete: 'A', tipoPago: 'GMF TASA SUBSIDIADA CON SEGURO', precioLista: 319100, descuento: -60000, precioFinal: 259100 });
		expect(f.filas[0]!.descuento).toBeNull();
		expect(f.issues).toEqual([]);
		expect(f.resumen).toMatchObject({ formato: 'planes', rows: 3, modelos: 1 });

		await agent.importar(run.id);
		await runner.vacia();
		r = await agent.obtener(run.id);
		expect(r.estado).toBe('terminada');
		expect(r.archivos[0]!.resultado).toEqual({ status: 'ok', ok: 3, error: 0, resumen: { rows: 3, creados: 3, actualizados: 0, modo: 'upsert' } });
		expect((await p.leer()).map((x) => x.precioFinal)).toEqual([319100, 259100, 270700]);
		// Los avisos de progreso, para el socket de la app.
		expect(eventos.at(-1)).toEqual({ corrida: run.id, tipo: 'corrida', estado: 'terminada', totales: { ok: 3, error: 0, archivos: 1 } });
		expect(eventos.some((e) => e.tipo === 'archivo' && e.estado === 'analizado' && e.mensaje === '3 filas para Planes GMF (pág. 1)')).toBe(true);
	});

	it('progreso en vivo por archivo (la columna Estado, §10) y los stagings descritos por su tabla para el prompt del chat', async () => {
		const { agent, runner } = agente();
		const run = await agent.crearCorrida({});
		const [file] = await agent.agregarArchivo(run.id, { bytes: csvPlanes(FILAS_OK), nombre: 'planes.csv' });
		const vivos: { tipo: string; texto?: string; archivo?: string }[] = [];
		const off = agent.suscribir(run.id, (e) => vivos.push(e as never));
		await agent.analizar(run.id);
		await runner.vacia();
		await agent.importar(run.id, {}, { destinos: ['planes'] });
		await runner.vacia();
		off();
		const progreso = vivos.filter((e) => e.tipo === 'progreso');
		expect(progreso.every((e) => e.archivo === file!.id)).toBe(true);
		expect(progreso.map((e) => e.texto)).toEqual(['empezando…', 'Leyendo «planes.csv»', 'Mapeando 1 tabla a Planes GMF', 'Revisando 3 filas', 'guardando 3 filas…']);
		// (sin `actuales`, el staging no conoce la tabla: todo es nuevo; ya se importó)
		const [planes] = await agent.describirStagings(await agent.obtener(run.id));
		expect(planes).toMatch(/^«Planes GMF» \(planes, actualizar o agregar; la tabla hoy tiene 0 filas\): 3 nuevas, 0 cambiadas, 0 se eliminan; 0 errores, 0 avisos → ya importada\.\n {2}Lo alimentan: «planes\.csv» \(3 filas, importado\)$/);
	});

	it('una fila que rompe la regla: upsert publica las buenas (parcial); replace no publica nada (error)', async () => {
		const malas = [...FILAS_OK, ['ONIX 2026', 'A', 'LS', 'CONTADO', 'RCC', 'HCCN', '$300,000', '($1,000)', '$300,000']];
		for (const modo of ['upsert', 'replace'] as const) {
			const { agent, runner, p } = agente();
			const run = await agent.crearCorrida({});
			const [file] = await agent.agregarArchivo(run.id, { bytes: csvPlanes(malas), nombre: 'planes.csv' });
			await agent.fijarDestino(run.id, file!.id, { tipo: 'filas', formato: 'planes', modo });
			await agent.analizar(run.id);
			await runner.vacia();
			const analizado = (await agent.obtener(run.id)).archivos[0]!;
			expect(analizado.issues).toEqual([{ row: 3, field: 'precioFinal', level: 'error', message: '300000 + (-1000) no da 300000' }]);
			await agent.importar(run.id);
			await runner.vacia();
			const f = (await agent.obtener(run.id)).archivos[0]!;
			if (modo === 'upsert') {
				expect(f.resultado).toMatchObject({ status: 'parcial', ok: 3, error: 1 });
				expect(f.estado).toBe('importado');
				expect(await p.leer()).toHaveLength(3);
				// La mala se queda en la corrida con su error (para el Detalle).
				expect(f.issues).toEqual([expect.objectContaining({ row: 3, field: 'precioFinal' })]);
			} else {
				expect(f.resultado).toMatchObject({ status: 'error', ok: 0, error: 1, mensaje: '1 filas con error: con replace no se publica nada' });
				expect(f.estado).toBe('error');
				expect(await p.leer()).toHaveLength(0);
			}
		}
	});

	it('corregir y reintentar: tras un upsert parcial, las filas rechazadas corregidas se vuelven a importar', async () => {
		const { agent, runner, p } = agente();
		const run = await agent.crearCorrida({});
		const bad = ['ONIX 2026', 'A', 'LS', 'CONTADO', 'RCC', 'HCCN', '$300,000', '($1,000)', '$300,000'];
		const [file] = await agent.agregarArchivo(run.id, { bytes: csvPlanes([...FILAS_OK, bad]), nombre: 'p.csv' });
		await agent.analizar(run.id);
		await runner.vacia();
		await agent.importar(run.id);
		await runner.vacia();
		expect((await agent.obtener(run.id)).archivos[0]).toMatchObject({ estado: 'importado', resultado: { status: 'parcial', ok: 3, error: 1 } });
		const { filas } = await agent.filas(run.id, file!.id);
		// Solo la rechazada, corregida: el archivo vuelve a «analizado» y la corrida a «lista».
		const fixed = await agent.editarFilas(run.id, file!.id, [{ ...filas[3]!, precioFinal: 299000 }]);
		expect(fixed.issues).toEqual([]);
		expect(fixed.archivo).toMatchObject({ estado: 'analizado', resultado: null, totalFilas: 1 });
		expect((await agent.obtener(run.id)).estado).toBe('lista');
		await agent.importar(run.id);
		await runner.vacia();
		expect((await agent.obtener(run.id)).archivos[0]).toMatchObject({ estado: 'importado', resultado: { status: 'ok', ok: 1, error: 0 } });
		expect(await p.leer()).toHaveLength(4);
	});

	it('la persona corrige la fila en el Detalle: se vuelve a revisar', async () => {
		const { agent, runner } = agente();
		const run = await agent.crearCorrida({});
		const [file] = await agent.agregarArchivo(run.id, { bytes: csvPlanes([['ONIX 2026', 'A', 'LS', 'CONTADO', 'RCC', 'HCCN', '$300,000', '($1,000)', '$300,000']]), nombre: 'p.csv' });
		await agent.analizar(run.id);
		await runner.vacia();
		const { filas, issues, schema } = await agent.filas(run.id, file!.id);
		expect(issues).toHaveLength(1);
		expect(schema!.id).toBe('planes');
		const corregidas = await agent.editarFilas(run.id, file!.id, [{ ...filas[0]!, precioFinal: '$299,000' }]);
		expect(corregidas.issues).toEqual([]);
		expect(corregidas.filas[0]!.precioFinal).toBe(299000);
		expect(corregidas.archivo.totalErrores).toBe(0);
	});

	it('sin tabla reconocible no inventa destino; el destino fijado (descartar) se respeta', async () => {
		const { agent, runner } = agente();
		const run = await agent.crearCorrida({});
		const [nota] = await agent.agregarArchivo(run.id, { bytes: Buffer.from('Hola, esto no es una tabla'), nombre: 'nota.txt' });
		const [csv] = await agent.agregarArchivo(run.id, { bytes: csvPlanes(FILAS_OK), nombre: 'otro.csv' });
		await agent.fijarDestino(run.id, csv!.id, { tipo: 'descartar', motivo: 'es del mes pasado' });
		await agent.analizar(run.id);
		await runner.vacia();
		const r = await agent.obtener(run.id);
		expect(r.archivos.find((f) => f.id === nota!.id)).toMatchObject({ destino: null, analisis: 'No se reconoció ninguna tabla de los formatos: elige un destino' });
		expect(r.archivos.find((f) => f.id === csv!.id)).toMatchObject({
			destino: { tipo: 'descartar', motivo: 'es del mes pasado' },
			destinoFijadoPorUsuario: true,
			filas: [],
			analisis: 'Descartado: es del mes pasado'
		});
		// Importar: el descartado queda ok sin filas; el que no tiene destino, en error.
		await agent.importar(run.id);
		await runner.vacia();
		const fin = await agent.obtener(run.id);
		expect(fin.archivos.map((f) => f.resultado)).toEqual([
			{ status: 'error', ok: 0, error: 0, mensaje: 'Sin destino' },
			{ status: 'ok', ok: 0, error: 0, mensaje: 'Descartado: es del mes pasado' }
		]);
	});

	it('una imagen sin modelo de chat: X con generateStructured y el mismo mapeo', async () => {
		const llm: ImportLLM = {
			async generateStructured() {
				return {
					bloques: [{ tipo: 'tabla', encabezados: ['Modelo', 'Versión', 'Tipo de Pago', 'MSRP', 'Precio Final'], filas: [['TRAX 2026', 'LS', 'CONTADO', '$553,200', '$553,200']] }]
				};
			}
		};
		const { agent, runner } = agente({ llm });
		const run = await agent.crearCorrida({});
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		await agent.agregarArchivo(run.id, { bytes: png, nombre: 'foto.png', carpeta: 'fotos/septiembre' });
		await agent.analizar(run.id);
		await runner.vacia();
		const f = (await agent.obtener(run.id)).archivos[0]!;
		expect(f.error).toBeNull();
		expect(f).toMatchObject({ tipo: 'image/png', carpeta: 'fotos/septiembre', estado: 'analizado' });
		expect(f.filas).toEqual([expect.objectContaining({ modelo: 'TRAX 2026', version: 'LS', precioLista: 553200, precioFinal: 553200 })]);
	});
});

describe('importAgent · con un modelo que llama tools (guion)', () => {
	it('analiza un PDF: índice de P, mapeo, propuesta, revisión y su análisis; el modelo recibe destinos, instrucciones y tools', async () => {
		const llamadas: ChatInput[] = [];
		const llm: ImportLLM = {
			generateStructured: async () => ({ bloques: [] }),
			async chat(input): Promise<LLMRespuesta> {
				llamadas.push(structuredClone({ ...input, mensajes: input.mensajes.map((m) => ('partes' in m ? { ...m, partes: m.partes.map((p) => (p.tipo === 'imagen' ? { tipo: 'imagen' } : p)) } : m)) }) as ChatInput);
				const m = input.mensajes;
				switch (vuelta(m)) {
					case 0:
						return { texto: 'Leo la tabla.', llamadas: [{ nombre: 'leerDestino', args: { formato: 'planes' } }, { nombre: 'extraerDeterminista', args: { paginas: [1] } }] };
					case 1: {
						const tabla = ultimo(m, 'extraerDeterminista')!.bloques.find((b: any) => b.tipo === 'tabla');
						return { llamadas: [{ nombre: 'mapearTabla', args: { formato: 'planes', bloques: [tabla.indice] } }] };
					}
					case 2:
						return { llamadas: [{ nombre: 'proponerFilas', args: { formato: 'planes', modo: 'replace', desdeMapeo: true } }, { nombre: 'revisar', args: {} }] };
					default: {
						const r = ultimo(m, 'revisar')!;
						return { llamadas: [{ nombre: 'terminar', args: { analisis: `${r.resumen.rows} planes de ${r.resumen.modelos} modelo, sin errores` } }] };
					}
				}
			}
		};
		const { agent, runner, p } = agente({ llm, model: 'modelo-de-prueba', prompt: 'Los precios van sin IVA.', context: async () => 'La tabla tiene 0 planes hoy.' });
		const run = await agent.crearCorrida({ instrucciones: 'Solo los planes de octubre' });
		const [pdf] = await agent.agregarArchivo(run.id, { bytes: pdfPlanes, nombre: 'PLANES_oct.pdf' });
		// La instrucción de la persona para este archivo llega con su presentación.
		await agent.fijarInstruccion(run.id, pdf!.id, '  solo la página 1  ');
		expect((await agent.obtener(run.id)).archivos[0]!.instruccion).toBe('solo la página 1');
		await agent.analizar(run.id);
		await runner.vacia();

		const f = (await agent.obtener(run.id)).archivos[0]!;
		expect(f).toMatchObject({ estado: 'analizado', analisis: '3 planes de 1 modelo, sin errores', destino: { tipo: 'filas', formato: 'planes', modo: 'replace' }, issues: [] });
		expect(f.filas.map((r) => [r.paquete, r.tipoPago, r.descuento, r.precioFinal])).toEqual([
			['A', 'CONTADO', null, 319100],
			['B', 'CONTADO', null, 346500],
			['A', 'LEASING', -81000, 238100]
		]);
		// Lo que vio el modelo.
		const primera = llamadas[0]!;
		expect(primera.modelo).toBe('modelo-de-prueba');
		expect(primera.sistema).toContain('Eres el agente importador');
		expect(primera.sistema).toContain('Los precios van sin IVA.');
		expect(primera.sistema).toContain('formato «planes» (Planes GMF)');
		expect(primera.sistema).toContain('La tabla tiene 0 planes hoy.');
		expect(primera.sistema).toContain('Solo los planes de octubre');
		expect(primera.tools.map((t) => t.nombre)).toEqual([
			'leerDestino',
			'extraerDeterminista',
			'extraerConLLM',
			'compararExtracciones',
			'verBloque',
			'mapearTabla',
			'proponerFilas',
			'editarFilas',
			'revisar',
			'leerFilasActuales',
			'crearDerivado',
			'fijarDestino',
			'terminar'
		]);
		const presentacion = (primera.mensajes[0] as Extract<LLMMensaje, { rol: 'usuario' }>).partes.map((x) => (x.tipo === 'texto' ? x.texto : '')).join('\n');
		expect(presentacion).toContain('«PLANES_oct.pdf»');
		expect(presentacion).toContain('Instrucción de la persona para este archivo (síguela): solo la página 1');
		expect(presentacion).toContain('pág. 1 · tabla');
		expect(presentacion).toContain('Modelo | Paq | Versión | Tipo de Pago | MSRP | Descuento | Precio Final');
		// La respuesta de cada tool llega casada por id.
		const tool = llamadas[1]!.mensajes.find((x) => x.rol === 'tool' && x.nombre === 'leerDestino') as Extract<LLMMensaje, { rol: 'tool' }>;
		expect(tool.id).toBe('t1');
		expect((tool.resultado as any).columns.precioLista).toMatchObject({ label: 'Precio de lista', aliases: ['MSRP'] });

		await agent.importar(run.id);
		await runner.vacia();
		expect((await agent.obtener(run.id)).archivos[0]!.resultado).toMatchObject({ status: 'ok', ok: 3, error: 0 });
		expect(await p.leer()).toHaveLength(3);
	});

	it('el destino que fijó la persona no se cambia: la tool lo rechaza y el modelo se entera', async () => {
		let rechazo: unknown;
		const llm: ImportLLM = {
			generateStructured: async () => ({ bloques: [] }),
			async chat({ mensajes }) {
				if (vuelta(mensajes) === 0) return { llamadas: [{ nombre: 'proponerFilas', args: { formato: 'planes', filas: [] } }] };
				rechazo = ultimo(mensajes, 'proponerFilas');
				return { llamadas: [{ nombre: 'terminar', args: { analisis: 'Respeto el descarte', destino: { tipo: 'filas', formato: 'planes', modo: 'upsert' } } }] };
			}
		};
		const { agent, runner } = agente({ llm });
		const run = await agent.crearCorrida({});
		const [file] = await agent.agregarArchivo(run.id, { bytes: csvPlanes(FILAS_OK), nombre: 'p.csv' });
		await agent.fijarDestino(run.id, file!.id, { tipo: 'descartar' });
		await agent.analizar(run.id);
		await runner.vacia();
		expect(rechazo).toEqual({ error: 'La persona fijó el destino de «p.csv» (descartar (fijado por la persona: no lo cambies)): no se cambia' });
		expect((await agent.obtener(run.id)).archivos[0]).toMatchObject({ destino: { tipo: 'descartar' }, analisis: 'Respeto el descarte', filas: [] });
	});

	it('chat: «excluye contado» → el agente edita las filas del archivo, revisa y responde', async () => {
		const llm: ImportLLM = {
			generateStructured: async () => ({ bloques: [] }),
			async chat({ sistema, mensajes }) {
				expect(sistema).toContain('instrucción: es el de octubre');
				const ultimoUsuario = [...mensajes].reverse().find((m) => m.rol === 'usuario') as Extract<LLMMensaje, { rol: 'usuario' }>;
				const texto0 = ultimoUsuario.partes[0]!.tipo === 'texto' ? ultimoUsuario.partes[0]!.texto : '';
				if (!texto0.includes('contado')) return { texto: 'ok' };
				const id = /- (\S+) «p\.csv»/.exec(sistema)![1];
				const desde = mensajes.findIndex((m) => m === ultimoUsuario);
				const n = mensajes.slice(desde).filter((m) => m.rol === 'agente').length;
				if (n === 0) return { llamadas: [{ nombre: 'editarFilas', args: { archivo: id, quitarSi: { campo: 'tipoPago', contiene: 'contado' } } }, { nombre: 'revisar', args: { archivo: id } }] };
				const e = ultimo(mensajes, 'editarFilas')!;
				return { texto: `Quité ${e.quitadas} de contado; quedan ${e.total}.` };
			}
		};
		// El análisis va por reglas (el modelo de este guion solo conversa).
		const { agent, runner } = agente();
		const run = await agent.crearCorrida({});
		await agent.agregarArchivo(run.id, { bytes: csvPlanes(FILAS_OK), nombre: 'p.csv' });
		await agent.analizar(run.id);
		await runner.vacia();
		const conChat = importAgent({ destinations: [{ tipo: 'filas', formato: planes().formato }], runs: (agent as any).options.runs, storage: (agent as any).options.storage, llm });
		await conChat.fijarInstruccion(run.id, 'p.csv', 'es el de octubre');
		const { mensaje, corrida } = await conChat.chat(run.id, 'Excluye los planes de contado');
		expect(mensaje).toMatchObject({ rol: 'agente', texto: 'Quité 1 de contado; quedan 2.' });
		// Antes, el veredicto del análisis (sin LLM); luego la conversación.
		expect(corrida.chat.map((m) => m.rol)).toEqual(['agente', 'usuario', 'agente']);
		expect(corrida.archivos[0]).toMatchObject({ totalFilas: 2, totalErrores: 0 });
		// Una segunda vuelta lleva el historial del chat.
		await conChat.chat(run.id, 'gracias');
		expect((await conChat.obtener(run.id)).chat).toHaveLength(5);
	});

	it('adjuntar: el modelo deja un derivado y el destino; importar llama a attach de la app', async () => {
		const adjuntados: any[] = [];
		const llm: ImportLLM = {
			generateStructured: async () => ({ bloques: [] }),
			async chat({ mensajes }) {
				if (vuelta(mensajes) > 0) return { texto: 'listo' };
				return {
					llamadas: [
						{ nombre: 'crearDerivado', args: { nombre: 'ficha.md', contenido: '# Aveo HB\n- Motor: 1.5 L' } },
						{ nombre: 'terminar', args: { analisis: 'Ficha técnica del Aveo HB', destino: { tipo: 'adjuntar', adjunto: 'fichas', fila: 'aveo-hb-c', campo: 'folder' } } }
					]
				};
			}
		};
		const { agent, runner } = agente({
			llm,
			destinations: [
				{ tipo: 'filas', formato: planes().formato },
				{ tipo: 'adjuntar', id: 'fichas', label: 'Fichas técnicas', attach: (input) => void adjuntados.push(input) }
			]
		});
		const run = await agent.crearCorrida({ contexto: { cuenta: 'chevrolet' } } as any);
		await agent.agregarArchivo(run.id, { bytes: Buffer.from('Ficha técnica Aveo HB: motor 1.5 L'), nombre: 'ficha.txt' });
		await agent.analizar(run.id);
		await runner.vacia();
		expect((await agent.obtener(run.id)).archivos[0]).toMatchObject({ destino: { tipo: 'adjuntar', adjunto: 'fichas', fila: 'aveo-hb-c' }, analisis: 'Ficha técnica del Aveo HB' });
		await agent.importar(run.id);
		await runner.vacia();
		expect(adjuntados).toHaveLength(1);
		expect(adjuntados[0]).toMatchObject({
			destino: { tipo: 'adjuntar', adjunto: 'fichas', fila: 'aveo-hb-c', campo: 'folder' },
			archivo: { nombre: 'ficha.txt', tipo: 'text/plain' },
			derivados: [{ nombre: 'ficha.md', tipo: 'text/markdown', contenido: '# Aveo HB\n- Motor: 1.5 L' }],
			contexto: { cuenta: 'chevrolet' }
		});
		expect((await agent.obtener(run.id)).archivos[0]!.resultado).toEqual({ status: 'ok', ok: 1, error: 0 });
	});

	it('una tool que falla o que no existe vuelve al modelo como error; el bucle tiene tope de vueltas; meta vuelve tal cual', async () => {
		let vistos: unknown[] = [];
		let vueltas = 0;
		let metas: unknown[] = [];
		const llm: ImportLLM = {
			generateStructured: async () => ({ bloques: [] }),
			async chat({ mensajes }) {
				vueltas++;
				vistos = mensajes.filter((m) => m.rol === 'tool').map((m) => (m as any).resultado);
				metas = mensajes.filter((m) => m.rol === 'agente').map((m) => (m as any).meta);
				// `meta`: lo opaco que el proveedor exige de vuelta (las thoughtSignature de Gemini 3).
				return { llamadas: [{ nombre: 'noExiste', args: {} }, { nombre: 'verBloque', args: { bloque: 0, metodo: 'X' } }], meta: { firma: vueltas } };
			}
		};
		const { agent, runner } = agente({ llm, maxIteraciones: 3 });
		const run = await agent.crearCorrida({});
		await agent.agregarArchivo(run.id, { bytes: csvPlanes(FILAS_OK), nombre: 'p.csv' });
		await agent.analizar(run.id);
		await runner.vacia();
		expect(vueltas).toBe(3);
		expect(metas).toEqual([{ firma: 1 }, { firma: 2 }]);
		expect(vistos.slice(0, 2)).toEqual([{ error: 'No existe la tool «noExiste»' }, { error: 'Primero extrae el archivo con el método X' }]);
		// Sin terminar ni filas: queda analizado, con el análisis por omisión.
		expect((await agent.obtener(run.id)).archivos[0]).toMatchObject({ estado: 'analizado', analisis: 'Sin destino' });
	});
});

describe('importAgent · corrida, límites y concurrencia', () => {
	it('límites: tamaño por archivo, total de la corrida y tipos', async () => {
		const { agent } = agente({ limits: { maxArchivoMB: 0.001, maxLoteMB: 0.0015, tipos: ['csv', 'txt'] } });
		const run = await agent.crearCorrida({});
		await expect(agent.agregarArchivo(run.id, { bytes: Buffer.alloc(2000, 65), nombre: 'grande.txt' })).rejects.toMatchObject({ status: 413, code: 'file_too_large' });
		await expect(agent.agregarArchivo(run.id, { bytes: Buffer.from('MZ\u0000\u0001'), nombre: 'virus.exe' })).rejects.toMatchObject({ status: 415 });
		await expect(agent.agregarArchivo(run.id, { bytes: Buffer.from('<html><script>x</script></html>'), nombre: 'a.txt' })).rejects.toMatchObject({ status: 415 });
		await agent.agregarArchivo(run.id, { bytes: Buffer.alloc(900, 65), nombre: 'a.txt' });
		await expect(agent.agregarArchivo(run.id, { bytes: Buffer.alloc(900, 65), nombre: 'b.txt' })).rejects.toMatchObject({ status: 413, code: 'batch_too_large' });
	});

	it('muchos archivos analizados a la vez no se pisan (control de versión de la corrida)', async () => {
		const { agent, runner } = agente();
		const run = await agent.crearCorrida({});
		for (let i = 0; i < 8; i++) await agent.agregarArchivo(run.id, { bytes: csvPlanes([FILAS_OK[i % 3]!]), nombre: `p${i}.csv` });
		await agent.analizar(run.id);
		await runner.vacia();
		const r = await agent.obtener(run.id);
		expect(r.archivos.map((f) => [f.estado, f.filas.length])).toEqual(Array(8).fill(['analizado', 1]));
		expect(r.version).toBeGreaterThan(8 * 3);
	});

	it('el almacén rechaza una versión vieja; las corridas vencidas desaparecen', async () => {
		const store = memoryRunStore();
		const { agent } = agente({ runs: store, limits: { retencionDias: 0 } });
		const run = await agent.crearCorrida({});
		expect(await store.obtener(run.id)).toBeNull();
		const { agent: otro } = agente({ runs: store });
		const vivo = await otro.crearCorrida({});
		expect(await store.guardar({ ...vivo, instrucciones: 'x' }, vivo.version + 5)).toBe(false);
		expect(await store.guardar({ ...vivo, instrucciones: 'x', version: 2 }, vivo.version)).toBe(true);
	});

	it('dueño: otra persona no ve la corrida', async () => {
		const { agent } = agente({ owner: (ctx) => (ctx.usuario as string) ?? null });
		const run = await agent.crearCorrida({}, { usuario: 'ana' });
		expect((await agent.obtener(run.id, { usuario: 'ana' })).propietario).toBe('ana');
		await expect(agent.obtener(run.id, { usuario: 'beto' })).rejects.toMatchObject({ status: 404 });
		expect(await agent.listar({ usuario: 'beto' })).toEqual([]);
		expect((await agent.listar({ usuario: 'ana' })).map((r) => r.id)).toEqual([run.id]);
	});
});

describe('importAgent · rediseño v2, fase A', () => {
	it('config trae la bienvenida del chat: qué hace, que las instrucciones van en el chat y los destinos (o la de la app)', async () => {
		const { agent } = agente();
		const { bienvenida } = agent.config();
		expect(bienvenida).toContain('Las instrucciones generales me las das aquí, en el chat');
		expect(bienvenida).toContain('«los planes de octubre reemplazan a los de septiembre»');
		expect(bienvenida).toContain('• Filas → Planes GMF (actualizar o agregar, reemplazar todo)');
		expect(bienvenida).toContain('• Descartar');
		expect(agente({ bienvenida: (d) => `Hola: ${d.length} destinos` }).agent.config().bienvenida).toBe('Hola: 2 destinos');
	});

	it('lo que se escribe en el chat antes de analizar son las instrucciones de la corrida, y el análisis las lee', async () => {
		// Sin modelo: se anota.
		const { agent } = agente();
		const run = await agent.crearCorrida({});
		const { mensaje, corrida } = await agent.chat(run.id, 'ignora los seminuevos');
		expect(mensaje.texto).toBe('Anotado: lo tomo en cuenta al analizar.');
		expect(corrida.instrucciones).toBe('ignora los seminuevos');

		// Con modelo: también contesta, y el análisis recibe las instrucciones en su sistema.
		const sistemas: string[] = [];
		const llm: ImportLLM = {
			generateStructured: async () => ({ bloques: [] }),
			async chat({ sistema, mensajes }) {
				sistemas.push(sistema);
				const pedido = (mensajes[0] as Extract<LLMMensaje, { rol: 'usuario' }>).partes[0];
				if (pedido?.tipo === 'texto' && pedido.texto.startsWith('Archivo a analizar')) return { llamadas: [{ nombre: 'terminar', args: { analisis: 'visto' } }] };
				return { texto: 'Entendido: sin seminuevos.' };
			}
		};
		const conLLM = agente({ llm });
		const r2 = await conLLM.agent.crearCorrida({});
		await conLLM.agent.agregarArchivo(r2.id, { bytes: csvPlanes(FILAS_OK), nombre: 'p.csv' });
		const chat = await conLLM.agent.chat(r2.id, 'ignora los seminuevos');
		expect(chat.mensaje.texto).toBe('Entendido: sin seminuevos.');
		expect(sistemas[0]).toContain('Todavía no se analiza ningún archivo');
		expect(chat.corrida.instrucciones).toBe('ignora los seminuevos');
		await conLLM.agent.analizar(r2.id);
		await conLLM.runner.vacia();
		expect(sistemas.at(-1)).toContain('Instrucciones de la persona para esta corrida:\nignora los seminuevos');
		// Ya analizado, el chat ya no suma a las instrucciones (con modelo, conversa).
		await conLLM.agent.chat(r2.id, '¿cuántas filas hay?');
		expect((await conLLM.agent.obtener(r2.id)).instrucciones).toBe('ignora los seminuevos');
	});

	it('duplicados: las filas idénticas en todo se unen con un aviso; con la misma llave pero distintas, error que nombra las dos y en qué difieren', async () => {
		const { agent, runner } = agente();
		const run = await agent.crearCorrida({});
		const misma = ['AVEO HB 2026', 'B', 'LT Manual', 'LEASING', 'RCC', 'LCCN', '$350,000', '($79,300)', '$270,700'];
		await agent.agregarArchivo(run.id, { bytes: csvPlanes([...FILAS_OK, FILAS_OK[1]!, FILAS_OK[0]!, misma]), nombre: 'p.csv' });
		await agent.analizar(run.id);
		await runner.vacia();
		const f = (await agent.obtener(run.id)).archivos[0]!;
		expect(f.filas).toHaveLength(4);
		expect(f.issues).toEqual([
			{ row: 3, field: 'version', level: 'error', message: 'Misma llave que la fila 3 pero difieren en Precio de lista (346500 ≠ 350000), Descuento (-75800 ≠ -79300)' },
			{ row: null, level: 'warning', message: '2 filas duplicadas idénticas se unieron' }
		]);
		expect(f.resumen).toMatchObject({ unidas: 2 });
		// La persona quita la repetida en la hoja de staging: el aviso de las unidas se queda.
		const fixed = await agent.editarFilas(run.id, f.id, f.filas.slice(0, 3));
		expect(fixed.issues).toEqual([{ row: null, level: 'warning', message: '2 filas duplicadas idénticas se unieron' }]);
		expect(fixed.archivo).toMatchObject({ totalFilas: 3, totalErrores: 0, totalAvisos: 1 });
	});

	it('el chat siempre reporta: un veredicto por archivo al terminar su análisis y un resumen al terminar de importar', async () => {
		const { agent, runner } = agente();
		const run = await agent.crearCorrida({});
		const mala = ['ONIX 2026', 'A', 'LS', 'LEASING', 'RCC', 'LCCN', '$300,000', '($1,000)', '$300,000'];
		const [bueno] = await agent.agregarArchivo(run.id, { bytes: csvPlanes(FILAS_OK), nombre: 'planes.csv' });
		const [malo] = await agent.agregarArchivo(run.id, { bytes: csvPlanes([...FILAS_OK, mala]), nombre: 'otros.csv' });
		const [nota] = await agent.agregarArchivo(run.id, { bytes: Buffer.from('Vigencia octubre'), nombre: 'notas.txt' });
		await agent.fijarDestino(run.id, bueno!.id, { tipo: 'filas', formato: 'planes', modo: 'replace' });
		await agent.fijarDestino(run.id, nota!.id, { tipo: 'descartar' });
		await agent.analizar(run.id);
		await runner.vacia();
		let chat = (await agent.obtener(run.id)).chat;
		expect(chat.every((m) => m.rol === 'agente')).toBe(true);
		expect(chat.map((m) => m.texto).sort()).toEqual([
			'notas.txt: se descarta.',
			'otros.csv: 4 filas, 1 con error en Precio Final; ábrelo para verlos.',
			'planes.csv: 3 filas, 0 errores, listo para reemplazar.'
		]);
		expect(malo).toBeDefined();

		await agent.importar(run.id);
		await runner.vacia();
		chat = (await agent.obtener(run.id)).chat;
		expect(chat).toHaveLength(4);
		const [head, ...lines] = chat.at(-1)!.texto.split('\n');
		expect(head).toBe('Importación terminada: 6 filas importadas, 1 con error.');
		expect(lines.sort()).toEqual([
			'• notas.txt: descartado.',
			'• otros.csv: 3 importadas, 1 con error en Precio Final; ábrelo para corregirlas.',
			'• planes.csv: 3 filas importadas.'
		]);
	});
});
