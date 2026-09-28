# tests/grid — la hoja en el navegador

Escenarios de usuario sobre la hoja del playground, en Chrome real
(Playwright). Cada escenario comprueba **lo que se ve** (texto y clases de las
celdas, contadores, diálogos) y, cuando importa el resultado final, **lo que
quedó en el servidor** (API).

Fuentes de los escenarios: las verificaciones manuales de
`open-collect-crm/docs/07-anexo-datagrid-engine.md` (§11.9, §11.10, §11.12,
§11.15), la propuesta de pruebas de navegador de OpenCollect y las decisiones
G-1…G-17.

## Reglas

- **Dos usuarios = dos contextos de navegador** («Chrome A» y «Chrome B»),
  cada uno con su IndexedDB. Los escenarios de concurrencia los juegan los dos
  en el navegador, no con `dev/mutate`: se prueba lo que haría una persona.
- Cada prueba empieza con `reset()`: 50 000 casos deterministas.
- Filas de referencia: `case_000001`… (la fila *n* es `case_00000n`). Campos
  editables: Cliente, RFC, Etapa, Atiende, Promesa, Fecha promesa, Últ.
  contacto.
- Un error de página hace fallar la prueba. Se guarda la consola de cada
  usuario siempre y una captura si falla.
- Los que dependen de la política se saltan si el servidor no la tiene
  (`/api/cases/schema` → `policy`).

Estado: ✅ existe · ⬜ falta · 🟡 cubierto en parte.

---

## 1. Básicas (`basico.test.ts`)

| # | Escenario | Pasos | Se comprueba | Estado |
|---|---|---|---|---|
| **B-1** | Cargar | Abrir `/` | Columnas del esquema del servidor; pie «Filas 1–60 de 50,000»; la fila *n* muestra `case_00000n` | 🟡 columnas y total en `recorrido` |
| **B-2** | Editar varias filas y guardar | Cambiar Cliente de filas 1, 2 y 3, Etapa de la 2 | 4 celdas marcadas; botón Cambios `~3`; modal «Actualizadas 3»; API: las 3 con los valores nuevos y `rowVersion` 2 | 🟡 una sola fila en `recorrido` |
| **B-3** | Insertar | Agregar fila, llenar Cliente, RFC y Etapa, guardar | Fila arriba en verde con «+»; `+1`; tras guardar, «✓» y id real `case_050001`; API la devuelve | ⬜ |
| **B-4** | Eliminar | Eliminar fila 8, intentar editarla, guardar | Tachada y atenuada; no cambia al editarla (G-7); `−1`; tras guardar desaparece; API 404 | ⬜ |
| **B-5** | Validación | Vaciar Cliente de la fila 4; guardar | Celda inválida; panel «Con error» la lista; el guardado no llega al servidor (API sin cambios) | ⬜ |
| **B-6** | Deshacer y rehacer | Editar, agregar y eliminar; ⌘Z ×3 y ⇧⌘Z ×3; lo mismo con los botones | Cada paso revierte y repone exacto; contadores coherentes | ⬜ |
| **B-7** | Descartar | Editar, agregar, eliminar; Descartar; recargar | Todo vuelve al original; tras recargar no hay aviso de recuperación | ⬜ |
| **B-8** | Sin servidor | Abrir `/local`, editar, ⌘Z, guardar | Carga su definición; edición y deshacer; guardado local sin errores | 🟡 solo carga, en `recorrido` |

## 2. Ventana sobre 50 000 filas (`ventana.test.ts`)

| # | Escenario | Pasos | Se comprueba | Estado |
|---|---|---|---|---|
| **V-1** | Desplazarse lejos | Bajar ~1 000 filas y volver | Número de fila ↔ id sin incoherencias; nunca más de 180 filas en el DOM; sin saltos de la fila bajo el cursor | ⬜ |
| **V-2** | Editar, salir y volver desplazándose | Editar fila 5, bajar hasta la ~1 400, subir | La fila 5 vuelve con su valor y marcada; el panel la listó todo el tiempo | 🟡 salir sí, volver por recarga |
| **V-3** | Deshacer fuera de la vista (G-1) | Editar fila 5, bajar lejos, ⌘Z, ⇧⌘Z | Deshace y rehace sin mover el scroll; contador 0 → 1 | ⬜ |
| **V-4** | Ir a la fila | Editar filas 5 y 2 344; desde arriba, «Ir» en el panel a la 2 344 y de vuelta a la 5 | Llega a la fila exacta con un clic, marcada y seleccionada | ⬜ |
| **V-5** | Agregar lejos del inicio | Bajar a la ~3 000, «Agregar fila» | Lleva al inicio; la nueva queda arriba (G-2) | ⬜ |

## 3. Borrador local (`borrador.test.ts`)

| # | Escenario | Pasos | Se comprueba | Estado |
|---|---|---|---|---|
| **D-1** | Recuperar tras recargar | Editar fila 5, eliminar la 8, agregar una con nombre; recargar | Todo igual (`+1 ~1 −1`) y aviso de recuperación | 🟡 solo la edición, en `recorrido` |
| **D-2** | Deshacer tras recargar | Tras D-1, ⌘Z ×2 y ⇧⌘Z ×2 | Quita el nombre y la fila nueva; los repone | ⬜ |
| **D-3** | El borrador sobrevive a cerrar | Editar; cerrar la pestaña; abrir otra en el mismo contexto | Cambio presente (G-9) | ⬜ |
| **D-4** | Guardar limpia el borrador | Editar, guardar, recargar | Sin aviso ni pendientes | ⬜ |

## 4. Concurrencia entre dos usuarios (`concurrencia.test.ts`)

La pieza central. Salvo que se diga, **B guarda primero** y A guarda después.

| # | Escenario | A | B | Se comprueba | Estado |
|---|---|---|---|---|---|
| **C-1** | Mismo campo, valores distintos → **Mío** | Cliente de fila 1 = «A SA» | Cliente de fila 1 = «B SA», guarda | A: modal «Guardado con conflictos»; panel «Conflictos» con Original · Tuyo «A SA» · Remoto «B SA»; borde naranja en la celda; badge naranja. A elige **Mío** y guarda → API «A SA» | ✅ |
| **C-2** | Igual que C-1 → **Remoto** | ídem | ídem | A elige **Remoto** → la celda queda «B SA», sin pendientes; no se envía nada | ✅ |
| **C-3** | Campos distintos, política `merge` (G-15) | Cliente de fila 1 | RFC de fila 1, guarda | A: guardado sin conflicto; el modal avisa «Fila 1 · RFC: …» con **Ir**; al cerrar, la celda RFC se resalta; API con los dos cambios | ✅ |
| **C-4** | Campos distintos, política `strict` | ídem C-3 | ídem | A: conflicto `version_mismatch` en la fila. Solo con `CASES_POLICY=strict` | ⬜ |
| **C-5** | Mismo campo, **mismo valor** | Cliente de fila 1 = «X» | Cliente de fila 1 = «X», guarda | **No es conflicto** (decidido 2026-09-28): se aplica sin preguntar, igual al guardar que al recargar. Con `strict`, la fila se rechaza igual que ante cualquier cambio ajeno. Cubierto por HTTP en `protocol/`; falta en navegador | 🟡 |
| **C-6** | Eliminar lo que otro editó (G-16) | Elimina fila 7 | Edita Cliente de fila 7, guarda | A: conflicto «Otro usuario editó esta fila mientras la eliminabas». **Eliminar de todos modos** → API 404. Variante **Cancelar eliminación** → la fila vuelve con el valor de B | ✅ |
| **C-7** | Editar lo que otro eliminó | Edita Cliente de fila 20 | Elimina fila 20, guarda | A: conflicto `not_found`. **Recrear como nueva** → vuelve arriba con «+» y sus valores; guardar → id nuevo. Variante **Descartar mis cambios** → la fila desaparece | ✅ |
| **C-8** | Los dos eliminan la misma | Elimina fila 9 | Elimina fila 9, guarda | A: se reporta como eliminada, sin conflicto | ⬜ |
| **C-9** | Conflicto detectado **al recargar** | Edita Cliente de filas 10 y 12 | Cambia Cliente de la 10 y Atiende de la 12, guarda | A recarga: la 10 en conflicto **antes de guardar**; la 12 adopta el Atiende de B y conserva el cambio de A pendiente | ✅ |
| **C-10** | Conflicto al **volver a la ventana** | Edita Cliente de fila 5, baja lejos | Cambia Cliente de la 5, guarda | A sube: la fila 5 llega marcada en conflicto | ⬜ |
| **C-11** | Lote mixto, éxito parcial (G-11, G-13) | Edita Cliente de 3, 4 y 5; elimina la 7 | Cambia Atiende de la 3, Cliente de la 4, edita la 7; guarda | A: «2 aplicadas, 1 aviso»; la 4 y la 7 en conflicto; el scroll no se movió; API: la 3 tiene el Cliente de A y el Atiende de B, la 5 el de A | ✅ |
| **C-12** | Una fila en conflicto no se reenvía | Tras C-1 sin resolver, edita la fila 2 y guarda | — | Solo viaja la fila 2 (log del lote); la 1 sigue en conflicto y de solo lectura | ⬜ |

## 5. Red y errores (`red.test.ts`)

| # | Escenario | Cómo | Se comprueba | Estado |
|---|---|---|---|---|
| **R-1** | Doble clic en Guardar | Agregar fila; doble clic en Guardar | Una sola fila creada en el servidor | ⬜ |
| **R-2** | Corte de red al guardar (G-12) | Interceptar `POST /batch`: dejar que llegue al servidor y cortar la respuesta; reintentar | El reintento reutiliza la `Idempotency-Key`; el servidor lo aplica una vez | ⬜ |
| **R-3** | Servidor caído al abrir | Interceptar `GET /schema` con error | Mensaje «No se pudo abrir la hoja» y **Reintentar**, que funciona al quitar la intercepción | ⬜ |

---

## Prioridad

1. ~~**Concurrencia** C-1, C-2, C-3, C-6, C-7, C-9, C-11~~ ✅ en `concurrencia.test.ts`
   (C-3 y C-11 solo corren con `merge`).
2. **Básicas** B-2 a B-7.
3. **Ventana y borrador**: V-3, V-4, D-1, D-2.
4. El resto: C-4, C-5 en navegador, C-8, C-10, C-12, red.

## Correr solo este módulo

```bash
npm test -- grid
```
