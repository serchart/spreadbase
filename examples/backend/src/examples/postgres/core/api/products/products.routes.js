import { Router } from 'express';
import { sheetUpload } from '@spreadbase/server';
import ProductsController from './products.controller.js';
import { productsService } from '../../orchestrator/index.js';

/**
 * Rutas de productos. Base: /api/products
 * Bajo /sheet, las del protocolo de SpreadBase: `new Sheet('/api/products/sheet')`.
 */
export default function createProductsRoutes() {
	const router = Router();
	const controller = new ProductsController(productsService);

	router.get('/sheet/schema', (req, res) => controller.schema(req, res));
	router.get('/sheet', (req, res) => controller.list(req, res));
	router.get('/sheet/lookup/:field', (req, res) => controller.lookup(req, res));
	router.post('/sheet/lookup/:field/resolve', (req, res) => controller.resolve(req, res));
	router.get('/sheet/:id/position', (req, res) => controller.position(req, res));
	router.get('/sheet/:id', (req, res) => controller.get(req, res));
	router.post('/sheet/batch', (req, res) => controller.batch(req, res));
	router.use('/sheet', sheetUpload(productsService.sheet));

	// …las demás rutas del módulo (REST normal, con { success, data }).
	router.get('/:id/price-history', (req, res) => controller.priceHistory(req, res));

	return router;
}
