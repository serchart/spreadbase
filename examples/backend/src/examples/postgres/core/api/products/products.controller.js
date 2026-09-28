import { parseBatch, parseListQuery, parseLookupQuery, parseResolve, SpreadBaseError } from '@spreadbase/server';

/**
 * Controlador de productos.
 *
 * Las rutas de la hoja responden la forma del protocolo de SpreadBase, no el
 * envoltorio `{ success, data }`: es lo que espera `new Sheet(url)` en el
 * cliente. Las demás rutas del módulo siguen el estilo de siempre.
 *
 * @typedef {import('./products.service.js').default} ProductsService
 */
class ProductsController {
	/** @param {ProductsService} productsService */
	constructor(productsService) {
		this.service = productsService;
	}

	/** Errores con la forma que entiende el cliente de SpreadBase. */
	#fail(res, error) {
		const status = error instanceof SpreadBaseError ? error.status : error.statusCode || 500;
		const code = error instanceof SpreadBaseError ? error.code : error.name || 'internal_error';
		if (status >= 500) console.error(error);
		res.status(status).json({ error: { code, message: status >= 500 ? 'Error interno' : error.message, details: error.details } });
	}

	// -- la hoja (protocolo de SpreadBase) -----------------------------------

	/** GET /api/products/sheet/schema */
	async schema(req, res) {
		res.json(this.service.sheet.schema());
	}

	/**
	 * GET /api/products/sheet?offset&limit&sort&search&status=active,paused
	 * Con el contexto: los lookups lo reciben al poner los nombres de cada tramo.
	 */
	async list(req, res) {
		try {
			res.json(await this.service.sheet.list(parseListQuery(req.query), { user: req.user }));
		} catch (error) {
			this.#fail(res, error);
		}
	}

	/** GET /api/products/sheet/lookup/:field?q&offset&limit — el popover de una columna lookup. */
	async lookup(req, res) {
		try {
			res.json(await this.service.sheet.lookup(req.params.field, parseLookupQuery(req.query), { user: req.user }));
		} catch (error) {
			this.#fail(res, error);
		}
	}

	/** POST /api/products/sheet/lookup/:field/resolve — texto pegado → registros. */
	async resolve(req, res) {
		try {
			res.json(await this.service.sheet.resolve(req.params.field, parseResolve(req.body), { user: req.user }));
		} catch (error) {
			this.#fail(res, error);
		}
	}

	/** GET /api/products/sheet/:id/position */
	async position(req, res) {
		try {
			res.json(await this.service.sheet.position(req.params.id, parseListQuery(req.query)));
		} catch (error) {
			this.#fail(res, error);
		}
	}

	/** GET /api/products/sheet/:id */
	async get(req, res) {
		try {
			res.json(await this.service.sheet.get(req.params.id));
		} catch (error) {
			this.#fail(res, error);
		}
	}

	/**
	 * POST /api/products/sheet/batch
	 * La llave de idempotencia va al motor, que la guarda en la misma
	 * transacción que el lote. El usuario viaja en el contexto hasta los handlers.
	 */
	async batch(req, res) {
		try {
			const { result, replayed } = await this.service.sheet.batch(parseBatch(req.body), {
				idempotencyKey: req.get('Idempotency-Key'),
				context: { user: req.user }
			});
			if (replayed) res.set('Idempotent-Replayed', 'true');
			res.json(result);
		} catch (error) {
			this.#fail(res, error);
		}
	}

	// -- el resto del módulo (estilo de siempre) ------------------------------

	/** GET /api/products/:id/price-history */
	async priceHistory(req, res) {
		try {
			const data = await this.service.priceHistory(req.params.id);
			res.json({ success: true, data });
		} catch (error) {
			res.status(error.statusCode || 500).json({ success: false, message: error.message });
		}
	}
}

export default ProductsController;
