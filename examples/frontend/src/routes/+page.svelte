<!--
@component
Índice de ejemplos. Todos se sirven desde un solo backend (`npm run back`) y
este único frontend (`npm run front`).
-->
<script lang="ts">
	import { EXAMPLES } from '$lib/examples';
</script>

<div class="mx-auto flex w-full max-w-4xl flex-col gap-6">
	<header>
		<h1 class="text-2xl font-semibold tracking-tight">Ejemplos de SpreadBase</h1>
		<p class="text-base-content/70 mt-1">
			Tu base de datos como una hoja de cálculo. Cada ejemplo tiene su carpeta en el backend
			común y su página aquí.
		</p>
	</header>

	<ul class="grid gap-4 sm:grid-cols-2">
		{#each EXAMPLES as example (example.href)}
			<li>
				<a
					href={example.href}
					class="card bg-base-100 border-base-300 hover:border-primary h-full border transition-colors"
				>
					<div class="card-body gap-2">
						<h2 class="card-title">{example.title}</h2>
						<span class="badge badge-soft badge-sm">{example.tag}</span>
						<p class="text-base-content/80 text-sm">{example.text}</p>
						<code class="text-base-content/60 mt-auto text-xs">{example.code}</code>
					</div>
				</a>
			</li>
		{/each}
	</ul>
</div>
