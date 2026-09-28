# 02 — Fuente, transacción y handlers

> Cómo conviven, en el backend, las tres piezas que deciden **de dónde se lee,
> cómo se escribe de forma segura y qué se escribe**. Con un ejemplo completo
> en un proyecto anfitrión en JavaScript con la estructura de Aggy.

**Creado:** 2026-09-28 · **Estado:** 🟢 vigente (SB-4, SB-16 a SB-20)

El ejemplo completo corre en [`examples/postgres`](../examples/postgres).

---

## 1. Las tres piezas

| Pieza | Responde | La escribe | ¿Obligatoria? |
|---|---|---|---|
| **Fuente** | *De dónde* se lee y dónde se escribe por defecto | La librería (`memorySource`, `postgresSource`…) | Sí |
| **Transacción** | *Cómo* se escribe seguro: todo o nada, y sin que otro usuario se cuele entre leer y escribir | La trae la fuente | La trae la fuente si la base la soporta |
| **Handlers** | *Qué* se escribe: tus reglas de negocio | Tu app | No: solo si escribir no es un `UPDATE` directo |

Y el **motor** (`SpreadBase`) pone las reglas del lote: valida, compara
versiones, decide conflictos y avisos, y arma la respuesta.

**La transacción no sustituye a los handlers.** Es el envoltorio. Dentro,
alguien tiene que escribir:

- **Sin handler**, escribe la fuente con un `UPDATE` genérico, columna a
  columna. Sirve si la hoja es un reflejo 1:1 de una tabla sin reglas.
- **Con handler**, escribe tu servicio, con la conexión de la transacción.
  Hace falta cuando:
  - la hoja se lee de una vista y se escribe en otra tabla;
  - un cambio tiene reglas o efectos (validar, dejar historial, avisar a otro servicio);
  - «eliminar» no es un `DELETE` (borrado lógico, archivar).

**Quien usa la librería no configura la transacción:** elige la fuente, y la
fuente ya sabe abrirla sobre la conexión que le das.

---

## 2. El proyecto de ejemplo

Una tienda con estructura de Aggy: Express, ESM, módulos
`api/<módulo>/*.routes.js → *.controller.js → *.service.js`, servicios
instanciados en un orquestador. Postgres con `pg`.

La hoja es el **catálogo de productos**, editable por el equipo comercial:

- nombre, SKU, precio, existencias, estado (`draft` · `active` · `paused`);
- **cambiar el precio** deja registro en `price_history`;
- **no se puede activar** un producto sin existencias;
- **eliminar** es borrado lógico (`deleted_at`), no `DELETE`.

Esas tres reglas son las que obligan a tener handlers.

```
tienda-backend/
├── db/
│   ├── pool.js
│   └── migrations/001_products.sql
├── src/common/errors.js
├── core/
│   ├── orchestrator/
│   │   ├── orchestrator.js
│   │   └── index.js
│   └── api/
│       ├── index.js
│       └── products/
│           ├── products.sheet.js        ← columnas de la hoja
│           ├── products.service.js      ← SpreadBase + handlers (dominio)
│           ├── products.controller.js
│           └── products.routes.js
└── package.json                         ← "@spreadbase/server"
```

### 2.1 La tabla: la del usuario, sin nada especial

La concurrencia **no pide nada** a la tabla (SB-4): ni columna de versión, ni
trigger, ni tabla de cambios. `postgresSource` calcula una huella de las
columnas escribibles de cada fila al leerla; si alguien la cambia —la hoja, un
worker, un script—, la huella cambia. Los avisos de `merge` salen de comparar
lo que el cliente leyó (`base`) con lo que hay ahora (SB-16).

Lo único que se ve abajo son las tablas **del dominio**:

```sql
-- db/migrations/001_products.sql
CREATE TABLE products (
	id          text PRIMARY KEY,
	name        text NOT NULL,
	sku         text NOT NULL UNIQUE,
	price       numeric(12, 2) NOT NULL CHECK (price >= 0),
	stock       integer NOT NULL DEFAULT 0,
	status      text NOT NULL DEFAULT 'draft',
	updated_by  text,
	deleted_at  timestamptz
);

-- Lo que ve la hoja: sin los eliminados. Opcional: también se puede leer la tabla.
CREATE VIEW v_products AS
	SELECT id, name, sku, price, stock, status
	FROM products
	WHERE deleted_at IS NULL;

-- Regla de negocio del ejemplo: historial de precios.
CREATE TABLE price_history (
	product_id text NOT NULL,
	old_price  numeric(12, 2),
	new_price  numeric(12, 2),
	changed_by text,
	changed_at timestamptz NOT NULL DEFAULT now()
);
```

**Lo que sí crea SpreadBase, sola:** la tabla `spreadbase_idempotency` (SB-18),
con `CREATE TABLE IF NOT EXISTS` la primera vez que la fuente se usa. Es de la
librería, no toca las tablas del usuario, y su esquema se puede elegir
(`idempotencyTable: 'app.spreadbase_idempotency'`).

### 2.2 Las columnas

```js
// core/api/products/products.sheet.js
import { types } from '@spreadbase/server';

/** Definición de la hoja: lo que valida el servidor y lo que pinta el cliente. */
export const productsSheet = {
	id: 'products',
	idField: 'id',
	allowInsert: true,
	allowDelete: true,
	policy: 'merge',
	columns: {
		id: { type: types.TEXT, label: 'ID', width: 110 },
		name: { type: types.TEXT, label: 'Nombre', required: true, maxLength: 160, searchable: true, width: 260 },
		sku: { type: types.TEXT, label: 'SKU', required: true, pattern: '^[A-Z0-9-]{4,20}$', patternMessage: 'Mayúsculas, números y guiones', searchable: true },
		price: { type: types.NUMBER, label: 'Precio', required: true, min: 0, precision: 2, prefix: '$', thousands: true },
		stock: { type: types.NUMBER, label: 'Existencias', min: 0 },
		status: {
			type: types.SELECT,
			label: 'Estado',
			required: true,
			options: [
				{ value: 'draft', label: 'Borrador' },
				{ value: 'active', label: 'Activo' },
				{ value: 'paused', label: 'Pausado' }
			]
		}
	}
};
```

### 2.3 El servicio: donde conviven las tres piezas

```js
// core/api/products/products.service.js
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
				table: 'products' // aquí bloquea (FOR UPDATE) y escribe si no hay handlers
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
		await tx.db.query(
			`UPDATE products SET deleted_at = now(), updated_by = $2 WHERE id = ANY($1)`,
			[items.map((i) => i.id), user?.id ?? null]
		);
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

	/** Lo llama el worker de inventario cuando llega mercancía. */
	async addStock(id, quantity, { db = this.pool } = {}) {
		await db.query(`UPDATE products SET stock = stock + $2 WHERE id = $1`, [id, quantity]);
	}
}

export default ProductsService;
```

### 2.4 El controlador

Como en Aggy: traduce HTTP ↔ servicio. Dos diferencias con un controlador
normal de Aggy:

- **Las rutas de la hoja responden la forma del protocolo**, no el envoltorio
  `{ success, data }`: es lo que espera `new Sheet(url)` en el cliente.
- **Los errores van como `{ error: { code, message, details } }`**, por lo mismo.

```js
// core/api/products/products.controller.js
import { parseBatch, parseListQuery, SpreadBaseError } from '@spreadbase/server';

/**
 * Controlador de la hoja de productos.
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
		res.status(status).json({ error: { code, message: error.message, details: error.details } });
	}

	/** GET /products/sheet/schema */
	async schema(req, res) {
		res.json(this.service.sheet.schema());
	}

	/** GET /products/sheet?offset&limit&sort&search&status=active,paused */
	async list(req, res) {
		try {
			res.json(await this.service.sheet.list(parseListQuery(req.query)));
		} catch (error) {
			this.#fail(res, error);
		}
	}

	/** GET /products/sheet/:id/position */
	async position(req, res) {
		try {
			res.json(await this.service.sheet.position(req.params.id, parseListQuery(req.query)));
		} catch (error) {
			this.#fail(res, error);
		}
	}

	/** GET /products/sheet/:id */
	async get(req, res) {
		try {
			res.json(await this.service.sheet.get(req.params.id));
		} catch (error) {
			this.#fail(res, error);
		}
	}

	/**
	 * POST /products/sheet/batch
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
}

export default ProductsController;
```

### 2.5 Las rutas y el montaje

```js
// core/api/products/products.routes.js
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
	return router;
}
```

```js
// core/orchestrator/orchestrator.js (fragmento)
import { pool } from '../../db/pool.js';
import ProductsService from '../api/products/products.service.js';

class Orchestrator {
	constructor() {
		this.pool = pool;
		// …
		this.productsService = new ProductsService(this);
	}
}

// core/orchestrator/index.js
export const productsService = orchestrator.productsService;

// core/api/index.js
app.use('/products', authenticateAPI, ProductsRouter());
```

**Atajo:** si el módulo no necesita nada distinto por ruta, controlador y rutas
se reducen a una línea, y el servicio queda igual:

```js
router.use('/sheet', sheetRouter(productsService.sheet, { context: (req) => ({ user: req.user }) }));
```

---

## 3. Qué pasa en un guardado

Un vendedor edita el precio de `prd_01`, activa `prd_02` y elimina `prd_03`, y
pulsa Guardar.

```
POST /api/products/sheet/batch            Idempotency-Key: 7f3a…
│
├─ controller.batch → parseBatch (forma del cuerpo)
└─ sheet.batch(input, { idempotencyKey, context: { user } })       MOTOR
   │
   ├─ 1. valida valores contra las columnas (tipo, requerido, patrón…)
   │     inválido → 400, nada se toca
   │
   └─ 2. source.transaction(async (tx) => { … })                   FUENTE
         │
         BEGIN
         ├─ ¿la llave 7f3a ya se usó?  sí → devuelve la respuesta guardada
         ├─ tx.lock([prd_01, prd_02, prd_03])        SELECT … FOR UPDATE, en orden
         ├─ tx.get(id) de cada una                   lo último confirmado + su huella
         ├─ compara huella, `from` y `base`                          MOTOR
         │     prd_02: otro cambió `stock` (base ≠ actual) → merge → se aplica + aviso
         ├─ handlers.updateMany(items, { tx, user })               TU DOMINIO
         │     price_history ← prd_01
         │     UPDATE products …
         │     #checkActivation(prd_02) → stock > 0 → ok
         ├─ handlers.deleteMany(items, { tx, user })
         │     UPDATE products SET deleted_at = now()
         ├─ guarda la respuesta con la llave 7f3a    spreadbase_idempotency
         COMMIT
   │
   └─ 3. emite eventos { sheet, op, id, fields, rowVersion }       (SB-8)
│
← 200 { created, updated, deleted, notices, conflicts }       (+ Idempotent-Replayed si se repitió)
```

### 3.1 Si un handler lanza (SB-20)

Si `#checkActivation` falla para `prd_02` (sin existencias), el error sube,
la fuente hace `ROLLBACK` y **nada** del lote queda escrito: ni el precio de
`prd_01` ni su historial, ni la llave de idempotencia. El cliente recibe 400
con el mensaje de dominio y el usuario conserva todos sus cambios pendientes
para corregir y reintentar.

Tratar un error de dominio por fila, como un conflicto, queda para cuando un
caso real lo pida: exige que el handler reporte errores por fila.

### 3.2 Un conflicto no aborta

Si otro usuario cambió el precio de `prd_01` a otro valor, `prd_01` va a
`conflicts` y **no** llega al handler; `prd_02` y `prd_03` se aplican y se
confirman. Los conflictos son una respuesta normal, no un error.

### 3.3 Por qué la idempotencia entra en la transacción (SB-18)

Si la respuesta se guardara **después** de confirmar el lote y el proceso se
cayera entre el `COMMIT` y ese guardado, el reintento del cliente volvería a
aplicar el lote y **duplicaría las altas**. Por eso la llave y la respuesta se
escriben dentro de la misma transacción: o se confirma todo, o nada. Dos
reintentos simultáneos con la misma llave no pueden aplicarse los dos: el
segundo choca con la clave primaria de la tabla, se deshace, y su siguiente
reintento recibe la respuesta guardada.

### 3.4 Por qué `lock` va aparte de `get`

`FOR UPDATE` no funciona sobre una vista con joins. Se bloquea la tabla base
(`products`) y después se lee la vista (`v_products`). Bloquear en orden de id
evita que dos lotes que tocan las mismas filas se esperen mutuamente
(deadlock).

---

## 4. Variantes

### 4.1 Tabla simple, sin reglas: sin handlers

Un catálogo de marcas que se edita tal cual. La fuente escribe con su `UPDATE`
genérico, dentro de su transacción:

```js
this.sheet = new SpreadBase({
	id: 'brands',
	allowInsert: true,
	allowDelete: true,
	columns: { id: { type: types.TEXT, label: 'ID' }, name: { type: types.TEXT, label: 'Marca', required: true } },
	source: postgresSource({ pool: this.pool, table: 'brands' })
});
```

### 4.2 En memoria: demos y pruebas

`memorySource` implementa lectura y escritura con un contador de versión, pero
**no** transacción: el motor aplica los lotes de uno en uno dentro del proceso
y guarda la idempotencia en memoria. Un error a mitad de lote no se deshace.
Vale para demos, pruebas y el playground; no para producción.

```js
source: memorySource({ rows: seed, createId: (n) => `prd_${n}` })
```

### 4.3 Mongo (la base de Aggy)

La misma forma con otra fuente. La transacción es una sesión de Mongo y el
handler recibe esa sesión en `ctx.tx.db`:

```js
source: mongoSource({ model: Product }),
handlers: {
	updateMany: async (items, { tx }) => {
		for (const { id, values } of items) {
			await Product.updateOne({ _id: id }, { $set: values }, { session: tx.db });
		}
		return Product.find({ _id: { $in: items.map((i) => i.id) } }, null, { session: tx.db }).lean();
	}
}
```

La huella se calcula igual, sobre los valores del documento: cualquier parte
de la app que escriba la colección cuenta, sin campo de versión. (`mongoSource`
no existe todavía; la forma sería esta.)

---

## 5. Qué hay dentro de una fuente

Lo escribe la librería una vez; quien la usa no lo toca. Para `postgresSource`:

```js
transaction: async (fn) => {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const result = await fn(bindTo(client)); // la misma fuente, usando este client; expone `db: client`
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
// huella:        md5(row(<columnas escribibles>)::text) calculada en el mismo SELECT
// lock(ids):     SELECT 1 FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE
// get(id):       SELECT …, <huella> AS "rowVersion" FROM v_products WHERE id = $1
// list(query):   SELECT …, <huella> FROM v_products WHERE … ORDER BY <campo>, id LIMIT $n OFFSET $m  (+ count)
// update:        UPDATE products SET … WHERE id = $1 RETURNING …   (solo si no hay handler)
// idempotencia:  spreadbase_idempotency, creada con CREATE TABLE IF NOT EXISTS
```

Con `READ COMMITTED` (el nivel por defecto de Postgres) basta: una vez
bloqueada la fila, lo que se lee es lo último confirmado y nadie más puede
escribirla hasta el `COMMIT`.

---

## 6. Decisiones

| # | Decisión |
|---|---|
| **SB-4** | La tabla del usuario no necesita nada: `rowVersion` es una huella de las columnas escribibles, o una columna de versión si ya existe |
| **SB-16** | Los avisos los calcula el servidor con `base`, lo que el cliente leyó en las escribibles que no tocó |
| **SB-18** | La idempotencia la lleva el motor y la guarda la fuente en la misma transacción; con Postgres, en `spreadbase_idempotency`, creada por la librería |
| **SB-19** | La transacción la trae la fuente; los handlers la reciben en `ctx.tx` |
| **SB-20** | Un error de dominio deshace el lote entero |
