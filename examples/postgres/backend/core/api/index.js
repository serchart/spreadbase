import { demoAuth } from '../../src/common/auth.js';
import createProductsRoutes from './products/products.routes.js';

/** Monta los módulos de la API. */
export default function registerRoutes(app) {
	app.use('/api/products', demoAuth, createProductsRoutes());
}
