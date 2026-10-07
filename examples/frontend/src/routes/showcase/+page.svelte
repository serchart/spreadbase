<!--
@component
La vitrina: la hoja de las capturas del README. La página no define columnas;
las pide al servidor. Backend: examples/backend/src/examples/showcase/
-->
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	import { API_URL } from '$lib/config';

	// El avatar y el nombre quedan fijos al desplazar a la derecha.
	const sheet = new Sheet(`${API_URL}/api/showcase/customers`, { frozenColumns: 2 });
</script>

<div data-fill class="flex min-h-0 flex-1 flex-col gap-2 p-6">
	<header>
		<h1 class="text-lg font-semibold tracking-tight">Customers</h1>
		<p class="text-base-content/70 text-xs">10,000 rows in memory · every column type · edit, filter, sort, undo and save in batch.</p>
	</header>
	<div class="bg-base-100 border-base-300 rounded-box min-h-0 flex-1 border p-3">
		<SpreadBase {sheet} fill />
	</div>
</div>
