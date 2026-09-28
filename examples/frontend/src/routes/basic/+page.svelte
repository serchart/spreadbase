<!--
@component
Ejemplo básico: la página no define columnas; las pide al servidor.
Backend: examples/backend/src/examples/basic/
-->
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	import { API_URL } from '$lib/config';

	const sheet = new Sheet(`${API_URL}/api/basic/contacts`);
</script>

<div data-fill class="flex min-h-0 flex-1 flex-col gap-2 p-6">
	<header>
		<h1 class="text-lg font-semibold tracking-tight">Básico · contactos</h1>
		<p class="text-base-content/70 text-xs">
			1 000 contactos en memoria. El correo se valida con un patrón que define el servidor.
		</p>
	</header>
	<div class="bg-base-100 border-base-300 rounded-box min-h-0 flex-1 border p-3">
		<SpreadBase {sheet} fill />
	</div>
</div>
