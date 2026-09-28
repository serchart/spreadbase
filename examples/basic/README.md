# Ejemplo básico

Una hoja de contactos (1 000 filas en memoria) con lo mínimo en cada lado.

**Backend** — [`backend/src/index.ts`](backend/src/index.ts): define la hoja
(columnas, reglas y fuente de datos) y la monta en una URL con `sheetRouter`.

```ts
const contacts = new SpreadBase({ id: 'contacts', columns: { … }, source: memorySource({ rows }) });
app.use('/api/contacts', sheetRouter(contacts));
```

**Frontend** — [`frontend/src/routes/+page.svelte`](frontend/src/routes/+page.svelte):
se conecta a esa URL. Las columnas llegan del servidor.

```svelte
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	const sheet = new Sheet('http://localhost:4200/api/contacts');
</script>

<SpreadBase {sheet} fill />
```

Con eso ya hay: carga por tramos, edición, altas y bajas, deshacer y rehacer,
borrador que sobrevive a recargar y guardado que detecta choques entre usuarios.

## Correrlo

Desde la raíz del repo, tras `npm install`, cada uno en su terminal:

```bash
npm run basic:back    # http://localhost:4200
npm run basic:front   # http://localhost:5280
```

Para un módulo en capas (`routes → controller → service`), como en una app
real, mira [`playground/backend/src/modules/cases/`](../../playground/backend/src/modules/cases/).
