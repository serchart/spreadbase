# 02 — Source, transaction and handlers

> How the three pieces that decide **where data is read from, how it is
> written safely, and what is written** live together in the backend. With a
> complete example in a JavaScript host project with Aggy's structure.

**Created:** 2026-09-28 · **Status:** 🟢 current (SB-4, SB-16 to SB-20)

The complete example runs in [`examples/backend/src/examples/postgres`](../examples/backend/src/examples/postgres), served by the shared examples server.

---

## 1. The three pieces

| Piece | Answers | Written by | Required? |
|---|---|---|---|
| **Source** | *Where* data is read from and where it is written by default | The library (`memorySource`, `postgresSource`, `mongoSource`…) | Yes |
| **Transaction** | *How* to write safely: all or nothing, and without another user slipping in between the read and the write | Comes with the source | Comes with the source if the database supports it |
| **Handlers** | *What* is written: your business rules | Your app | No: only if writing is not a direct `UPDATE` |

And the **engine** (`SpreadBase`) sets the batch rules: it validates, compares
versions, decides conflicts and notices, and builds the response.

**The transaction does not replace the handlers.** It is the wrapper. Inside,
someone has to do the writing:

- **Without a handler**, the source writes with a generic `UPDATE`, column by
  column. This works if the sheet is a 1:1 mirror of a table with no rules.
- **With a handler**, your service writes, using the transaction's connection.
  You need one when:
  - the sheet is read from a view and written to another table;
  - a change has rules or side effects (validate, keep a history, notify another service);
  - "delete" is not a `DELETE` (soft delete, archive).

**Whoever uses the library does not configure the transaction:** they pick the
source, and the source already knows how to open it on the connection you give it.

---

## 2. The example project

A store with Aggy's structure: Express, ESM, modules
`api/<module>/*.routes.js → *.controller.js → *.service.js`, services
instantiated in an orchestrator. Postgres with `pg`.

The sheet is the **product catalog**, editable by the sales team:

- name, SKU, price, stock, status (`draft` · `active` · `paused`);
- **changing the price** leaves a record in `price_history`;
- a product **cannot be activated** without stock;
- **deleting** is a soft delete (`deleted_at`), not a `DELETE`.

Those three rules are what make handlers necessary.

```
store-backend/
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
│       ├── users/
│       │   └── users.service.js         ← users SQL + `lookup` (03-lookup.md)
│       └── products/
│           ├── products.sheet.js        ← sheet columns: productsSheet({ users })
│           ├── products.service.js      ← SpreadBase + handlers (domain)
│           ├── products.controller.js
│           └── products.routes.js
└── package.json                         ← "@spreadbase/server"
```

### 2.1 The table: the user's own, nothing special

Concurrency **asks nothing** of the table (SB-4): no version column, no
trigger, no changes table. `postgresSource` computes a fingerprint of each
row's writable columns when reading it; if anyone changes it —the sheet, a
worker, a script—, the fingerprint changes. The `merge` notices come from
comparing what the client read (`base`) with what is there now (SB-16).

The only thing shown below are the **domain** tables:

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

-- What the sheet sees: without the deleted ones. Optional: the table can also be read directly.
CREATE VIEW v_products AS
	SELECT id, name, sku, price, stock, status
	FROM products
	WHERE deleted_at IS NULL;

-- The example's business rule: price history.
CREATE TABLE price_history (
	product_id text NOT NULL,
	old_price  numeric(12, 2),
	new_price  numeric(12, 2),
	changed_by text,
	changed_at timestamptz NOT NULL DEFAULT now()
);
```

The running example adds, in `002_catalog.sql`, the `users` table (the
resource behind the "Responsable" column) and the photo, owner, launch and
last restock columns: one field of each type.

**What SpreadBase does create, on its own:** the `spreadbase_idempotency` table (SB-18),
with `CREATE TABLE IF NOT EXISTS` the first time the source is used. It belongs
to the library, does not touch the user's tables, and its schema can be chosen
(`idempotencyTable: 'app.spreadbase_idempotency'`).

### 2.2 The columns

```js
// core/api/products/products.sheet.js
import { types } from '@spreadbase/server';

/**
 * Sheet definition: what the server validates and what the client renders.
 * It is a function because "Responsable" depends on the users module (03-lookup.md §3).
 */
export const productsSheet = ({ users }) => ({
	id: 'products',
	idField: 'id',
	allowInsert: true,
	allowDelete: true,
	policy: 'merge',
	columns: {
		id: { type: types.TEXT, label: 'ID', width: 100 },
		image_url: { type: types.IMAGE, label: 'Foto', width: 60 },
		name: { type: types.TEXT, label: 'Nombre', required: true, maxLength: 160, searchable: true, width: 220 },
		sku: { type: types.TEXT, label: 'SKU', required: true, pattern: '^[A-Z0-9-]{4,20}$', patternMessage: 'Mayúsculas, números y guiones', searchable: true },
		owner_id: { type: types.LOOKUP, label: 'Responsable', required: true, lookup: users.lookup },
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
		},
		launch_date: { type: types.DATE, label: 'Lanzamiento' },
		restocked_at: { type: types.DATETIME, label: 'Último surtido' }
	}
});
```

> **Columns that pick a record from another module** (an owner, a
> supplier): the sheet becomes a function that receives its dependencies,
> `productsSheet({ users })`, and the column uses `lookup: users.lookup`, which
> the users module defines. The contract and that way of organizing it are
> in [`03-lookup.md`](03-lookup.md).

### 2.3 The service: where the three pieces live together

```js
// core/api/products/products.service.js
import { SpreadBase, postgresSource } from '@spreadbase/server';
import { ValidationError } from '../../../src/common/errors.js';
import { productsSheet } from './products.sheet.js';

const RETURNING = 'id, name, sku, price, stock, status';

/**
 * Products service.
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
		 * The sheet. Three pieces:
		 * - SOURCE: reads from the view, locks on the table, computes each row's
		 *   fingerprint and stores idempotency. It brings its own transaction:
		 *   nobody configures it here.
		 * - HANDLERS: the domain write. They run INSIDE the source's
		 *   transaction, with its connection (`ctx.tx.db`).
		 * - ENGINE: SpreadBase, with the batch rules.
		 */
		this.sheet = new SpreadBase({
			...productsSheet({ users: orchestrator.usersService }),
			source: postgresSource({
				pool: this.pool,
				view: 'v_products', // the sheet reads from here
				table: 'products' // locks here (FOR UPDATE) and writes here if there are no handlers
			}),
			handlers: {
				insertMany: (items, ctx) => this.insertMany(items, ctx),
				updateMany: (items, ctx) => this.updateMany(items, ctx),
				deleteMany: (items, ctx) => this.deleteMany(items, ctx)
			}
		});
	}

	// ========================================
	// DOMAIN WRITES (sheet handlers)
	// ========================================
	//
	// They receive ONLY what already passed column validation and concurrency:
	// there are no conflicts to check here. They write with `ctx.tx.db`, the
	// transaction's connection: if they throw, the whole batch is rolled back.

	/**
	 * Inserts from the sheet.
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
	 * Edits from the sheet. `row` is the row as it is now (already
	 * locked); `values`, only the fields that change.
	 * @param {{ id: string, values: Record<string, unknown>, row: Record<string, unknown> }[]} items
	 */
	async updateMany(items, { tx, user }) {
		const updated = [];
		for (const { id, values, row } of items) {
			this.#checkActivation({ ...row, ...values });

			// Domain side effect: the price history, in the same transaction.
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
			// No rowVersion: SpreadBase re-reads the row and the source computes its new fingerprint.
			updated.push(rows[0]);
		}
		return updated;
	}

	/**
	 * "Delete" in the sheet is a soft delete: the row leaves the view.
	 * @param {{ id: string }[]} items
	 */
	async deleteMany(items, { tx, user }) {
		await tx.db.query(
			`UPDATE products SET deleted_at = now(), updated_by = $2 WHERE id = ANY($1)`,
			[items.map((i) => i.id), user?.id ?? null]
		);
	}

	/** Business rule: a product cannot be activated without stock. */
	#checkActivation(product) {
		if (product.status === 'active' && !(Number(product.stock) > 0)) {
			throw new ValidationError(`«${product.name}» no se puede activar sin existencias`);
		}
	}

	// ========================================
	// NORMAL USE OF THE SERVICE (outside the sheet)
	// ========================================
	//
	// The same data, used by other parts of the app (a worker, another
	// service). `db` defaults to the pool; inside someone else's transaction,
	// the caller passes its own. The sheet notices anyway: the fingerprint changes.

	async findById(id, { db = this.pool } = {}) {
		const { rows } = await db.query(`SELECT ${RETURNING} FROM products WHERE id = $1`, [id]);
		return rows[0] ?? null;
	}

	/** Called by the inventory worker when goods arrive. */
	async addStock(id, quantity, { db = this.pool } = {}) {
		await db.query(`UPDATE products SET stock = stock + $2 WHERE id = $1`, [id, quantity]);
	}
}

export default ProductsService;
```

### 2.4 The controller

As in Aggy: it translates HTTP ↔ service. Two differences from a normal Aggy
controller:

- **The sheet routes respond with the protocol's shape**, not the
  `{ success, data }` wrapper: that is what `new Sheet(url)` expects on the client.
- **Errors go as `{ error: { code, message, details } }`**, for the same reason.

```js
// core/api/products/products.controller.js
import { parseBatch, parseListQuery, SpreadBaseError } from '@spreadbase/server';

/**
 * Controller for the products sheet.
 * @typedef {import('./products.service.js').default} ProductsService
 */
class ProductsController {
	/** @param {ProductsService} productsService */
	constructor(productsService) {
		this.service = productsService;
	}

	/** Errors in the shape the SpreadBase client understands. */
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
	 * The idempotency key goes to the engine, which stores it in the same
	 * transaction as the batch. The user travels in the context down to the handlers.
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

### 2.5 The routes and the mounting

```js
// core/api/products/products.routes.js
import { Router } from 'express';
import ProductsController from './products.controller.js';
import { productsService } from '../../orchestrator/index.js';

/**
 * Products routes. Base: /api/products
 * Under /sheet, the five routes of the SpreadBase protocol: `new Sheet('/api/products/sheet')`.
 */
export default function createProductsRoutes() {
	const router = Router();
	const controller = new ProductsController(productsService);

	router.get('/sheet/schema', (req, res) => controller.schema(req, res));
	router.get('/sheet', (req, res) => controller.list(req, res));
	router.get('/sheet/:id/position', (req, res) => controller.position(req, res));
	router.get('/sheet/:id', (req, res) => controller.get(req, res));
	router.post('/sheet/batch', (req, res) => controller.batch(req, res));

	// …the module's other routes (normal REST, with { success, data }).
	return router;
}
```

```js
// core/orchestrator/orchestrator.js (excerpt)
import { pool } from '../../db/pool.js';
import ProductsService from '../api/products/products.service.js';

class Orchestrator {
	constructor() {
		this.pool = pool;
		// …first the ones others use: the products sheet receives the users lookup.
		this.usersService = new UsersService(this);
		this.productsService = new ProductsService(this);
	}
}

// core/orchestrator/index.js
export const productsService = orchestrator.productsService;

// core/api/index.js
app.use('/products', authenticateAPI, ProductsRouter());
```

**Shortcut:** if the module needs nothing different per route, the controller
and routes shrink to one line, and the service stays the same:

```js
router.use('/sheet', sheetRouter(productsService.sheet, { context: (req) => ({ user: req.user }) }));
```

---

## 3. What happens on a save

A salesperson edits the price of `prd_01`, activates `prd_02` and deletes `prd_03`, and
clicks Save.

```
POST /api/products/sheet/batch            Idempotency-Key: 7f3a…
│
├─ controller.batch → parseBatch (body shape)
└─ sheet.batch(input, { idempotencyKey, context: { user } })       ENGINE
   │
   ├─ 1. validates values against the columns (type, required, pattern…)
   │     invalid → 400, nothing is touched
   │
   └─ 2. source.transaction(async (tx) => { … })                   SOURCE
         │
         BEGIN
         ├─ was key 7f3a already used?  yes → returns the stored response
         ├─ tx.lock([prd_01, prd_02, prd_03])        SELECT … FOR UPDATE, in order
         ├─ tx.get(id) for each one                  latest committed + its fingerprint
         ├─ compares fingerprint, `from` and `base`                  ENGINE
         │     prd_02: someone else changed `stock` (base ≠ current) → merge → applied + notice
         ├─ handlers.updateMany(items, { tx, user })               YOUR DOMAIN
         │     price_history ← prd_01
         │     UPDATE products …
         │     #checkActivation(prd_02) → stock > 0 → ok
         ├─ handlers.deleteMany(items, { tx, user })
         │     UPDATE products SET deleted_at = now()
         ├─ stores the response with key 7f3a        spreadbase_idempotency
         COMMIT
   │
   └─ 3. emits events { sheet, op, id, fields, rowVersion }        (SB-8)
│
← 200 { created, updated, deleted, notices, conflicts }       (+ Idempotent-Replayed if it was repeated)
```

### 3.1 If a handler throws (SB-20)

If `#checkActivation` fails for `prd_02` (no stock), the error bubbles up,
the source does a `ROLLBACK` and **nothing** from the batch is written: not the
price of `prd_01`, nor its history, nor the idempotency key. The client gets a 400
with the domain message, and the user keeps all their pending changes
to fix and retry.

Treating a domain error per row, like a conflict, is left for when a real
case calls for it: it requires the handler to report errors per row.

### 3.2 A conflict does not abort

If another user changed the price of `prd_01` to a different value, `prd_01` goes to
`conflicts` and does **not** reach the handler; `prd_02` and `prd_03` are applied and
committed. Conflicts are a normal response, not an error.

### 3.3 Why idempotency goes inside the transaction (SB-18)

If the response were stored **after** committing the batch and the process
crashed between the `COMMIT` and that store, the client's retry would apply
the batch again and **duplicate the inserts**. That is why the key and the response
are written inside the same transaction: either everything is committed, or nothing. Two
simultaneous retries with the same key cannot both be applied: the
second one hits the table's primary key, is rolled back, and its next
retry receives the stored response.

### 3.4 Why `lock` is separate from `get`

`FOR UPDATE` does not work on a view with joins. The base table
(`products`) is locked and then the view (`v_products`) is read. Locking in id order
prevents two batches touching the same rows from waiting on each other
(deadlock).

---

## 4. Variants

### 4.1 Simple table, no rules: no handlers

A brands catalog edited as is. The source writes with its generic `UPDATE`,
inside its transaction:

```js
this.sheet = new SpreadBase({
	id: 'brands',
	allowInsert: true,
	allowDelete: true,
	columns: { id: { type: types.TEXT, label: 'ID' }, name: { type: types.TEXT, label: 'Marca', required: true } },
	source: postgresSource({ pool: this.pool, table: 'brands' })
});
```

### 4.2 In memory: demos and tests

`memorySource` implements reading and writing with a version counter, but
**no** transaction: the engine applies batches one at a time within the process
and stores idempotency in memory. An error halfway through a batch is not rolled back.
Good for demos, tests and the examples; not for production.

```js
source: memorySource({ rows: seed, createId: (n) => `prd_${n}` })
```

### 4.3 Mongo (Aggy's database)

The same shape with another source: `mongoSource` (2026-10-08). It receives the app's
`mongodb` client (the library does not install it: it is an optional dependency and is
imported only to build an `ObjectId`). The sheet can be **part of a
collection**: in Aggy Legacy all data tables share
`datadocuments`, and a sheet is `{ accountId, dataTableId }`.

```js
import { MongoClient, ObjectId } from 'mongodb';

const client = await new MongoClient(process.env.MONGO_URL).connect();

this.sheet = new SpreadBase({
	id: `datatable-${dataTableId}`,
	allowInsert: true,
	allowDelete: true,
	columns,
	source: mongoSource({
		client,
		db: 'aggy',
		collection: 'datadocuments',
		// Every read and write carries it; new documents are born with these fields.
		filter: { accountId: new ObjectId(accountId), dataTableId: new ObjectId(dataTableId) },
		collation: { locale: 'es', strength: 1 } // sort ignoring accents and case
	}),
	handlers: {
		updateMany: async (items, { tx }) => {
			for (const { id, values } of items) {
				await DataDocument.updateOne({ _id: id }, { $set: values }, { session: tx.db });
			}
			return items.map((i) => ({ id: i.id })); // the engine re-reads the row and the source sets the fingerprint
		}
	}
});
```

- **The id travels as text**: `_id` (or `idField`) comes out as its string; an id
  of 24 hex characters is looked up both as an `ObjectId` and as text.
- **`rowVersion`**: the md5 fingerprint of the writable fields as they are
  stored, computed on read (SB-4): any part of the app that writes to the
  collection counts, with no version field. With `versionField`, a counter that the
  source sets to 1 on create and increments (`$inc`) on every write; then every
  process that writes must increment it too.
- **Values**: documents from a schemaless app store things however they can. On
  read, a number stored as text comes out as a number, a `Date` or
  text date comes out as `YYYY-MM-DD` (date-time in UTC), `'true'` comes out as `true`. On
  write, what the engine sends is stored (numbers as numbers, dates as
  canonical text).
- **Filters (SB-33)**: the same rule as `matchesFilter`, as aggregation
  expressions (`$expr`): empty = `null`, missing or `''`; text ignoring accents and
  case; a number as a number even if stored as text; date-time by its
  day. What goes in `$expr` does not use indexes: the fixed filter does (an
  index `{ accountId: 1, dataTableId: 1 }` is advisable).
- **Total (SB-35)**: exact `countDocuments`; `estimatedDocumentCount` only if
  the query is the whole collection (with a fixed filter, the estimate would cover
  all tables).
- **Transaction (SB-19)**: `session.withTransaction`, with `snapshot` read concern.
  **Requires a replica set** (a single-node one is enough); without it,
  `transactions: false` and the engine applies batches one at a time in the
  process, as in memory. The handler receives the session in `ctx.tx.db`.
- **Locking (`lock`)**: Mongo has no `SELECT … FOR UPDATE`. Inside the
  transaction a per-row lock is written to `spreadbase_locks`
  (`{ _id: '<sheet>:<id>' }`, one-hour TTL index). Two batches on the same
  row collide when writing it (`WriteConflict`) and the driver **retries the
  second one from the start**, now with what the first one committed: the second one
  sees the conflict. Since the transaction's reads come from a fixed snapshot,
  whatever another process writes to the document after the snapshot also makes
  the write collide and retry. It is optimistic concurrency with retry,
  not a wait.
- **Idempotency (SB-18)**: in `spreadbase_idempotency`, in the same
  transaction as the batch, with a TTL index on `expiresAt`. Two simultaneous
  retries with the same key: one is applied and the other, when retried,
  finds the stored response.
- Requirements: MongoDB 4.4 or later (`$replaceAll`). Tested against Mongo 7 in
  Docker: `tests/mongo/`, with the contract kit (SB-26) over HTTP.

---

## 5. What is inside a source

The library writes it once; whoever uses it does not touch it. For `postgresSource`:

```js
transaction: async (fn) => {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const result = await fn(bindTo(client)); // the same source, using this client; exposes `db: client`
		await client.query('COMMIT');
		return result;
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally {
		client.release();
	}
}
// fingerprint:   md5(row(<writable columns>)::text) computed in the same SELECT
// lock(ids):     SELECT 1 FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE
// get(id):       SELECT …, <fingerprint> AS "rowVersion" FROM v_products WHERE id = $1
// list(query):   SELECT …, <fingerprint> FROM v_products WHERE … ORDER BY <field>, id LIMIT $n OFFSET $m  (+ count)
// update:        UPDATE products SET … WHERE id = $1 RETURNING …   (only if there is no handler)
// idempotency:   spreadbase_idempotency, created with CREATE TABLE IF NOT EXISTS
```

`READ COMMITTED` (Postgres's default level) is enough: once the row is
locked, what is read is the latest committed version and nobody else can
write it until the `COMMIT`.

---

## 6. Decisions

| # | Decision |
|---|---|
| **SB-4** | The user's table needs nothing: `rowVersion` is a fingerprint of the writable columns, or a version column if one already exists |
| **SB-16** | Notices are computed by the server with `base`, what the client read in the writable columns it did not touch |
| **SB-18** | Idempotency is handled by the engine and stored by the source in the same transaction; with Postgres, in `spreadbase_idempotency`, created by the library; with Mongo, in the collection of the same name, with TTL |
| **SB-19** | The transaction comes with the source; handlers receive it in `ctx.tx` |
| **SB-20** | A domain error rolls back the whole batch |
