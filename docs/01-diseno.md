# 01 — Diseño de SpreadBase

> Documento vivo. Decisiones acordadas con el propietario del proyecto.
> Referencia de origen: `open-collect-crm/docs/07-anexo-datagrid-engine.md`.

**Creado:** 2026-09-27 · **Estado:** 🟢 vigente

## Qué es

Una librería npm instalable con tres paquetes: `@spreadbase/core`,
`@spreadbase/server` y `@spreadbase/svelte`. Quien la usa define **solo el
dominio**: el esquema de la hoja y cómo se guarda. Todo lo demás —ventana por
tramos, borrador local, historial de deshacer, guardado en lote, concurrencia
por campo, idempotencia, panel de cambios y, a futuro, colaboración en tiempo
real— lo hace SpreadBase por debajo.

## Partes

| Pieza | Qué contiene | De dónde sale |
|---|---|---|
| **core** | Tipos de celda y esquema (`defineSheet`), validación compartida, tipos del protocolo HTTP | Reescrito desde `frontend/src/lib/components/datagrid/cellTypes.ts` (solo lo agnóstico de Svelte) |
| **server** | `spreadBase(sheet, { source, write, policy })` → router Express con `/catalogs`, lectura por tramos, `locate`, `batch`; middleware de idempotencia; adaptadores de almacenamiento | Extraído de `backend/src/modules/sandbox/` |
| **svelte** | `<SpreadBase>` con controlador, hoja, historial, borrador IndexedDB, paneles | Copiado de `frontend/src/lib/components/datagrid/` |
| **demo** | Hoja de 50 000 filas sintéticas, front + back, para desarrollo y pruebas | El playground actual, trasladado |

## Decisiones de base

| # | Decisión |
|---|---|
| **SB-1** | **Un solo esquema, compartido.** Se define una vez en `core` y valida igual en front y en back. Lo visual del front (ancho, etiqueta, formato) se añade aparte |
| **SB-2** | **Adaptador de almacenamiento, no base embebida.** SpreadBase habla con una interfaz chica (listar tramo, localizar, leer varias, aplicar lote). Memoria ahora; Postgres después. La conexión es de la app |
| **SB-3** | **La escritura es el dominio.** Lectura por vista/consulta; escritura por `updateMany`/`insertMany` de dominio. SpreadBase nunca hace `UPDATE` directo de tu tabla |
| **SB-4** | **Concurrencia exige convenciones en la fuente**: `row_version` y conocer qué campos cambiaron desde una versión (historial o columnas de versión por campo). Documentado como requisito |
| **SB-5** | **El protocolo no cambia:** el del lote ya probado (`{ from, to }` por campo, `notices`, `conflicts`, `Idempotency-Key`). Ver §11.13–§11.14 del anexo de origen |
| **SB-6** | **Cliente solo Svelte, por ahora.** El controlador usa runes; separarlas si algún día se pide React |
| **SB-7** | **Estilos: Tailwind + daisyUI como `peerDependencies`.** La app consume `@source` al CSS de la librería y así herteda su tema. jspreadsheet/jsuites/lucide son dependencias normales |
| **SB-8** | **Tiempo real después, sin cerrar la puerta:** todo lote aplicado emite un evento `{ fila, campos, versión }` que más adelante alimenta presencia, cursores y Redis |
| **SB-9** | **Repo privado, licencia MIT al publicar.** Scope npm `@spreadbase` reservado |

## Protocolo (resumen)

`defineSheet` → esquema con campos, tipos, obligatorios, opciones y reglas.
La misma definición:

- servidor: monta `GET /<hoja>/catalogs`, `GET /<hoja>?offset&limit&…`,
  `GET /<hoja>/:id/position`, `GET /<hoja>/:id`, `POST /<hoja>/batch`;
- front: ordena la hoja y valida al editar.

El lote de guardado (petición/respuesta) ya está fijado y probado; no se
rediseña.

## Pruebas

Las del proyecto actual se trasladan: contracto del lote (23 casos, en
`tests/engine/`), propiedades del historial (en `packages/svelte`) y las E2E de
navegador contra `apps/demo`.

## Plan

1. Base del repo (workspaces, TypeScript, Vitest). ← aquí
2. `core`: esquema y validación compartida.
3. `svelte`: copiar el grid y hablar con `core`.
4. `server`: partir el sandbox en motor + adaptador en memoria + esquema demo.
5. `apps/demo` y E2E de navegador en `tests/`.
6. OpenCollect cambia a los paquetes y borra su copia local.
