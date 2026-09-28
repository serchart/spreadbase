import { Router } from 'express';
import { demoAuth } from '../../common/auth.js';
import createProductsRoutes from './products/products.routes.js';
import createUsersRoutes from './users/users.routes.js';

/** Los módulos de la API de la tienda. Montados en /api/postgres. */
export default function createApi() {
	const router = Router();
	router.use('/products', demoAuth, createProductsRoutes());
	router.use('/users', demoAuth, createUsersRoutes());
	return router;
}
