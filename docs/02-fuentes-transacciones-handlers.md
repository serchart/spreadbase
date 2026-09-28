# 02 — Fuente, transacción y handlers

> Cómo conviven, en el backend, las tres piezas que deciden **de dónde se lee,
> cómo se escribe de forma segura y qué se escribe**. Con un ejemplo completo
> en un proyecto anfitrión en JavaScript con la estructura de Aggy.

**Creado:** 2026-09-28 · **Estado:** 🟡 propuesta

> ⚠️ **Qué existe hoy y qué no.** Existen `SpreadBase`, `memorySource`,
> `handlers`, `parseListQuery`, `parseBatch` e `idempotent()` en memoria.
> **Son propuesta de este documento:** `postgresSource`, `transaction` en la
> fuente, `ctx.tx` en los handlers y la idempotencia guardada en la base. El
> código de abajo muestra cómo se usarían; aún no corre.

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

### 2.1 La tabla: versiones con un trigger

La concurrencia por campo necesita dos cosas de la tabla (SB-4): un
`row_version` que sube con cada cambio y saber qué campos cambiaron desde una
versión. Las pone un **trigger**, no SpreadBase ni el servicio. Así cuenta
cualquier escritura: la de la hoja, la de un worker o la de un script.

```sql
-- db/migrations/001_products.sql
CREATE TABLE products (
	id          text PRIMARY KEY,
	name        text NOT NULL,
	sku         text NOT NULL UNIQUE,
	price       numeric(12, 2) NOT NULL CHECK (price >= 0),
	stock       integer NOT NULL DEFAULT 0,
	status      text NOT NULL DEFAULT 'draft',
	row_version integer NOT NULL DEFAULT 1,
	updated_by  text,
	deleted_at  timestamptz
);

-- Qué campo cambió en qué versión: responde «¿qué cambió otro desde que leí?».
CREATE TABLE products_changes (
	product_id  text NOT NULL,
	field       text NOT NULL,
	row_version integer NOT NULL
);
CREATE INDEX ON products_changes (product_id, row_version);

CREATE FUNCTION products_versioning() RETURNS trigger AS $$
BEGIN
	NEW.row_version := OLD.row_version + 1;
	INSERT INTO products_changes (product_id, field, row_version)
	SELECT NEW.id, n.key, NEW.row_version
	FROM jsonb_each(to_jsonb(NEW)) AS n
	WHERE n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key
	  AND n.key NOT IN ('row_version', 'updated_by');
	RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER products_versioning BEFORE UPDATE ON products
	FOR EACH ROW EXECUTE FUNCTION products_versioning();

-- Lo que ve la hoja: sin los eliminados y con el nombre que espera el protocolo.
CREATE VIEW v_products AS
	SELECT id, name, sku, price, stock, status, row_version AS "rowVersion"
	FROM products
	WHERE deleted_at IS NULL;

CREATE TABLE price_history (
	product_id text NOT NULL,
	old_price  numeric(12, 2),
	new_price  numeric(12, 2),
	changed_by text,
	changed_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotencia en la base: la respuesta se guarda en la misma transacción que el lote.
CREATE TABLE spreadbase_idempotency (
	key        text PRIMARY KEY,
	body_hash  text NOT NULL,
	status     integer NOT NULL,
	response   jsonb NOT NULL,
	expires_at timestamptz NOT NULL
);
```

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

const RETURNING = `id, name, sku, price, stock, status, row_version AS "rowVersion"`;

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
		 * - FUENTE: lee de la vista, bloquea y versiona sobre la tabla. Trae su
		 *   transacción: nadie la configura aquí.
		 * - HANDLERS: la escritura de dominio. Se ejecutan DENTRO de la
		 *   transacción de la fuente, con su conexión (`ctx.tx.db`).
		 * - MOTOR: SpreadBase, con las reglas del lote.
		 */
		this.sheet = new SpreadBase({
			...productsSheet,
			source: postgresSource({
				pool: this.pool,
				view: 'v_products',          // de aquí lee la hoja
				table: 'products',           // aquí bloquea (FOR UPDATE)
				changes: 'products_changes', // de aquí sabe qué cambió otro
				idempotency: 'spreadbase_idempotency'
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
			// El trigger ya subió row_version y anotó los campos: RETURNING trae el nuevo.
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
	// quien llama pasa la suya. El trigger versiona igual: la hoja se enterará.

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
	 * El usuario autenticado viaja en el contexto hasta los handlers.
	 */
	async batch(req, res) {
		try {
			const result = await this.service.sheet.batch(parseBatch(req.body), { user: req.user });
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
import { idempotent } from '@spreadbase/server';
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
	// La respuesta y la llave se guardan en la base, en la transacción del lote (§3.3).
	router.post('/sheet/batch', idempotent({ store: productsService.sheet }), (req, res) => controller.batch(req, res));

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
└─ sheet.batch(input, { user })                                   MOTOR
   │
   ├─ 1. valida valores contra las columnas (tipo, requerido, patrón…)
   │     inválido → 400, nada se toca
   │
   └─ 2. source.transaction(async (tx) => { … })                   FUENTE
         │
         BEGIN
         ├─ ¿la llave 7f3a ya se usó?  sí → devuelve la respuesta guardada
         ├─ tx.lock([prd_01, prd_02, prd_03])        SELECT … FOR UPDATE, en orden
         ├─ tx.get(id) de cada una                   lo último confirmado
         ├─ compara rowVersion y `from` por campo                   MOTOR
         │     prd_02: otro cambió `stock` → merge → se aplica + aviso
         ├─ handlers.updateMany(items, { tx, user })               TU DOMINIO
         │     price_history ← prd_01
         │     UPDATE products …   (el trigger sube row_version y anota campos)
         │     #checkActivation(prd_02) → stock > 0 → ok
         ├─ handlers.deleteMany(items, { tx, user })
         │     UPDATE products SET deleted_at = now()
         ├─ guarda la respuesta con la llave 7f3a
         COMMIT
   │
   └─ 3. emite eventos { sheet, op, id, fields, rowVersion }       (SB-8)
│
← 200 { created, updated, deleted, notices, conflicts }
```

### 3.1 Si un handler lanza

Si `#checkActivation` falla para `prd_02` (sin existencias), el error sube,
la fuente hace `ROLLBACK` y **nada** del lote queda escrito: ni el precio de
`prd_01` ni su historial. El cliente recibe 400 con el mensaje de dominio y el
usuario conserva todos sus cambios pendientes para corregir.

> **Decisión abierta.** La alternativa es tratar un error de dominio como un
> conflicto: esa fila queda pendiente con su motivo y el resto se guarda. Es
> más útil pero exige que el handler reporte errores por fila. Propuesta:
> empezar abortando el lote entero y pasar a por fila cuando un caso real lo
> pida.

### 3.2 Un conflicto no aborta

Si otro usuario cambió el precio de `prd_01` a otro valor, `prd_01` va a
`conflicts` y **no** llega al handler; `prd_02` y `prd_03` se aplican y se
confirman. Los conflictos son una respuesta normal, no un error.

### 3.3 Por qué la idempotencia entra en la transacción

Hoy `idempotent()` guarda la respuesta en memoria **después** de responder.
Con una base real, si el proceso se cae entre el `COMMIT` y ese guardado, el
reintento del cliente vuelve a aplicar el lote y **duplica las altas**. Por
eso, con Postgres, la llave y la respuesta se escriben dentro de la misma
transacción: o se confirma todo, o nada.

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
	source: postgresSource({ pool: this.pool, table: 'brands', changes: 'brands_changes' })
});
```

### 4.2 En memoria: demos y pruebas

`memorySource` implementa lectura y escritura, pero **no** transacción: el
motor aplica los lotes de uno en uno dentro del proceso. Un error a mitad de
lote no se deshace. Vale para demos, pruebas y el playground; no para
producción.

```js
source: memorySource({ rows: seed, createId: (n) => `prd_${n}` })
```

### 4.3 Mongo (la base de Aggy)

La misma forma con otra fuente. La transacción es una sesión de Mongo y el
handler recibe esa sesión en `ctx.tx.db`:

```js
source: mongoSource({ model: Product, changes: ProductChange }),
handlers: {
	updateMany: async (items, { tx }) => {
		for (const { id, values } of items) {
			await Product.updateOne({ _id: id }, { $set: values, $inc: { rowVersion: 1 } }, { session: tx.db });
		}
		return Product.find({ _id: { $in: items.map((i) => i.id) } }, null, { session: tx.db }).lean();
	}
}
```

En Mongo no hay triggers: la versión la sube quien escribe (`$inc`). Si otras
partes de la app escriben esa colección, tienen que hacerlo también, o sus
cambios serán invisibles para la concurrencia.

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
// lock(ids):              SELECT id FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE
// get(id):                SELECT … FROM v_products WHERE id = $1
// changedFieldsSince(…):  SELECT DISTINCT field FROM products_changes WHERE product_id = $1 AND row_version > $2
// list(query):            SELECT … FROM v_products WHERE … ORDER BY <campo>, id LIMIT $n OFFSET $m  (+ count)
// update sin handler:     UPDATE products SET … WHERE id = $1 RETURNING …
```

Con `READ COMMITTED` (el nivel por defecto de Postgres) basta: una vez
bloqueada la fila, lo que se lee es lo último confirmado y nadie más puede
escribirla hasta el `COMMIT`.

---

## 6. Qué cambia en la librería para llegar aquí

| Cambio | Dónde |
|---|---|
| `transaction?(fn)` y `lock(ids)` en la interfaz de fuente | `packages/server/src/source.ts` |
| El motor corre el lote dentro de `source.transaction` si existe; si no, en su cola | `SpreadBase.ts` |
| Los handlers reciben `ctx.tx` | `SpreadBase.ts` |
| Los eventos (SB-8) se emiten después del `COMMIT` | `SpreadBase.ts` |
| `idempotent({ store })`: llave y respuesta guardadas por la fuente, dentro de la transacción | `idempotency.ts`, fuente |
| `postgresSource` | nuevo |

Decisiones que pide:

1. **Error de dominio:** aborta el lote entero (propuesta inicial) o solo su
   fila (§3.1).
2. **Idempotencia en la base** con Postgres (§3.3): obligatoria, no opcional.
3. **Versiones con trigger** en Postgres: la librería lo exige y documenta el
   SQL; con Mongo, cada escritura sube la versión.
