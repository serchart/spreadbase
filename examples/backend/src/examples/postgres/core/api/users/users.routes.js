import { Router } from 'express';
import { sheetRouter } from '@spreadbase/server';
import { usersService } from '../../orchestrator/index.js';

/**
 * Rutas de usuarios. Base: /api/postgres/users
 *
 * Aquí la hoja se monta con el atajo `sheetRouter` (docs/01-diseno.md §4.1):
 * las rutas del protocolo ya escritas, sin controlador propio. El servicio es
 * el mismo patrón que el de productos. Compárese con `products.routes.js`, que
 * las escribe a mano.
 */
export default function createUsersRoutes() {
	const router = Router();
	router.use('/sheet', sheetRouter(usersService.sheet, { context: (req) => ({ user: req.user }) }));

	// Los errores de dominio de esta app (con `statusCode`) en la forma del protocolo.
	router.use((err, _req, res, next) => {
		if (!err?.statusCode) return next(err);
		res.status(err.statusCode).json({ error: { code: err.name, message: err.message } });
	});
	return router;
}
