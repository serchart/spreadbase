import { SpreadBase, postgresSource } from '@spreadbase/server';
import { ValidationError } from '../../../src/common/errors.js';
import { productsSheet } from './products.sheet.js';

const RETURNING = 'id, name, sku, price, stock, status';

/**
 * Servicio de productos.
 * @typedef {import('../../orchestrator/orchestrator.js').default} Orchestrator
 */
class ProductsService {
	/**
	 * @param {Orchestrator} orchestrator
	 */
	constructor(orchestrator) {
		this.services = orchestrator;
		this.pool = orchestrator.pool;

		/**
		 * La hoja. Tres piezas:
		 * - FUENTE: lee de la vista, bloquea sobre la tabla, calcula la huella de
		 *   cada fila y guarda la idempotencia. Trae su transacción: nadie la
		 *   configura aquí.
		 * - HANDLERS: la escritura de dominio. Se ejecutan DENTRO de la
		 *   transacción de la fuente, con su conexión (`ctx.tx.db`).
		 * - MOTOR: SpreadBase, con las reglas del lote.
		 */
		this.sheet = new SpreadBase({
			...productsSheet,
			source: postgresSource({
				pool: this.pool,
				view: 'v_products', // de aquí lee la hoja
				table: 'products' // aquí bloquea (FOR UPDATE)
			}),
			handlers: {
				insertMany: (items, ctx) => this.insertMany(items, ctx),
				updateMany: (items, ctx) => this.updateMany(items, ctx),
				deleteMany: (items, ctx) => this.deleteMany(items, ctx)
			}
		});
	}

	// ========================================
	// ESCRITURA DE DOMINIO (handlers de la hoja)
	// ========================================
	//
	// Reciben SOLO lo que ya pasó la validación de columnas y la concurrencia:
	// no hay conflictos que revisar aquí. Escriben con `ctx.tx.db`, la conexión
	// de la transacción: si lanzan, el lote entero se deshace.

	/**
	 * Altas desde la hoja.
	 * @param {{ values: Record<string, unknown> }[]} items
	 * @param {{ tx: { db: import('pg').PoolClient }, user?: { id: string } }} ctx
	 */
	async insertMany(items, { tx, user }) {
		const created = [];
		for (const { values } of items) {
			this.#checkActivation(values);
			const { rows } = await tx.db.query(
				`INSERT INTO products (id, name, sku, price, stock, status, updated_by)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)
				 RETURNING ${RETURNING}`,
				[
					`prd_${crypto.randomUUID().slice(0, 8)}`,
					values.name,
					values.sku,
					values.price,
					values.stock ?? 0,
					values.status,
					user?.id ?? null
				]
			);
			created.push(rows[0]);
		}
		return created;
	}

	/**
	 * Ediciones desde la hoja. `row` es la fila tal como está ahora (ya
	 * bloqueada); `values`, solo los campos que cambian.
	 * @param {{ id: string, values: Record<string, unknown>, row: Record<string, unknown> }[]} items
	 */
	async updateMany(items, { tx, user }) {
		const updated = [];
		for (const { id, values, row } of items) {
			this.#checkActivation({ ...row, ...values });

			// Efecto de dominio: el historial de precios, en la misma transacción.
			if ('price' in values) {
				await tx.db.query(
					`INSERT INTO price_history (product_id, old_price, new_price, changed_by) VALUES ($1, $2, $3, $4)`,
					[id, row.price, values.price, user?.id ?? null]
				);
			}

			// Los nombres de campo vienen de la definición de la hoja: el motor ya
			// rechazó cualquier columna que no sea escribible.
			const fields = Object.keys(values);
			const set = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
			const { rows } = await tx.db.query(
				`UPDATE products SET ${set}, updated_by = $${fields.length + 2}
				 WHERE id = $1 RETURNING ${RETURNING}`,
				[id, ...fields.map((f) => values[f]), user?.id ?? null]
			);
			// Sin rowVersion: SpreadBase relee la fila y la fuente calcula su huella nueva.
			updated.push(rows[0]);
		}
		return updated;
	}

	/**
	 * «Eliminar» en la hoja es borrado lógico: la fila sale de la vista.
	 * @param {{ id: string }[]} items
	 */
	async deleteMany(items, { tx, user }) {
		await tx.db.query(`UPDATE products SET deleted_at = now(), updated_by = $2 WHERE id = ANY($1)`, [
			items.map((i) => i.id),
			user?.id ?? null
		]);
	}

	/** Regla de negocio: no se activa un producto sin existencias. */
	#checkActivation(product) {
		if (product.status === 'active' && !(Number(product.stock) > 0)) {
			throw new ValidationError(`«${product.name}» no se puede activar sin existencias`);
		}
	}

	// ========================================
	// USO NORMAL DEL SERVICIO (fuera de la hoja)
	// ========================================
	//
	// Los mismos datos, usados por otras partes de la app (un worker, otro
	// servicio). `db` por defecto es el pool; dentro de una transacción ajena,
	// quien llama pasa la suya. La hoja se entera igual: cambia la huella.

	async findById(id, { db = this.pool } = {}) {
		const { rows } = await db.query(`SELECT ${RETURNING} FROM products WHERE id = $1`, [id]);
		return rows[0] ?? null;
	}

	/** Historial de precios de un producto. */
	async priceHistory(id, { db = this.pool } = {}) {
		const { rows } = await db.query(
			`SELECT old_price, new_price, changed_by, changed_at FROM price_history WHERE product_id = $1 ORDER BY changed_at DESC`,
			[id]
		);
		return rows;
	}

	/** Lo llamaría el worker de inventario cuando llega mercancía. */
	async addStock(id, quantity, { db = this.pool } = {}) {
		await db.query(`UPDATE products SET stock = stock + $2 WHERE id = $1`, [id, quantity]);
	}
}

export default ProductsService;
