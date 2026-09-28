<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';

	// La hoja del catálogo, servida por el backend JS sobre Postgres.
	// Las columnas llegan del servidor (GET /api/products/sheet/schema).
	const sheet = new Sheet('http://localhost:4300/api/products/sheet');
</script>

<main class="bg-base-200 flex h-dvh flex-col gap-3 p-6">
	<header>
		<h1 class="text-lg font-semibold">Catálogo de productos · Postgres</h1>
		<p class="text-base-content/70 text-sm">
			Cambiar un precio deja historial; un producto sin existencias no se puede activar; eliminar es
			borrado lógico. Todo en una transacción por guardado.
		</p>
	</header>
	<div class="bg-base-100 rounded-box min-h-0 flex-1 p-3">
		<SpreadBase {sheet} fill />
	</div>
</main>
