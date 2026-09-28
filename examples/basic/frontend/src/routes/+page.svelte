<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';

	// La hoja se conecta a la URL donde el backend la montó. No define columnas:
	// las pide al servidor (GET /api/contacts/schema).
	const sheet = new Sheet('http://localhost:4200/api/contacts');
</script>

<main class="bg-base-200 flex h-dvh flex-col gap-3 p-6">
	<h1 class="text-lg font-semibold">Contactos</h1>
	<div class="bg-base-100 rounded-box min-h-0 flex-1 p-3">
		<SpreadBase {sheet} fill />
	</div>
</main>
