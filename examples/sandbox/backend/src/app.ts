import cors from 'cors';
import express from 'express';
import { errorHandler, notFoundHandler } from './common/errors.ts';
import { simulatedLatency } from './common/latency.ts';
import { env } from './config/env.ts';
import { createSandboxRoutes } from './modules/sandbox/sandbox.routes.ts';
import { SandboxService } from './modules/sandbox/sandbox.service.ts';

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
		res.json({ ok: true });
	});

	const sandbox = new SandboxService(env.sandbox.rows, env.sandbox.remoteChanges);
	app.use('/api/sandbox', simulatedLatency(env.sandbox.latencyMs), createSandboxRoutes(sandbox));

	app.use(notFoundHandler);
	app.use(errorHandler);
	return app;
}
