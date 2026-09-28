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
examples/postgres catálogo sobre Postgres, backend JS con estructura de Aggy (fuente, transacción y handlers)
playground/      banco de desarrollo: 50 000 filas, backend en capas, pruebas E2E y rendimiento
tests/           pruebas E2E por módulo (API real + navegador)
```

## Así se usa

```ts
// backend
const contacts = new SpreadBase({ id: 'contacts', columns: { … }, source: memorySource({ rows }) });
app.use('/api/contacts', sheetRouter(contacts));
```

```svelte
<!-- frontend -->
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	const sheet = new Sheet('/api/contacts');
</script>

<SpreadBase {sheet} fill />
```

Ejemplo completo en [`examples/basic`](examples/basic); un módulo en capas
(`routes → controller → service`) en [`playground/backend`](playground/backend/src/modules/cases).

## Desarrollo

```bash
npm install
npm run check                 # tipos de todos los paquetes y apps
npm run test:unit             # propiedades del historial (código puro)

npm run playground:back       # http://localhost:4100   ┐ cada uno en
npm run playground:front      # http://localhost:5180   ┘ su terminal
npm test                      # E2E contra el playground (lo reinicia)

npm run basic:back            # http://localhost:4200
npm run basic:front           # http://localhost:5280

npm run postgres:setup        # tablas y semilla del ejemplo Postgres (necesita DATABASE_URL en .env)
npm run postgres:reset        # vuelve a la semilla
npm run postgres:back         # http://localhost:4300
npm run postgres:front        # http://localhost:5380
npm test -- --project postgres   # pruebas de postgresSource contra DATABASE_URL
```

Las apps que lo usen mientras no se publique apuntan al repo local
(`"@spreadbase/client": "file:../SpreadBase/packages/client"` en el front,
`"@spreadbase/server": "file:../SpreadBase/packages/server"` en el back).
