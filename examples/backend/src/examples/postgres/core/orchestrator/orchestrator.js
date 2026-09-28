import { pool } from '../../db/pool.js';
import ProductsService from '../api/products/products.service.js';
import UsersService from '../api/users/users.service.js';

/**
 * Crea los servicios una sola vez y les da acceso entre sí (como en Aggy).
 */
class Orchestrator {
	constructor() {
		this.pool = pool;
		// Primero los que otros usan: la hoja de productos recibe el lookup de usuarios.
		this.usersService = new UsersService(this);
		this.productsService = new ProductsService(this);
	}
}

export default Orchestrator;
