import cors from 'cors';
import express from 'express';
import { errorHandler, notFoundHandler } from './common/errors.ts';
import { simulatedLatency } from './common/latency.ts';
import { env } from './config/env.ts';
import { createCasesRoutes } from './modules/cases/cases.routes.ts';
import { CasesService } from './modules/cases/cases.service.ts';

/**
 * Construye la app sin escuchar en ningún puerto, para poder montarla en
 * pruebas sin abrir sockets.
 */
export function createApp() {
	const app = express();

	app.use(cors({ origin: env.corsOrigin }));
	// Un lote de guardado con miles de filas supera el límite por defecto (100 kB).
	app.use(express.json({ limit: '10mb' }));

	app.get('/api/health', (_req, res) => {
		res.json({ ok: true, env: env.appEnv });
	});

	const cases = new CasesService(env.cases.rows, env.cases.policy);
	app.use(
		'/api/cases',
		simulatedLatency(env.latencyMs),
		createCasesRoutes(cases, { devRoutes: env.appEnv === 'test' })
	);

	app.use(notFoundHandler);
	app.use(errorHandler);
	return app;
}
