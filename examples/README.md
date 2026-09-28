# Ejemplos

**Un servidor y una app para todos los ejemplos.** La base común (Express en el
back, SvelteKit en el front) está una sola vez; cada ejemplo es una carpeta.

```
backend/                            un solo servidor · http://localhost:4100
├── src/app.ts                      base común: CORS, JSON, salud, errores; monta cada ejemplo en /api/<nombre>
├── src/config/env.ts               variables (lee también SpreadBase/.env)
└── src/examples/
    ├── basic/                      contactos en memoria · sheetRouter                → /api/basic/contacts
    ├── postgres/                   tienda JS estilo Aggy · postgresSource + handlers  → /api/postgres/products/sheet
    └── cases/                      50 000 casos en capas, latencia simulada          → /api/cases

frontend/                           una sola app · http://localhost:5180
└── src/routes/
    ├── +page.svelte                índice con enlace a cada ejemplo
    ├── basic/  postgres/  cases/   new Sheet(`${API_URL}/api/…`)
    └── local/                      sin servidor: new Sheet({ id, columns, dataSource }) + banco de rendimiento
```

| Ejemplo | Para qué mirarlo |
|---|---|
| [**Básico**](backend/src/examples/basic/) | Lo mínimo: una hoja en memoria montada con `sheetRouter`, y `new Sheet(url)` en la página |
| [**Postgres**](backend/src/examples/postgres/) | Un backend real al estilo de Aggy: `postgresSource`, handlers de dominio y transacción. Es el de `docs/02-fuentes-transacciones-handlers.md` |
| [**Casos**](backend/src/examples/cases/) | Un módulo en capas (`routes → controller → service`) con 50 000 filas y latencia simulada. **Las pruebas E2E corren contra este** |
| **Sin servidor** | La hoja definida en el front, con datos en el navegador |

## Correrlo

Desde la raíz del repo, tras `npm install`, cada uno en su terminal:

```bash
npm run back     # http://localhost:4100
npm run front    # http://localhost:5180  ← el índice
```

El ejemplo **Postgres** necesita `DATABASE_URL` (en `SpreadBase/.env`) y crear
sus tablas una vez; sin ella responde 503 y los demás funcionan igual:

```bash
npm run postgres:setup   # tablas + 500 productos
npm run postgres:reset   # borra y vuelve a la semilla
```

## Variables

En [`backend/.env.example`](backend/.env.example). Todas tienen valor por
defecto; el servidor lee además `SpreadBase/.env`.

| Variable | Qué hace |
|---|---|
| `PORT`, `CORS_ORIGIN` | 4100 y `http://localhost:5180` |
| `APP_ENV` | `test` (por defecto) habilita las rutas de prueba de casos: `dev/reset` y `dev/mutate` |
| `LATENCY_MS` | Latencia simulada del ejemplo de casos (150 ms ±40 %). La cabecera `x-latency: 0` la anula en una petición |
| `CASES_ROWS`, `CASES_POLICY` | Filas del ejemplo de casos y su política de cambios ajenos (`merge` · `strict`) |
| `BATCH_LOG=0` | No imprimir cada lote del ejemplo de casos |
| `DATABASE_URL` | Postgres del ejemplo Postgres |

## Rutas de prueba del ejemplo de casos

```bash
# Otro «usuario» cambia el nombre de case_000001
curl -X POST localhost:4100/api/cases/dev/mutate \
  -H 'content-type: application/json' -d '{"ids":["case_000001"],"fields":["customer_name"]}'

# Volver a la semilla
curl -X POST localhost:4100/api/cases/dev/reset
```

## Origen

El ejemplo de casos y la página «Sin servidor» son el sandbox y el playground
del DataGrid de OpenCollect, con el motor extraído a `@spreadbase/server` y el
grid a `@spreadbase/client`. Las referencias en comentarios a «§11.14», «G-12»
o `07-anexo-datagrid-engine.md` apuntan a `open-collect-crm/docs/`.
