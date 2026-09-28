<!--
@component
Modal sobre el elemento nativo `<dialog>`.

Se apoya en `showModal()` para heredar gratis el comportamiento correcto:
foco atrapado dentro del diálogo, cierre con Escape, backdrop inerte y
anuncio a lectores de pantalla. Reimplementar eso a mano casi siempre sale mal.

Uso:
  <Modal open={x !== null} title="Algo pasó" tone="error" onclose={() => (x = null)}>
    contenido
    {#snippet footer()}<button class="btn btn-sm btn-primary">Entendido</button>{/snippet}
  </Modal>

Nota de mantenimiento: este componente nació antes del sistema de temas y tenía
colores literales (#fff, #2563eb) y la fuente del sistema. En un tema oscuro se
veía como un recorte blanco. Ahora usa solo tokens, así que cambia con el tema
igual que el resto del producto.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		title: string;
		/** Define el acento cromático y el icono. */
		tone?: 'info' | 'error' | 'success' | 'warning';
		subtitle?: string;
		onclose: () => void;
		children: Snippet;
		footer?: Snippet;
	}

	let { open, title, tone = 'info', subtitle = '', onclose, children, footer }: Props = $props();

	let dialogEl = $state<HTMLDialogElement | null>(null);

	const icons = { info: 'ℹ', error: '✕', success: '✓', warning: '!' } as const;

	/* Acento del icono por tono, con tokens y no con hex. */
	const iconTone = {
		info: 'bg-info text-info-content',
		error: 'bg-error text-error-content',
		success: 'bg-success text-success-content',
		warning: 'bg-warning text-warning-content'
	} as const;

	$effect(() => {
		if (!dialogEl) return;
		if (open && !dialogEl.open) dialogEl.showModal();
		else if (!open && dialogEl.open) dialogEl.close();
	});

	/** Cierra al hacer clic en el backdrop, no en el panel. */
	function handleBackdrop(event: MouseEvent) {
		if (event.target === dialogEl) onclose();
	}
</script>

<dialog
	bind:this={dialogEl}
	class="oc-modal"
	onclick={handleBackdrop}
	oncancel={(e) => {
		e.preventDefault();
		onclose();
	}}
>
	<div class="oc-panel bg-base-100 border-base-300 rounded-box overflow-hidden border shadow-2xl">
		<header class="flex items-start gap-3 px-5 pt-5 pb-3">
			<span
				class="grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold
				       {iconTone[tone]}"
				aria-hidden="true"
			>
				{icons[tone]}
			</span>

			<div class="min-w-0 flex-1">
				<h2 class="text-base font-semibold">{title}</h2>
				{#if subtitle}
					<p class="text-base-content/55 mt-1 text-sm">{subtitle}</p>
				{/if}
			</div>

			<button
				type="button"
				class="btn btn-ghost btn-xs btn-square"
				onclick={onclose}
				aria-label="Cerrar"
			>
				×
			</button>
		</header>

		<div class="oc-body px-5 pb-5 text-sm">
			{@render children()}
		</div>

		{#if footer}
			<footer
				class="bg-base-200 border-base-300 flex justify-end gap-2 border-t px-5 py-3"
			>
				{@render footer()}
			</footer>
		{/if}
	</div>
</dialog>


<style>
	/*
		El `<dialog>` solo centra y limita el ancho; el aspecto lo pone el panel de
		dentro con clases de daisyUI. Así el modal hereda el tema sin que este
		bloque conozca un solo color.
	*/
	.oc-modal {
		border: none;
		padding: 0;
		background: transparent;
		width: 100%;
		max-width: min(560px, calc(100vw - 2rem));
		color: var(--color-base-content);
		font-family: var(--font-sans);
		/*
			El navegador centra un `dialog:modal` con `margin: auto` desde su hoja de
			estilos, pero el preflight de Tailwind v4 aplica `margin: 0` al selector
			universal —que incluye `::backdrop`— y lo anula. Sin esta línea el modal
			se pega a la esquina superior izquierda.
		*/
		margin: auto;
	}

	.oc-modal::backdrop {
		/* `color-mix` sobre un token, no un rgba fijo: en «Medianoche» el velo
		   debe ser más profundo que en «Papel». */
		background: color-mix(in oklch, var(--color-neutral) 55%, transparent);
		backdrop-filter: blur(2px);
	}

	.oc-modal[open] .oc-panel {
		animation: oc-pop var(--oc-t-base) var(--oc-ease);
	}

	@keyframes oc-pop {
		from {
			opacity: 0;
			transform: translateY(-6px) scale(0.98);
		}
	}

	/* El cuerpo scrollea, no el diálogo: el encabezado y el pie quedan fijos. */
	.oc-body {
		max-height: min(52vh, 420px);
		overflow-y: auto;
	}
</style>
