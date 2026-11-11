/**
 * Las rutas del asistente de importación (SB-36), ya conectadas al agente.
 * El contrato JSON está en core (`ImportRunView`, `ImportFileRows`…).
 *
 *   GET    /config                                destinos y límites
 *   GET    /runs                                  las corridas de quien pide (?origen= las de esa tabla)
 *   POST   /runs                                  { instrucciones?, origen? } → corrida nueva (201)
 *   GET    /runs/:run                             la corrida (sin las filas de cada archivo)
 *   PATCH  /runs/:run                             { instrucciones }
 *   POST   /runs/:run/files                       bytes del archivo; X-File-Name y X-Folder → archivos (201; un zip se abre)
 *   DELETE /runs/:run/files/:file
 *   PUT    /runs/:run/files/:file/destination     { destino | null } → la persona lo fija (o lo suelta)
 *   PUT    /runs/:run/files/:file/instruction     { instruccion | null } → la instrucción para ese archivo
 *   GET    /runs/:run/files/:file/rows            filas, problemas y esquema del formato (Detalle)
 *   PUT    /runs/:run/files/:file/rows            { filas } → corregidas por la persona; se vuelven a revisar
 *   POST   /runs/:run/analyze                     { archivos? } → encola el análisis (202)
 *   POST   /runs/:run/chat                        { texto } → { mensaje, corrida }
 *   POST   /runs/:run/import                      { staging?, destinos? } → encola la importación (202); `staging`: destinos ya guardados en su hoja;
 *                                                  `destinos`: importar solo esos stagings (la corrida sigue abierta mientras falten otros)
 *   GET    /runs/:run/staging?destino=&modo=      la tabla destino con los cambios de toda la corrida (ImportChangeSet, §8.3)
 *   PUT    /runs/:run/staging                     { destino, cambios?, error? } → las ediciones de la persona (o el error al guardar); avisa al cerebro (`staging_editado`)
 *   GET    /runs/:run/events                      SSE: texto del chat por partes, progreso, costo y eventos (cerebro, §9)
 *   POST   /runs/:run/stop                        «Detener»: corta lo que hace el cerebro → { detenido }
 *
 * El progreso se lee volviendo a pedir la corrida, o lo empuja la app con
 * `onEvent` (socket).
 */
import express, { Router } from 'express';
import type { Request } from 'express';
import type { CellValue, ImportDestination } from '@spreadbase/core';
import { SpreadBaseError, ValidationError } from '../errors.ts';
import { vista, vistaArchivo } from './agent.ts';
import type { ImportAgent } from './agent.ts';
import { guardarStagingCorrida, parseStagingEdit, stagingDeCorrida } from './stagingCorrida.ts';

export interface ImportAssistantRoutesOptions {
	/** El contexto de la petición (usuario, cuenta): se guarda en la corrida y lo reciben `review`, `apply` y `attach`. */
	context?: (req: Request) => Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const header = (req: Request, name: string) => {
	const raw = req.get(name) ?? '';
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
};

function parseDestino(body: unknown): ImportDestination | null {
	if (!isRecord(body) || !('destino' in body)) throw new ValidationError('Falta destino (o null para soltarlo)');
	const d = body.destino;
	if (d === null) return null;
	if (!isRecord(d) || typeof d.tipo !== 'string') throw new ValidationError('destino debe ser { tipo, … }');
	if (d.tipo === 'filas') {
		if (typeof d.formato !== 'string') throw new ValidationError('Un destino filas necesita formato');
		if (d.modo !== 'upsert' && d.modo !== 'replace') throw new ValidationError('modo debe ser upsert o replace');
		return { tipo: 'filas', formato: d.formato, modo: d.modo };
	}
	if (d.tipo === 'adjuntar') {
		if (typeof d.adjunto !== 'string') throw new ValidationError('Un destino adjuntar necesita adjunto');
		return { ...d, tipo: 'adjuntar', adjunto: d.adjunto };
	}
	if (d.tipo === 'descartar') return { tipo: 'descartar', ...(typeof d.motivo === 'string' ? { motivo: d.motivo } : {}) };
	throw new ValidationError('tipo debe ser filas, adjuntar o descartar');
}

export function importAssistantRoutes(agent: ImportAgent, options: ImportAssistantRoutesOptions = {}): Router {
	const router = Router();
	const ctx = (req: Request) => options.context?.(req) ?? {};
	const json = express.json({ limit: '20mb' });
	const id = (req: Request, name = 'run') => String(req.params[name]);
	const { maxArchivoMB } = agent.config().limites;

	router.get('/config', (_req, res) => {
		res.json(agent.config());
	});
	router.get('/runs', async (req, res) => {
		const runs = await agent.listar(ctx(req));
		// `?origen=Planes GMF`: las corridas abiertas desde esa tabla (para retomar la que quedó a medias).
		const origen = typeof req.query.origen === 'string' ? req.query.origen : null;
		res.json(origen === null ? runs : runs.filter((r) => r.contexto.origen === origen));
	});
	router.post('/runs', json, async (req, res) => {
		const body = isRecord(req.body) ? req.body : {};
		const instrucciones = typeof body.instrucciones === 'string' ? body.instrucciones : '';
		const context = ctx(req);
		// La tabla desde donde se abrió el asistente queda en el contexto de la corrida.
		const contexto = typeof body.origen === 'string' && body.origen ? { ...context, origen: body.origen } : context;
		res.status(201).json(vista(await agent.crearCorrida({ instrucciones, contexto }, context)));
	});
	router.get('/runs/:run', async (req, res) => {
		res.json(vista(await agent.obtener(id(req), ctx(req))));
	});
	router.patch('/runs/:run', json, async (req, res) => {
		if (!isRecord(req.body) || typeof req.body.instrucciones !== 'string') throw new ValidationError('instrucciones debe ser texto');
		res.json(vista(await agent.cambiarInstrucciones(id(req), req.body.instrucciones, ctx(req))));
	});
	router.post(
		'/runs/:run/files',
		(req, res, next) => {
			express.raw({ type: () => true, limit: maxArchivoMB * 1_048_576 })(req, res, (err?: unknown) => {
				if ((err as { type?: string } | undefined)?.type === 'entity.too.large') {
					return next(new SpreadBaseError(413, 'file_too_large', `El archivo pasa de ${maxArchivoMB} MB`));
				}
				next(err);
			});
		},
		async (req, res) => {
			const bytes = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
			const nombre = header(req, 'X-File-Name');
			if (!nombre) throw new ValidationError('Falta el nombre del archivo (X-File-Name)');
			const carpeta = header(req, 'X-Folder') || null;
			res.status(201).json((await agent.agregarArchivo(id(req), { bytes, nombre, carpeta }, ctx(req))).map(vistaArchivo));
		}
	);
	router.delete('/runs/:run/files/:file', async (req, res) => {
		res.json(vista(await agent.quitarArchivo(id(req), id(req, 'file'), ctx(req))));
	});
	router.put('/runs/:run/files/:file/destination', json, async (req, res) => {
		res.json(vista(await agent.fijarDestino(id(req), id(req, 'file'), parseDestino(req.body), ctx(req))));
	});
	router.put('/runs/:run/files/:file/instruction', json, async (req, res) => {
		const value = isRecord(req.body) ? req.body.instruccion : undefined;
		if (value !== null && typeof value !== 'string') throw new ValidationError('instruccion debe ser texto o null');
		res.json(vista(await agent.fijarInstruccion(id(req), id(req, 'file'), value, ctx(req))));
	});
	router.get('/runs/:run/files/:file/rows', async (req, res) => {
		res.json(await agent.filas(id(req), id(req, 'file'), ctx(req)));
	});
	router.put('/runs/:run/files/:file/rows', json, async (req, res) => {
		const filas = isRecord(req.body) ? req.body.filas : null;
		if (!Array.isArray(filas) || !filas.every(isRecord)) throw new ValidationError('filas debe ser una lista de objetos');
		res.json(await agent.editarFilas(id(req), id(req, 'file'), filas as Record<string, CellValue>[], ctx(req)));
	});
	router.post('/runs/:run/analyze', json, async (req, res) => {
		const archivos = isRecord(req.body) && Array.isArray(req.body.archivos) ? req.body.archivos.map(String) : undefined;
		res.status(202).json(vista(await agent.analizar(id(req), { archivos }, ctx(req))));
	});
	router.post('/runs/:run/chat', json, async (req, res) => {
		if (!isRecord(req.body) || typeof req.body.texto !== 'string') throw new ValidationError('texto debe ser texto');
		res.json(await agent.chat(id(req), req.body.texto, ctx(req)));
	});
	router.post('/runs/:run/import', json, async (req, res) => {
		// `{ staging: [{ destino, resumen }] }`: el cliente ya guardó esos destinos en su hoja (§8.3).
		const staging = isRecord(req.body) && Array.isArray(req.body.staging) ? req.body.staging.filter(isRecord) : [];
		const publicados = staging.map((s) => {
			if (typeof s.destino !== 'string') throw new ValidationError('staging[].destino debe ser texto');
			const r = isRecord(s.resumen) ? s.resumen : {};
			return { destino: s.destino, resumen: { insert: Number(r.insert) || 0, update: Number(r.update) || 0, delete: Number(r.delete) || 0 } };
		});
		// `{ destinos: ['planes'] }`: solo esos stagings (§10).
		const rawDestinos = isRecord(req.body) ? req.body.destinos : undefined;
		if (rawDestinos !== undefined && (!Array.isArray(rawDestinos) || !rawDestinos.every((d) => typeof d === 'string' && d))) throw new ValidationError('destinos debe ser una lista de formatos');
		const destinos = rawDestinos as string[] | undefined;
		// Lo que no emparejó (archivos que iban a una columna) queda dicho en su resultado.
		const conSueltos = await Promise.all(
			publicados.map(async (p) => ({ ...p, sinEmparejar: (await stagingDeCorrida(agent, id(req), p.destino, ctx(req)).catch(() => null))?.set.sinEmparejar ?? [] }))
		);
		res.status(202).json(vista(await agent.importar(id(req), ctx(req), { ...(conSueltos.length ? { staging: conSueltos } : {}), ...(destinos?.length ? { destinos } : {}) })));
	});
	// Staging (S, §8.3): la tabla destino con los cambios de toda la corrida.
	router.get('/runs/:run/staging', async (req, res) => {
		const destino = typeof req.query.destino === 'string' ? req.query.destino : '';
		if (!destino) throw new ValidationError('Falta ?destino=');
		const modo = req.query.modo === 'upsert' || req.query.modo === 'replace' ? req.query.modo : undefined;
		res.json((await stagingDeCorrida(agent, id(req), destino, ctx(req), modo)).set);
	});
	router.put('/runs/:run/staging', json, async (req, res) => {
		res.json(await guardarStagingCorrida(agent, id(req), parseStagingEdit(req.body), ctx(req)));
	});
	// Cerebro (fase B, docs/05 §9): la corrida en vivo por SSE y «Detener».
	router.get('/runs/:run/events', async (req, res) => {
		const run = id(req);
		await agent.obtener(run, ctx(req));
		res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
		res.write(': conectado\n\n');
		const off = agent.suscribir(run, (e) => res.write(`event: ${e.tipo}\ndata: ${JSON.stringify(e)}\n\n`));
		const beat = setInterval(() => res.write(': latido\n\n'), 15_000);
		req.on('close', () => {
			clearInterval(beat);
			off();
		});
	});
	router.post('/runs/:run/stop', async (req, res) => {
		res.json(await agent.detener(id(req), ctx(req)));
	});
	return router;
}
