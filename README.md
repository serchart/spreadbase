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
examples/        un servidor y una app para todos los ejemplos: básico, Postgres, casos (50 000 filas) y sin servidor
tests/           E2E por módulo (API real + navegador) y fuentes contra una base real
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

Las columnas las define el servidor; lo que es de la pantalla se ajusta en el
cliente (SB-23):

```ts
new Sheet(url, {
	columns: {
		name: { width: 260 },                       // parche sobre la columna del servidor
		status: (col) => ({ ...col, label: '…' }),  // función: recibe la del servidor y devuelve la final
		nota: { type: 'text', label: 'Nota' }       // no está en el servidor: solo del cliente (solo lectura)
	},
	actions: [{ label: 'Abrir', icon, onclick: (row) => abrir(row.id) }] // atajo: columnas `action` al principio
});
```

La barra tiene tres secciones —edición (solo icono), acciones (Guardar y las
tuyas, con texto) y paneles— y acepta botones propios (SB-24):

```svelte
<SpreadBase {sheet} fill toolbar={{ actions: [{ label: 'Nuevo canal', icon: Plus, onclick: nuevo }] }} />
```

Ejemplos en [`examples/`](examples): el básico, un backend JS al estilo de Aggy
sobre Postgres, y un módulo en capas (`routes → controller → service`) con
50 000 filas.

## Desarrollo

```bash
npm install
npm run check                    # tipos de todos los paquetes y apps
npm run test:unit                # propiedades del historial (código puro)

npm run back                     # servidor de ejemplos: http://localhost:4100   ┐ cada uno en
npm run front                    # app de ejemplos:      http://localhost:5180   ┘ su terminal
npm test                         # E2E contra los ejemplos (reinicia la hoja de casos) + Postgres

npm run postgres:setup           # tablas y semilla del ejemplo Postgres (necesita DATABASE_URL en .env)
npm run postgres:reset           # vuelve a la semilla
npm test -- --project postgres   # solo las pruebas de postgresSource
```

Las apps que lo usen mientras no se publique apuntan al repo local
(`"@spreadbase/client": "file:../SpreadBase/packages/client"` en el front,
`"@spreadbase/server": "file:../SpreadBase/packages/server"` en el back).
