import { pool } from '../../db/pool.js';
import ProductsService from '../api/products/products.service.js';

/**
 * Crea los servicios una sola vez y les da acceso entre sí (como en Aggy).
 */
class Orchestrator {
	constructor() {
		this.pool = pool;
		this.productsService = new ProductsService(this);
	}
}

export default Orchestrator;
