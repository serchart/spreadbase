# Ejemplo · sandbox

Réplica del playground del DataGrid de OpenCollect (`/playground/datagrid`)
con su backend `sandbox`: 50 000 casos sintéticos en memoria, una hoja que
carga por ventanas, edita (con altas y bajas), guarda un borrador en IndexedDB
y guarda por lotes con concurrencia por campo.

Es una **copia del código que ya funciona en OpenCollect**, adaptada solo en
lo mínimo para correr sola. No usa los paquetes de `packages/`: cada carpeta es
un proyecto npm independiente.

```
backend/    Express 5 + TypeScript (tsx). Módulo sandbox: routes → controller → service
frontend/   SvelteKit + Tailwind + daisyUI. El grid vive en src/lib/components/datagrid/
tests/      E2E sin mocks (Vitest + Playwright) contra los dos servidores encendidos
```

## Origen

| Aquí | En `open-collect-crm/` |
|---|---|
| `backend/` | `backend/` completo (solo tiene el módulo `sandbox`) |
| `frontend/src/lib/components/datagrid/` | `frontend/src/lib/components/datagrid/` |
| `frontend/src/routes/+page.svelte` | `frontend/src/routes/playground/datagrid/+page.svelte` |
| `frontend/src/routes/+layout.svelte` | Layout raíz + `playground/+layout.svelte`, en uno |
| `frontend/src/lib/mocks/cases.ts` | Solo `STAGE_OPTIONS` y `HANDLER_OPTIONS` del mock de casos |
| `frontend/src/lib/{api,stores,mocks/charges.ts,…}` | Las mismas rutas |
| `tests/` | `tests/` completo |

Cambios respecto al original: los puertos (4100/5180, para poder correr a la
vez que OpenCollect en 4000/5173), los nombres de los paquetes y el layout.
Las referencias en comentarios a `docs/07-anexo-datagrid-engine.md`, «doc 09»
o secciones como «§11.14» apuntan a `open-collect-crm/docs/`.

## Arranque

```bash
# una vez
(cd backend && npm install)
(cd frontend && npm install)
(cd tests && npm install && npx playwright install chromium)

# cada uno en su terminal
cd backend && npm run dev     # http://localhost:4100
cd frontend && npm run dev    # http://localhost:5180
```

- `http://localhost:5180/`: fuente **local** (ledger de cargos en el navegador,
  con banco de rendimiento).
- `http://localhost:5180/?source=remote`: fuente **remota**, 50 000 filas del
  backend.

Variables del backend en `backend/.env.example` (latencia simulada, filas,
política `merge|strict`).

## Verificación

```bash
(cd backend && npm run check)
(cd frontend && npm run check)
(cd frontend && npm test)     # propiedades del historial (código puro)
(cd tests && npm test)        # E2E de API; exige los dos servidores encendidos
```
