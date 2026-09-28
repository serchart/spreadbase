# SpreadBase

SpreadBase lets you handle and visualize your database as a simple spreadsheet.

Una hoja de cálculo sobre tus datos: edítalos, agrégales y bórralos en miles
de filas, con deshacer y rehacer, borrador local entre recargas y guardado en
lote que detecta choques entre usuarios.

Estado: **en construcción**. Diseño en `docs/`.

```
packages/server  @spreadbase/server — motor, fuentes de datos y helpers HTTP (backend)
packages/client  @spreadbase/client — Sheet + <SpreadBase>: la hoja, historial, borrador y paneles (frontend)
packages/core    @spreadbase/core — tipos y validación compartidos; llega con los otros dos
examples/basic   ejemplo didáctico: back + front mínimos
playground/      banco de desarrollo: 50 000 filas, pruebas E2E y rendimiento
tests/           pruebas E2E por módulo (API real + navegador)

examples/sandbox copia probada de OpenCollect de la que se extraen los paquetes (temporal)
```

## Desarrollo

Mientras se extraen los paquetes, lo que funciona es la copia probada:
ver `examples/sandbox/README.md`.

Las apps que lo usen mientras no se publique apuntan al repo local
(`"@spreadbase/client": "file:../SpreadBase/packages/client"` en el front,
`"@spreadbase/server": "file:../SpreadBase/packages/server"` en el back).
