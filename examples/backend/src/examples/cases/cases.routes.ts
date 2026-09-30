import { Router } from 'express';
import { sheetUpload } from '@spreadbase/server';
import { CasesController } from './cases.controller.ts';
import type { CasesService } from './cases.service.ts';

/**
 * Rutas del módulo de casos. Base: `/api/cases`.
 *
 * Las cinco primeras son el protocolo de SpreadBase: es lo que pide
 * `new Sheet('/api/cases')` en el cliente. `sheetRouter()` las montaría en una
 * línea; aquí se escriben a mano para mostrar cómo encajan en las capas.
 */
export function createCasesRoutes(service: CasesService, options: { devRoutes: boolean }): Router {
	const router = Router();
	const controller = new CasesController(service);

	router.get('/schema', controller.schema);
	router.get('/', controller.list);
	router.get('/:id/position', controller.position);
	router.get('/:id', controller.get);
	router.post('/batch', controller.batch);
	// Subir a la columna «Contrato» (SB-30): la pieza de SpreadBase, junto a las rutas a mano.
	router.use(sheetUpload(service.portfolio));

	// Solo en modo test: simular a otro usuario y volver a la semilla.
	if (options.devRoutes) {
		router.post('/dev/mutate', controller.mutate);
		router.post('/dev/reset', controller.reset);
	}

	return router;
}
