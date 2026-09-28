# tests/protocol — el protocolo HTTP de SpreadBase

Las reglas del protocolo (`docs/01-diseno.md` §5) probadas por HTTP contra la
hoja de casos de los ejemplos: 50 000 filas sintéticas en `/api/cases`.

## Entorno

- Ejemplos encendidos en modo test: `npm run back` y `npm run front`.
- La «base» vive en memoria del backend: **reiniciarlo la reinicia**.
- `support.ts`: `reset()` deja la base determinista, `mutate(id, fields)`
  simula a otro usuario cambiando campos concretos, `batch()` envía lotes.

## Qué cubre `api.*`

- **Lectura:** páginas (`offset`/`limit`, recorte al final), `rowVersion` y
  `locate`. Una fila inexistente es 404.
- **Guardado (`batch`)**, las reglas de §11.13–§11.14:
  - sin cambios ajenos: edita, crea (id temporal → id real) y elimina;
  - concurrencia por campo: mismo campo → `field_conflict` con
    Original · Tuyo · Remoto; campos distintos → según la política de la
    colección (`merge`: se aplica + `notices`; `strict`: `version_mismatch`);
    comparación normalizada (`1500` = `"1500.00"`);
    el cambio ajeno puede venir de `mutate` o de **otro lote**;
  - bajas: eliminar lo que otro editó es siempre conflicto (G-16);
    eliminar lo que otro ya eliminó se reporta como eliminado;
    editar lo que otro eliminó es `not_found`;
  - éxito parcial (G-11): un conflicto no bloquea el resto del lote;
  - lotes inválidos: forma vieja de `changes` o campo de solo lectura → 400.
- **Idempotencia (G-12):** reintento con la misma llave → misma respuesta sin
  duplicar; misma llave con otro cuerpo → 422; sin llave, cada envío cuenta.

Los casos ligados a `strict` se omiten cuando el servidor está en `merge` (lo
leen de `/api/cases/schema`). Para cubrirlos, corre la suite contra un
servidor en `strict` (ver README de `tests/`).

## Correr solo este módulo

```bash
npm test -- protocol
```
