# tests/sandbox — casos de cobranza y DataGrid

Módulo: **casos de cobranza** con 50 000 filas sintéticas y la hoja de
cálculo que los edita (`docs/07-anexo-datagrid-engine.md`, engine §11).

## Entorno

- Backend en modo sandbox: `cd backend && npm run dev`.
- Frontend: `cd frontend && npm run dev`.
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
leen de `/api/sandbox/catalogs`). Para cubrirlos, corre la suite contra un
servidor en `strict` (ver README de `tests/`).

## Correr solo este módulo

```bash
cd tests && npm test -- sandbox        # API
# con el navegador, cuando existan las pruebas de grid:
cd tests && npm test -- sandbox/grid
```
