# Ejemplo · Postgres

Un catálogo de productos en una hoja, sobre Postgres, con un backend en
**JavaScript con la estructura de Aggy**: `core/api/<módulo>/*.routes.js →
*.controller.js → *.service.js` y servicios creados en un orquestador.

Es el ejemplo de [`docs/02-fuentes-transacciones-handlers.md`](../../../../../docs/02-fuentes-transacciones-handlers.md),
corriendo. Muestra cómo conviven las tres piezas:

| Pieza | Dónde | Qué hace aquí |
|---|---|---|
| **Fuente** | `postgresSource` en `products.service.js` | Lee de la vista `v_products`, bloquea sobre `products`, calcula la huella de cada fila y guarda la idempotencia. Trae su transacción |
| **Handlers** | `insertMany` / `updateMany` / `deleteMany` del servicio | Las reglas de la tienda, dentro de la transacción (`ctx.tx.db`) |
| **Motor** | `SpreadBase` | Valida, compara versiones, decide conflictos y avisos, responde |

Reglas de negocio del ejemplo:

- cambiar el precio deja registro en `price_history` (misma transacción);
- un producto sin existencias no se puede activar: si pasa, **el lote entero se deshace**;
- eliminar es borrado lógico (`deleted_at`): la fila sale de la vista.

**Un campo de cada tipo** en la hoja:

| Columna | Tipo | Qué muestra |
|---|---|---|
| ID, Nombre, SKU | `text` | SKU con patrón (`^[A-Z0-9-]{4,20}$`) |
| Foto | `image` | Miniatura; al editar, URL con vista previa |
| **Responsable** | **`lookup`** | Un usuario de la tabla `users` (2 000), elegido en una mini tabla con avatar, nombre, correo e id, paginada. Guarda el id y muestra el nombre ([`docs/03-lookup.md`](../../../../../docs/03-lookup.md)) |
| Precio, Existencias | `number` | Moneda con miles; mínimo 0 |
| Estado | `select` | Lista fija |
| Lanzamiento | `date` | Calendario |
| Último surtido | `datetime` | Calendario con hora |

**La hoja de usuarios** (`/postgres?sheet=users`) muestra la **contraseña**
(`PASSWORD`, [`docs/04-tipos-de-columna.md`](../../../../../docs/04-tipos-de-columna.md)):
se escribe en claro, SpreadBase guarda `hashPassword(plain)` (scrypt, en
`common/passwords.js`) y nunca la devuelve. «Activo» es una casilla
(`BOOLEAN`); la hoja no borra usuarios. Sus rutas se montan con el atajo
`sheetRouter` (`users.routes.js`); las de productos, a mano: están las dos
formas. Contraseña de la semilla: `demo-12345`.

**La columna lookup, organizada como se recomienda** (`03-lookup.md` §3): el
módulo de usuarios define una vez cómo se elige un usuario
(`users.service.js` → `this.lookup`, con su SQL), y la hoja es una función que
lo recibe: `productsSheet({ users })` → `owner_id: { type: types.LOOKUP, lookup: users.lookup }`.
El orquestador crea `usersService` antes que `productsService`.

La base **no necesita nada para SpreadBase**: ni columna de versión ni
triggers (las migraciones de [`db/migrations/`](db/migrations/) solo tienen
tablas del dominio). La tabla `spreadbase_idempotency` la crea la
librería la primera vez que se guarda.

```
src/examples/postgres/
├── index.js                         lo que monta el servidor común en /api/postgres
├── db/pool.js                       el pool de la app (SpreadBase usa este)
├── db/migrations/001_products.sql   tablas del dominio
├── db/migrations/002_catalog.sql    users + las columnas de foto, responsable, fechas
├── db/migrations/003_users_sheet.sql  contraseña y rol de los usuarios
├── db/setup.js                      crea las tablas y siembra 2 000 usuarios y 500 productos
├── common/{errors,auth,passwords}.js
└── core/
    ├── orchestrator/                instancia los servicios (como Aggy)
    └── api/
        ├── index.js                 los módulos de la API
        ├── users/
        │   ├── users.sheet.js           la hoja de usuarios: contraseña y casilla
        │   ├── users.service.js         SQL de usuarios + `lookup` + la hoja (SpreadBase + postgresSource)
        │   └── users.routes.js          /users/sheet con sheetRouter
        └── products/
            ├── products.sheet.js        productsSheet({ users }): columnas de la hoja
            ├── products.service.js      SpreadBase + postgresSource + handlers
            ├── products.controller.js
            └── products.routes.js       /products/sheet (protocolo, con /lookup/:field) + /products/:id/price-history (REST normal)
```

La página es [`examples/frontend/src/routes/postgres/+page.svelte`](../../../../frontend/src/routes/postgres/+page.svelte):
`new Sheet(`${API_URL}/api/postgres/products/sheet`)`.

## Correrlo

Necesita un Postgres en `DATABASE_URL` (en `SpreadBase/.env`). En local:

```bash
docker run -d --name spreadbase-pg -e POSTGRES_PASSWORD=spreadbase -e POSTGRES_DB=spreadbase -p 5433:5432 postgres:16-alpine
# DATABASE_URL=postgres://postgres:spreadbase@localhost:5433/spreadbase
```

Con Supabase: *Project Settings → Database → Connection string (URI)*.

Desde la raíz del repo, tras `npm install`:

```bash
npm run postgres:setup   # tablas + semilla; sobre una base anterior, solo agrega lo que falta
npm run postgres:reset   # borra y vuelve a la semilla
npm run back             # el servidor común (4100)
npm run front            # la app de ejemplos: http://localhost:5180/postgres
```

Qué probar:

- En **Usuarios**, cambia una contraseña (doble clic): el campo empieza vacío; guarda y
  mira la tabla: `SELECT left(password_hash, 20) FROM users` muestra `scrypt$…`. Recarga
  antes de guardar: la contraseña escrita no se conserva (no va al borrador).

- Abre «Responsable» (el ▾ o doble clic): busca «oscar var», baja con ↓ y elige con Enter.
  Desplázate al fondo de la mini tabla: carga el tramo siguiente.
- Pega en «Responsable» varias líneas desde fuera (`Ana López`, un nombre único,
  `usr_0007`, `Nadie`): viaja una sola petición; el homónimo queda «Ambiguo» y
  el inexistente, en rojo. Copiar y pegar dentro de la hoja no consulta nada.

- Cambia un precio y guarda; `GET /api/postgres/products/<id>/price-history` muestra el historial.
- Pon «Activo» un producto con 0 existencias junto con otro cambio y guarda: no se guarda nada.
- Cambia una fila **por fuera** mientras la editas (`UPDATE products SET name = … WHERE id = …`)
  y guarda otro campo de esa fila: se combina y te avisa.
- Elimina una fila y guarda: sale de la hoja pero sigue en la tabla, con `deleted_at`.
