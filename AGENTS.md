# SpreadBase — reglas para agentes

## Estructura

- `packages/core|server|client`: la librería (`@spreadbase/*`). Diseño y
  decisiones SB-1… en `docs/01-diseno.md`.
- `playground/`: banco de desarrollo (backend en capas + frontend SvelteKit,
  50 000 filas). Las E2E corren contra él.
- `examples/basic/`: ejemplo didáctico mínimo. `examples/postgres/`: backend JS
  estilo Aggy sobre Postgres (fuente, transacción y handlers).
- `tests/`: E2E por módulo (`protocol/`, `grid/`) y fuentes contra una base
  real (`postgres/`).

## Verificación

- Tipos: `npm run check` (todos los workspaces) o `npm run check -w @spreadbase/<paquete>`.
- Código puro del cliente (propiedades del historial): `npm run test:unit`.
- E2E, con el playground encendido (cada uno en su terminal):
  `npm run playground:back` y `npm run playground:front`; luego `npm test`.
  **Las pruebas reinician la hoja de casos.** Para la política `strict`:
  `CASES_POLICY=strict npm run playground:back` y `npm test -- protocol`.
- Fuente de Postgres: `npm test -- --project postgres`, con `DATABASE_URL` en
  `.env` (Docker local: contenedor `spreadbase-pg`, puerto 5433). No necesita
  el playground.
- Un cambio en `packages/client` que se vea en pantalla se prueba también en el
  navegador (`tests/grid/`), no solo con tipos.
- Servidores en segundo plano: apagar el árbol completo (los `tsx watch`
  relanzan a sus hijos si solo se mata el proceso que escucha el puerto).

## Convenciones

- Los paquetes se distribuyen como TypeScript en crudo (sin build); los
  `exports` apuntan a `src/`.
- Los componentes de `client` solo usan clases de Tailwind/daisyUI y sus
  propios CSS: nada que dependa del `app.css` de una app.
- Un cambio de comportamiento lleva su caso en `tests/<módulo>/`.
- El código de `client` y `server` se extrajo de OpenCollect ya probado
  (SB-14): se modifica, no se reescribe, y con las pruebas en verde.
