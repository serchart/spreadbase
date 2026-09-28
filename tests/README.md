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
| `grid/` | La hoja en el navegador: páginas `/cases` (con servidor) y `/local` (sin él) |
| `postgres/` | `postgresSource` contra una base real (`DATABASE_URL`). Proyecto aparte: no necesita los ejemplos encendidos (`npm test -- --project postgres`) |
| `test-results/` | Capturas y consolas (no se versiona) |

## Artefactos

Cada prueba de navegador escribe en `test-results/<archivo>/<prueba>/`: una
captura por paso marcado y por fallo, y la consola de cada usuario. En las
consolas busca los grupos `[datagrid:…]`; en el log del backend, los bloques
`[batch]`, `[mutate]` e `[idempotency]`.
