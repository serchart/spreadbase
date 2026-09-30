# tests

Pruebas E2E de SpreadBase contra los [ejemplos](../examples). **Una prueba
cuenta una historia de usuario** y puede llamar a la API y manejar el
navegador en la misma historia. Principios: `docs/01-diseno.md` §7.

## Una sola vez

```bash
npm install                                   # desde la raíz
npx playwright install chromium
```

## Antes de correr

Los ejemplos encendidos, cada uno en su terminal (las pruebas no los arrancan):

```bash
npm run back
npm run front
```

## Correr (desde la raíz)

```bash
npm test                        # todo
npm test -- protocol            # un módulo (nombre de su directorio)
npm test -- grid/recorrido      # un archivo
```

Variables para apuntar a otros servidores: `TEST_API_URL` y `TEST_FRONT_URL`.

## Varias sesiones a la vez (otro agente, otra persona)

Las pruebas **reinician** la hoja de casos y cambian filas del ejemplo de
Postgres. Si otra sesión usa los mismos servidores (4100 y 5180), o los
reinicia al editar código (`tsx watch`), las pruebas fallan de forma
intermitente: un reinicio a medias, una fila que otro cambió. En ese caso,
**servidores propios en otros puertos**, y sin recarga automática:

```bash
# backend de los ejemplos en 4101, sin watch
cd examples/backend && PORT=4101 CORS_ORIGIN=http://localhost:5181 PUBLIC_URL=http://localhost:4101 \
  UPLOADS_DIR=uploads-test npx tsx src/index.ts

# frontend en 5181, apuntando a ese backend
cd examples/frontend && PUBLIC_API_URL=http://localhost:4101 npx vite dev --port 5181 --strictPort

# las pruebas, contra esos dos
TEST_API_URL=http://localhost:4101 TEST_FRONT_URL=http://localhost:5181 npm test
```

- La hoja de casos vive en memoria de cada servidor: con el suyo, nadie más la
  reinicia.
- El ejemplo de Postgres comparte la base de `DATABASE_URL`. Para aislarlo
  también, otra base (`createdb spreadbase_test`, `DATABASE_URL=…/spreadbase_test
  npm run postgres:setup`) y esa `DATABASE_URL` en el backend y en las pruebas.
- Al terminar, apagar el árbol completo de esos procesos.

## Dos políticas de concurrencia

La suite salta automáticamente lo que no aplica a la política activa. Para
cubrir las dos:

```bash
CASES_POLICY=strict BATCH_LOG=0 npm run back
npm test -- protocol
```

## Estructura

| Directorio | Qué es |
|---|---|
| `support/` | Entorno, cliente HTTP real, harness de Playwright (usuarios = contextos; consola y capturas por prueba), acceso a la hoja |
| `protocol/` | Las reglas del protocolo por HTTP: lectura, lote, concurrencia por campo, idempotencia |
| `grid/` | La hoja en el navegador: páginas `/cases` (con servidor) y `/local` (sin él); la columna lookup, la contraseña y la casilla en `/postgres` (se omiten si ese ejemplo no responde) |
| `postgres/` | `postgresSource`, las columnas lookup y la contraseña contra una base real (`DATABASE_URL`). Proyecto aparte: no necesita los ejemplos encendidos (`npm test -- --project postgres`) |
| `test-results/` | Capturas y consolas (no se versiona) |

## Artefactos

Cada prueba de navegador escribe en `test-results/<archivo>/<prueba>/`: una
captura por paso marcado y por fallo, y la consola de cada usuario. En las
consolas busca los grupos `[datagrid:…]`; en el log del backend, los bloques
`[batch]`, `[mutate]` e `[idempotency]`.
