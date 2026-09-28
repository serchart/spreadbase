# Ejemplo sandbox — backend

API REST en **Express 5 + TypeScript** (ESM), ejecutada con `tsx` sin paso de
compilación. Estructura por módulos `routes → controller → service`, como en el
backend de Aggy. Stack y decisiones: `docs/03-anexo-estructura-proyecto.md`.

## Arranque

```bash
cd backend
npm install
cp .env.example .env     # opcional: todo tiene valor por defecto
npm run dev              # http://localhost:4100, recarga al guardar
```

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga automática |
| `npm start` | Servidor sin recarga |
| `npm run check` | Verificación de tipos (`tsc --noEmit`) |

Variables en `.env.example`: `PORT`, `CORS_ORIGIN`, `SANDBOX_LATENCY_MS`,
`SANDBOX_ROWS`.

## Módulos

### `sandbox` — datos sintéticos para el DataGrid

**50 000 casos en memoria**, generados con semilla fija: cada arranque produce
las mismas filas. No usa Postgres ni el esquema real; sirve para probar el
DataGrid contra un backend HTTP con volumen: carga por ventanas, guardado por
lotes y conflictos. Diseño completo: `docs/07-anexo-datagrid-engine.md` §11.

Todas las rutas del sandbox responden con **latencia simulada** (150 ms ±40 %
por defecto), para que aparezcan los problemas de una red real. La cabecera
`x-sandbox-latency: 0` la desactiva en una petición.

| Método | Ruta | Respuesta |
|---|---|---|
| `GET` | `/api/sandbox/catalogs` | Opciones de etapa y responsable; esquema de columnas |
| `GET` | `/api/sandbox/cases?offset&limit&sort&stage&handler&search` | `{ rows, total, offset, limit, version }` |
| `GET` | `/api/sandbox/cases/:id` | Una fila |
| `GET` | `/api/sandbox/cases/:id/position?…` | `{ id, position, total }`; `position` es `null` si la consulta excluye la fila |
| `POST` | `/api/sandbox/cases/batch` | `{ created, updated, deleted, conflicts }` |
| `POST` | `/api/sandbox/dev/mutate` | Simula a otro usuario editando filas |
| `POST` | `/api/sandbox/dev/reset` | Vuelve a la semilla |

Parámetros del listado: `limit` 1–500 (100 por defecto); `sort=campo:asc|desc`,
siempre con desempate por `id`; `stage` y `handler` admiten varios valores
separados por coma; `search` busca en nombre, RFC e id sin distinguir acentos.

**Guardado.** `{ creates: [{ key, values }], updates: [{ id, rowVersion,
changes }], deletes: [{ id, rowVersion }] }`. Un lote mal formado se rechaza
entero con 400 y el detalle por campo. Una fila cuyo `rowVersion` no coincide
—otro usuario la cambió o la borró— va a `conflicts` y **el resto se aplica**.

**Idempotencia.** Con la cabecera `Idempotency-Key`, repetir la petición
devuelve la misma respuesta sin aplicarla dos veces (cabecera
`Idempotent-Replayed: true`). Reusar la llave con otro cuerpo: 422
`idempotency_key_reused`. Una llave por intento de guardado.

```bash
# Provocar un conflicto: otro «usuario» cambia la fila case_000001
curl -X POST localhost:4100/api/sandbox/dev/mutate \
  -H 'content-type: application/json' -d '{"ids":["case_000001"]}'
```

Errores: siempre `{ error: { code, message, details? } }`.
