# SpreadBase — reglas para agentes

## Estructura

- `packages/core|server|client`: la librería (`@spreadbase/*`); `packages/testing`:
  el kit de contrato que las apps corren contra sus hojas (SB-26). Diseño y
  decisiones SB-1… en `docs/01-diseno.md`.
- `examples/`: **un** servidor (`examples/backend`, base común + una carpeta
  por ejemplo en `src/examples/`) y **una** app (`examples/frontend`, índice +
  una página por ejemplo). Ejemplos: `basic`, `postgres` (backend JS estilo
  Aggy), `cases` (50 000 filas en capas; contra él corren las E2E), `local`
  (sin servidor) y `form` (formulario con `Field`/`FormState` sobre la hoja de
  `postgres`; solo página).
- `tests/`: E2E por módulo (`protocol/`, `grid/`, `contract/`) y fuentes contra
  una base real (`postgres/`).

## Verificación

- Tipos: `npm run check` (todos los workspaces) o `npm run check -w @spreadbase/<paquete>`.
- Código puro del cliente (propiedades del historial): `npm run test:unit`.
- E2E, con los ejemplos encendidos (cada uno en su terminal):
  `npm run back` y `npm run front`; luego `npm test`.
  **Las pruebas reinician la hoja de casos.** Para la política `strict`:
  `CASES_POLICY=strict npm run back` y `npm test -- protocol`.
- Fuente de Postgres y columnas lookup: `npm test -- --project postgres`, con
  `DATABASE_URL` en `.env` (Docker local: contenedor `spreadbase-pg`, puerto
  5433). No necesita los ejemplos encendidos.
- `tests/grid/lookup.test.ts` y `tests/grid/tipos.test.ts` corren sobre la página `/postgres`: necesitan
  `npm run postgres:setup` y el backend con `DATABASE_URL`; si no responde, se
  omite (no falla).
- Un ejemplo nuevo: carpeta en `examples/backend/src/examples/<nombre>/`
  montada en `app.ts` bajo `/api/<nombre>`, página en
  `examples/frontend/src/routes/<nombre>/` y entrada en `src/lib/examples.ts`.
  No se crean servidores nuevos.
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
