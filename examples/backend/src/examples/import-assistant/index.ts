/**
 * Ejemplo del asistente de importación con agente (SB-36). Montado en
 * /api/import-assistant.
 *
 * Lo que pone la app —aquí, el ejemplo—: el LLM (uno de guion por omisión;
 * Gemini con `IMPORT_ASSISTANT_LLM=gemini` y `GEMINI_API_KEY`), dónde se
 * guardan los archivos (la carpeta de subidas), las corridas (en memoria) y
 * los destinos: el formato «Planes GMF» (SB-34), adjuntar a una «ficha» (solo
 * registra) y descartar. El resto —bucle del agente, tools, corrida, cola,
 * rutas— es de SpreadBase.
 *
 *   /api/import-assistant/config, /runs…   las rutas del asistente (importAssistantRoutes)
 *   /api/import-assistant/planes           la tabla destino, como hoja (lo importado)
 *   /api/import-assistant/fichas           lo que se «adjuntó» (en memoria)
 */
import express, { Router } from 'express';
import { importAgent, importAssistantRoutes, inProcessRunner, memoryRunStore, sheetRouter } from '@spreadbase/server';
import type { CellValue, ImportAttachInput } from '@spreadbase/server';
import { uploadsFor } from '../../common/uploads.ts';
import { geminiLLM } from './gemini.ts';
import { llmDeEjemplo } from './llmDeEjemplo.ts';
import { env } from '../../config/env.ts';
import { IDENTIDAD, PLANES_INICIALES, planesFormat, planesSheet, planesSource } from './planes.ts';

/** Lo «adjuntado»: en una app, el folder de la fila (Aggy: campo `folder` + GCS). */
const fichas: { archivo: string; url: string; destino: ImportAttachInput['destino']; derivados: string[]; fecha: string }[] = [];

export function createImportAssistantExample(): Router {
	// Gemini solo si se pide explícitamente: una llave en .env no se gasta sin querer.
	const key = process.env.GEMINI_API_KEY;
	const llm = key && process.env.IMPORT_ASSISTANT_LLM === 'gemini' ? geminiLLM({ apiKey: key, model: process.env.GEMINI_MODEL }) : llmDeEjemplo('planes');

	const agent = importAgent({
		llm,
		prompt: 'Los planes vienen del boletín mensual de GM. Cada fila es un modelo, paquete, versión y tipo de pago.',
		destinations: [
			// El staging (§8.3) se abre sobre la hoja de la tabla (`sheetUrl`, relativa a esta base) y compara por la identidad del plan.
			{ tipo: 'filas', formato: planesFormat, modo: 'replace', actuales: planesSheet, llave: IDENTIDAD, sheetUrl: 'planes' },
			{
				tipo: 'adjuntar',
				id: 'fichas',
				label: 'Ficha técnica',
				description: 'El archivo va al folder de la versión (con su ficha.md si el agente la escribe)',
				attach: ({ archivo, destino, derivados }) => {
					fichas.push({ archivo: archivo.nombre, url: archivo.url, destino, derivados: derivados.map((d) => d.nombre), fecha: new Date().toISOString() });
					return { resumen: { adjuntos: fichas.length } };
				}
			},
			// Archivos que van a una columna de la fila que empareja por nombre (SB-38): se ven en el staging y se guardan con la hoja.
			{ tipo: 'adjuntar', id: 'imagen', label: 'Imagen del plan', description: 'Una foto de la unidad: va a la columna Imagen de sus planes', columna: { formato: 'planes', campo: 'imagen', emparejar: ['modelo', 'version', 'paquete'] } },
			{ tipo: 'adjuntar', id: 'archivos', label: 'Archivos del plan', description: 'Se suma a la carpeta Archivos de sus planes', columna: { formato: 'planes', campo: 'archivos', emparejar: ['modelo', 'version', 'paquete'] } },
			{ tipo: 'adjuntar', id: 'ficha', label: 'Ficha técnica en texto', description: 'El contenido (md) va a la columna Ficha técnica de sus planes', columna: { formato: 'planes', campo: 'fichaTecnica', emparejar: ['modelo', 'version', 'paquete'] } },
			{ tipo: 'descartar' }
		],
		runs: memoryRunStore(),
		// El ejemplo usa el agente de siempre; una app enchufa su cerebro con `brain` (docs/05 §9).
		runner: inProcessRunner({ concurrencia: 2 }),
		storage: uploadsFor('import-assistant'),
		// En una app real, el usuario de la sesión; aquí, una cabecera opcional.
		owner: (ctx) => (ctx.usuario as string) ?? null,
		onEvent: (e) => {
			if (process.env.IMPORT_LOG !== '0') console.log(`[import-assistant] ${e.tipo} ${e.archivo ?? e.corrida} ${e.estado ?? ''} ${e.mensaje ?? ''}`.trim());
		}
	});

	const router = Router();
	// Solo en test: las pruebas parten de la tabla que necesitan (o de los planes «de septiembre»).
	if (env.appEnv === 'test') {
		router.post('/planes/dev/reset', express.json({ limit: '5mb' }), (req, res) => {
			const rows = Array.isArray(req.body?.rows) ? (req.body.rows as Record<string, CellValue>[]) : PLANES_INICIALES;
			planesSource.reset(rows.map((r, i) => ({ id: `pl_${String(i + 1).padStart(5, '0')}`, ...r })));
			res.json({ rows: rows.length });
		});
	}
	router.use('/planes', sheetRouter(planesSheet));
	router.get('/fichas', (_req, res) => {
		res.json(fichas);
	});
	router.use(importAssistantRoutes(agent, { context: (req) => ({ usuario: req.get('X-User') ?? 'demo' }) }));
	return router;
}
