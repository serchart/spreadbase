# Playground

Banco de desarrollo de SpreadBase: una hoja de **50 000 casos de cobranza
sintéticos**, montada como lo haría una app real, contra la que corren las
pruebas E2E. No es para aprender la librería —para eso está
[`examples/basic`](../examples/basic)—, es para desarrollarla y probarla.

```
backend/    Express 5 + TypeScript (tsx), en capas como OpenCollect:
              src/modules/cases/cases.routes.ts      rutas del protocolo + dev/reset y dev/mutate
              src/modules/cases/cases.controller.ts  parseListQuery / parseBatch de @spreadbase/server
              src/modules/cases/cases.service.ts     new SpreadBase({ columns, source, handlers })
              src/modules/cases/cases.seed.ts        semilla determinista
frontend/   SvelteKit + Tailwind + daisyUI
              /        new Sheet(`${API_URL}/api/cases`)  — contra el servidor
              /local   new Sheet({ id, columns, dataSource }) — sin servidor, con banco de rendimiento
```

## Arranque

Desde la raíz, tras `npm install`, cada uno en su terminal:

```bash
npm run playground:back    # http://localhost:4100
npm run playground:front   # http://localhost:5180
```

Variables del backend en [`backend/.env.example`](backend/.env.example):
`PORT`, `CORS_ORIGIN`, `APP_ENV` (`test` habilita reset y mutate; es el
valor por defecto), `LATENCY_MS` (150 ms ±40 %; la cabecera `x-latency: 0` la
anula en una petición), `CASES_ROWS`, `CASES_POLICY` (`merge` | `strict`) y
`BATCH_LOG=0` para no imprimir cada lote.

## Rutas

Bajo `/api/cases`, las cinco del protocolo de SpreadBase (`docs/01-diseno.md` §5):

| Método | Ruta | Respuesta |
|---|---|---|
| `GET` | `/schema` | Columnas, `idField`, `allowInsert`, `allowDelete`, `policy` |
| `GET` | `/?offset&limit&sort=campo:asc\|desc&search=&<campo>=a,b` | `{ rows, total, offset, limit, version }` |
| `GET` | `/:id` | Una fila |
| `GET` | `/:id/position?…` | `{ id, position, total }` |
| `POST` | `/batch` | `{ created, updated, deleted, notices, conflicts }`. Acepta `Idempotency-Key` |

Y dos de prueba, solo con `APP_ENV=test`:

```bash
# Otro «usuario» cambia el nombre de case_000001
curl -X POST localhost:4100/api/cases/dev/mutate \
  -H 'content-type: application/json' -d '{"ids":["case_000001"],"fields":["customer_name"]}'

# Volver a la semilla
curl -X POST localhost:4100/api/cases/dev/reset
```

## Origen

Es la copia del sandbox y el playground del DataGrid de OpenCollect, con el
motor extraído a `@spreadbase/server` y el grid a `@spreadbase/client`. Las
referencias en comentarios a «§11.14», «G-12» o `07-anexo-datagrid-engine.md`
apuntan a `open-collect-crm/docs/`.
