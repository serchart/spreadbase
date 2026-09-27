# SpreadBase

SpreadBase lets you handle and visualize your database as a simple spreadsheet.

Una hoja de cálculo sobre tus datos: edítalos, agrégales y bórralos en miles
de filas, con deshacer y rehacer, borrador local entre recargas y guardado en
lote que detecta choques entre usuarios.

Estado: **en construcción**. Diseño en `docs/`.

```
packages/core    esquema compartido, tipos y validación (front y back)
packages/server  motor y router Express + adaptadores de almacenamiento
packages/svelte  <SpreadBase> — el grid, historial, borrador y panel
apps/demo        hoja de prueba con 50 000 filas sintéticas
tests/           pruebas E2E por módulo (API real + navegador)
```

## Desarrollo

```bash
npm install
npm run check
npm run demo    # apps/demo, cuando exista
npm run test    # raíz de pruebas, cuando exista
```

Las apps que lo usen mientras no se publique apuntan al repo local
(`"@spreadbase/svelte": "file:../SpreadBase/packages/svelte"`, igual para
`core` y `server`).
