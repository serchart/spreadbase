import { Router } from 'express';
import ProductsController from './products.controller.js';
import { productsService } from '../../orchestrator/index.js';

/**
 * Rutas de productos. Base: /api/products
 * Bajo /sheet, las cinco del protocolo de SpreadBase: `new Sheet('/api/products/sheet')`.
 */
export default function createProductsRoutes() {
	const router = Router();
	const controller = new ProductsController(productsService);

	router.get('/sheet/schema', (req, res) => controller.schema(req, res));
	router.get('/sheet', (req, res) => controller.list(req, res));
	router.get('/sheet/:id/position', (req, res) => controller.position(req, res));
	router.get('/sheet/:id', (req, res) => controller.get(req, res));
	router.post('/sheet/batch', (req, res) => controller.batch(req, res));

	// …las demás rutas del módulo (REST normal, con { success, data }).
	router.get('/:id/price-history', (req, res) => controller.priceHistory(req, res));

	return router;
}
