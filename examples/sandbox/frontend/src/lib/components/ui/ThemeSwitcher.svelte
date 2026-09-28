<!--
@component
Selector de tema.

Dos presentaciones sobre el mismo store:
- `variant="menu"` (por defecto): dropdown compacto para el topbar.
- `variant="grid"`: tarjetas con muestra grande, para la página de tokens.

La muestra se pinta con los colores declarados en `$lib/themes`, no aplicando
el tema: hay que poder comparar los cuatro sin cambiar de tema.
-->
<script lang="ts">
	import { Check, Palette } from '@lucide/svelte';
	import { THEMES } from '$lib/themes';
	import { theme } from '$lib/stores/theme.svelte';

	interface Props {
		variant?: 'menu' | 'grid';
	}

	let { variant = 'menu' }: Props = $props();
</script>

{#if variant === 'grid'}
	<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
		{#each THEMES as t (t.id)}
			{@const active = theme.id === t.id}
			<button
				type="button"
				onclick={() => theme.set(t.id)}
				aria-pressed={active}
				class="rounded-box group relative overflow-hidden border-2 text-left transition
				       {active
					? 'border-primary ring-primary/25 ring-2'
					: 'border-base-300 hover:border-base-content/30'}"
			>
				<!-- Maqueta en miniatura: fondo, tarjeta, primario y acento -->
				<div class="flex h-20 items-stretch gap-1 p-2" style="background: {t.swatch[0]}">
					<div
						class="flex-1 rounded-md p-1.5 shadow-sm"
						style="background: {t.swatch[1]}"
					>
						<div class="h-1.5 w-8 rounded-full" style="background: {t.swatch[2]}"></div>
						<div
							class="mt-1 h-1 w-12 rounded-full opacity-40"
							style="background: {t.swatch[3]}"
						></div>
						<div
							class="mt-2 h-1 w-full rounded-full opacity-15"
							style="background: {t.swatch[2]}"
						></div>
						<div
							class="mt-1 h-1 w-3/4 rounded-full opacity-15"
							style="background: {t.swatch[2]}"
						></div>
					</div>
					<div class="flex w-4 flex-col gap-1">
						<div class="h-4 rounded" style="background: {t.swatch[2]}"></div>
						<div class="h-3 rounded" style="background: {t.swatch[3]}"></div>
					</div>
				</div>

				<div class="bg-base-100 border-base-300 border-t p-2.5">
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm font-semibold">{t.label}</span>
						{#if active}
							<Check size={14} class="text-primary shrink-0" />
						{/if}
					</div>
					<p class="text-base-content/60 mt-0.5 text-xs leading-snug">{t.hint}</p>
				</div>
			</button>
		{/each}
	</div>
{:else}
	<div class="dropdown dropdown-end">
		<div tabindex="0" role="button" class="btn btn-ghost btn-sm gap-1.5">
			<Palette size={15} />
			<span class="hidden sm:inline">{theme.def.label}</span>
		</div>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<ul
			tabindex="0"
			class="dropdown-content menu bg-base-100 rounded-box border-base-300 z-50 mt-1 w-60 border p-1.5 shadow-lg"
		>
			{#each THEMES as t (t.id)}
				<li>
					<button type="button" onclick={() => theme.set(t.id)} class="gap-2.5">
						<span class="flex shrink-0 gap-0.5">
							{#each t.swatch as color}
								<span
									class="border-base-content/10 h-4 w-2 rounded-[2px] border"
									style="background: {color}"
								></span>
							{/each}
						</span>
						<span class="flex-1 text-sm">{t.label}</span>
						{#if theme.id === t.id}
							<Check size={14} class="text-primary" />
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}
