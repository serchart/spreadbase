# Ejemplo básico

Una hoja de contactos (1 000 filas en memoria) con lo mínimo en cada lado.

**Backend** — [`index.ts`](index.ts): define la hoja (columnas, reglas y fuente
de datos) y la monta con `sheetRouter`. El servidor común la sirve en
`/api/basic/contacts`.

```ts
const contacts = new SpreadBase({ id: 'contacts', columns: { … }, source: memorySource({ rows }) });
router.use('/contacts', sheetRouter(contacts));
```

**Frontend** — [`examples/frontend/src/routes/basic/+page.svelte`](../../../../frontend/src/routes/basic/+page.svelte):
se conecta a esa URL. Las columnas llegan del servidor.

```svelte
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	const sheet = new Sheet(`${API_URL}/api/basic/contacts`);
</script>

<SpreadBase {sheet} fill />
```

Con eso ya hay: carga por tramos, edición, altas y bajas, deshacer y rehacer,
borrador que sobrevive a recargar y guardado que detecta choques entre usuarios.

Se ve en http://localhost:5180/basic con `npm run back` y `npm run front` (ver
[`examples/README.md`](../../../../README.md)).
