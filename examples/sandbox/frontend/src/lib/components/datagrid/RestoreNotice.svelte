<!--
	RestoreNotice — aviso de que se recuperó un borrador local.

	Es un toast y no un banner: informa de algo que ya ocurrió y no exige
	decisión, así que no debe empujar la hoja hacia abajo ni quedarse ocupando
	espacio. Se oculta solo; descartar el borrador sigue a un clic mientras está
	visible y, después, en la toolbar.
-->
<script lang="ts">
	import Info from '@lucide/svelte/icons/info';
	import X from '@lucide/svelte/icons/x';
	import { panel } from '$lib/motion';

	interface Props {
		/** Se muestra mientras sea `true` y hasta que venza el plazo o se cierre. */
		active: boolean;
		ondiscard: () => void;
	}

	let { active, ondiscard }: Props = $props();

	const DURATION = 8000;

	let open = $state(false);

	$effect(() => {
		if (!active) {
			open = false;
			return;
		}
		open = true;
		const timer = setTimeout(() => (open = false), DURATION);
		return () => clearTimeout(timer);
	});
</script>

{#if open}
	<div class="toast toast-end toast-bottom z-40" transition:panel={{ x: 0, y: 16 }}>
		<div role="status" class="alert max-w-sm items-start border-base-300 text-sm shadow-lg">
			<Info size={18} class="mt-0.5 shrink-0 text-info" aria-hidden="true" />
			<div class="flex flex-col gap-1">
				<span class="font-semibold">Recuperamos tus cambios sin guardar</span>
				<span class="text-base-content/70">
					Vienen de tu sesión anterior. Puedes continuar o
					<button type="button" class="link link-hover font-medium text-base-content" onclick={ondiscard}>
						descartarlos</button
					>.
				</span>
			</div>
			<button
				type="button"
				class="btn btn-square btn-ghost btn-xs"
				aria-label="Cerrar aviso"
				onclick={() => (open = false)}
			>
				<X size={14} aria-hidden="true" />
			</button>
		</div>
	</div>
{/if}
