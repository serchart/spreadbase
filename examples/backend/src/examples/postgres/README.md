# Ejemplo · Postgres

Un catálogo de productos en una hoja, sobre Postgres, con un backend en
**JavaScript con la estructura de Aggy**: `core/api/<módulo>/*.routes.js →
*.controller.js → *.service.js` y servicios creados en un orquestador.

Es el ejemplo de [`docs/02-fuentes-transacciones-handlers.md`](../../docs/02-fuentes-transacciones-handlers.md),
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

La base **no necesita nada para SpreadBase**: ni columna de versión ni
triggers ([`db/migrations/001_products.sql`](backend/db/migrations/001_products.sql)
solo tiene tablas del dominio). La tabla `spreadbase_idempotency` la crea la
librería la primera vez que se guarda.

```
src/examples/postgres/
├── index.js                         lo que monta el servidor común en /api/postgres
├── db/pool.js                       el pool de la app (SpreadBase usa este)
├── db/migrations/001_products.sql   tablas del dominio
├── db/setup.js                      crea las tablas y siembra 500 productos
├── common/{errors,auth}.js
└── core/
    ├── orchestrator/                instancia los servicios (como Aggy)
    └── api/
        ├── index.js                 los módulos de la API
        └── products/
            ├── products.sheet.js        columnas de la hoja
            ├── products.service.js      SpreadBase + postgresSource + handlers
            ├── products.controller.js
            └── products.routes.js       /products/sheet (protocolo) + /products/:id/price-history (REST normal)
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
npm run postgres:setup   # tablas + 500 productos (una vez)
npm run postgres:reset   # borra y vuelve a la semilla
npm run back             # el servidor común (4100)
npm run front            # la app de ejemplos: http://localhost:5180/postgres
```

Qué probar:

- Cambia un precio y guarda; `GET /api/postgres/products/<id>/price-history` muestra el historial.
- Pon «Activo» un producto con 0 existencias junto con otro cambio y guarda: no se guarda nada.
- Cambia una fila **por fuera** mientras la editas (`UPDATE products SET name = … WHERE id = …`)
  y guarda otro campo de esa fila: se combina y te avisa.
- Elimina una fila y guarda: sale de la hoja pero sigue en la tabla, con `deleted_at`.
