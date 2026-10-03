import cors from 'cors';
import express, { Router } from 'express';
import { errorHandler, notFoundHandler } from './common/errors.ts';
import { simulatedLatency } from './common/latency.ts';
import { serveUploads, uploadsFor } from './common/uploads.ts';
import { env } from './config/env.ts';
import { createBasicExample } from './examples/basic/index.ts';
import { createImportsExample } from './examples/imports/index.ts';
import { createCasesRoutes } from './examples/cases/cases.routes.ts';
import { CasesService } from './examples/cases/cases.service.ts';

/**
 * El servidor de los ejemplos. La base común está aquí (CORS, JSON, salud,
 * errores); cada ejemplo vive en `src/examples/<nombre>/` y se monta bajo
 * `/api/<nombre>`.
 */
export async function createApp() {
	const app = express();

	app.use(cors({ origin: env.corsOrigin }));
	// Un lote de guardado con miles de filas supera el límite por defecto (100 kB).
	app.use(express.json({ limit: '10mb' }));

	// Lo que se sube a las columnas de imagen y archivo (SB-30).
	app.use('/uploads', serveUploads());

	app.get('/api/health', (_req, res) => {
		res.json({ ok: true, env: env.appEnv, postgres: Boolean(env.databaseUrl) });
	});

	// Básico: contactos en memoria, con sheetRouter.
	app.use('/api/basic', createBasicExample());
	app.use('/api/imports', createImportsExample());

	// Casos: 50 000 filas en capas, con latencia simulada. Contra este corren las pruebas E2E.
	const cases = new CasesService(env.cases.rows, env.cases.policy, uploadsFor('cases'));
	app.use('/api/cases', simulatedLatency(env.cases.latencyMs), createCasesRoutes(cases, { devRoutes: env.appEnv === 'test' }));

	// Postgres: la tienda estilo Aggy. Solo si hay base; si no, avisa sin tumbar el servidor.
	app.use('/api/postgres', env.databaseUrl ? (await import('./examples/postgres/index.js')).createPostgresExample() : noDatabase());

	app.use(notFoundHandler);
	app.use(errorHandler);
	return app;
}

function noDatabase(): Router {
	const router = Router();
	router.use((_req, res) => {
		res.status(503).json({
			error: { code: 'database_not_configured', message: 'El ejemplo Postgres necesita DATABASE_URL en SpreadBase/.env' }
		});
	});
	return router;
}
