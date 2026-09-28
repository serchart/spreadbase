<!--
@component
Ejemplo Postgres: catálogo de productos servido por el backend JS estilo Aggy.
Backend: examples/backend/src/examples/postgres/
-->
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	import { API_URL } from '$lib/config';

	const sheet = new Sheet(`${API_URL}/api/postgres/products/sheet`);
</script>

<div data-fill class="flex min-h-0 flex-1 flex-col gap-2 p-6">
	<header>
		<h1 class="text-lg font-semibold tracking-tight">Postgres · catálogo de productos</h1>
		<p class="text-base-content/70 text-xs">
			Cambiar un precio deja historial; un producto sin existencias no se puede activar; eliminar es
			borrado lógico. Todo en una transacción por guardado. Necesita <code>DATABASE_URL</code> y
			<code>npm run postgres:setup</code>.
		</p>
	</header>
	<div class="bg-base-100 border-base-300 rounded-box min-h-0 flex-1 border p-3">
		<SpreadBase {sheet} fill />
	</div>
</div>
