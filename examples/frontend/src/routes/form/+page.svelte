<!--
@component
Ejemplo de formulario (SB-25): «Nuevo producto» con las columnas de la hoja de
productos del ejemplo de Postgres. Cada `<Field>` usa el mismo tipo de celda
que la hoja: el calendario, la lista de «Estado», la mini tabla de
«Responsable» y sus reglas. Crear manda el alta por el protocolo de la hoja
(`POST /batch`), y el servidor vuelve a validar.
Backend: examples/backend/src/examples/postgres/
-->
<script lang="ts">
	import { Field, FormState, Sheet } from '@spreadbase/client';
	import { API_URL } from '$lib/config';

	const url = `${API_URL}/api/postgres/products/sheet`;

	const initial = {
		name: '',
		sku: '',
		owner_id: null,
		status: 'draft',
		price: null,
		stock: 0,
		launch_date: null,
		restocked_at: null,
		image_url: null
	};
	// «Responsable» es obligatorio en la hoja; aquí además se exige «Lanzamiento».
	let form = $state(new FormState(new Sheet(url), initial, { columns: { launch_date: { required: true } } }));

	let saving = $state(false);
	let result = $state<{ ok: true; id: string } | { ok: false; message: string } | null>(null);

	async function create() {
		form.touchAll();
		if (!form.valid) return;
		saving = true;
		result = null;
		try {
			const res = await fetch(`${url}/batch`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ creates: [{ key: 'form', values: form.values }] })
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body?.error?.details?.[0]?.message ?? body?.error?.message ?? `HTTP ${res.status}`);
			result = { ok: true, id: String(body.created[0].row.id) };
			form = new FormState(new Sheet(url), initial, { columns: { launch_date: { required: true } } });
		} catch (err) {
			result = { ok: false, message: err instanceof Error ? err.message : String(err) };
		} finally {
			saving = false;
		}
	}
</script>

<div class="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
	<header>
		<h1 class="text-lg font-semibold tracking-tight">Formulario · nuevo producto</h1>
		<p class="text-base-content/70 text-xs">
			Los campos son las columnas de la hoja de productos, con sus mismos editores y reglas: el calendario, la lista y la
			mini tabla de «Responsable». Necesita <code>DATABASE_URL</code> y <code>npm run postgres:setup</code>.
		</p>
	</header>

	{#if form.loadError}
		<div role="alert" class="alert alert-error alert-soft"><span>No se pudo leer la hoja: {form.loadError}</span></div>
	{:else if !form.ready}
		<span class="loading loading-spinner loading-md opacity-60" aria-label="Cargando"></span>
	{:else}
		<section class="bg-base-100 border-base-300 rounded-box border p-6">
			<div class="grid gap-x-6 sm:grid-cols-2">
				<Field {form} name="name" class="sm:col-span-2" placeholder="Remolque caja seca 53'" />
				<Field {form} name="sku" hint="Mayúsculas, números y guiones" />
				<Field {form} name="status" />
				<Field {form} name="owner_id" class="sm:col-span-2" placeholder="Busca por nombre o correo" />
				<Field {form} name="price" />
				<Field {form} name="stock" />
				<Field {form} name="launch_date" />
				<Field {form} name="restocked_at" />
				<Field {form} name="image_url" class="sm:col-span-2" placeholder="Pega una URL o sube la foto" hint="PNG, JPEG, WebP o GIF; hasta 1 MB" />
			</div>

			{#if result?.ok}
				<div role="status" class="alert alert-success alert-soft mt-4">
					<span>Producto creado: <code>{result.id}</code>. <a class="link" href="/postgres">Verlo en la hoja</a></span>
				</div>
			{:else if result}
				<div role="alert" class="alert alert-error alert-soft mt-4"><span>{result.message}</span></div>
			{/if}

			<div class="mt-6 flex justify-end">
				<button type="button" class="btn btn-primary" disabled={saving} onclick={create}>
					{#if saving}<span class="loading loading-spinner loading-sm"></span>{/if}Crear producto
				</button>
			</div>
		</section>

		<details class="text-xs">
			<summary class="text-base-content/70 cursor-pointer">Valores (lo que viaja al servidor)</summary>
			<pre class="bg-base-200 rounded-box mt-2 p-3">{JSON.stringify(form.values, null, 2)}</pre>
		</details>
	{/if}
</div>
