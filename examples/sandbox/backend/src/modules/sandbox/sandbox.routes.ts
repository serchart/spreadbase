import { Router } from 'express';
import { idempotent } from '../../common/idempotency.ts';
import { SandboxController } from './sandbox.controller.ts';
import type { SandboxService } from './sandbox.service.ts';

/**
 * Rutas del sandbox. Base: `/api/sandbox`.
 *
 * Express 5 propaga solo los errores de los manejadores, también los
 * asíncronos, así que no hace falta envolverlos.
 */
export function createSandboxRoutes(service: SandboxService): Router {
	const router = Router();
	const controller = new SandboxController(service);

	// GET /api/sandbox/catalogs — opciones de etapa y responsable, y esquema de columnas
	router.get('/catalogs', controller.catalogs);

	// GET /api/sandbox/cases?offset&limit&sort=campo:asc|desc&stage=a,b&handler=x,y&search=
	router.get('/cases', controller.list);

	// GET /api/sandbox/cases/:id/position — mismos parámetros de consulta que el listado
	router.get('/cases/:id/position', controller.position);

	// GET /api/sandbox/cases/:id
	router.get('/cases/:id', controller.get);

	// POST /api/sandbox/cases/batch — { creates, updates, deletes }. Admite Idempotency-Key.
	router.post('/cases/batch', idempotent(), controller.batch);

	// Solo pruebas: simular a otro usuario y volver a la semilla.
	// POST /api/sandbox/dev/mutate — { count?, ids? }
	router.post('/dev/mutate', controller.mutate);
	// POST /api/sandbox/dev/reset
	router.post('/dev/reset', controller.reset);

	return router;
}
