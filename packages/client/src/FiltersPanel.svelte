<!--
	FiltersPanel — filtros de la hoja. Marcador: el contenido real llega después.
-->
<script lang="ts">
	import ListFilter from '@lucide/svelte/icons/list-filter';
	import SidePanel from './SidePanel.svelte';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();
</script>

<SidePanel title="Filtros" subtitle="Acota las filas visibles de la hoja" {onclose}>
	<div class="flex flex-col items-center gap-2 px-6 py-12 text-center">
		<ListFilter size={24} class="text-base-content/50" aria-hidden="true" />
		<p class="font-semibold">Filtros próximamente</p>
		<p class="text-xs text-base-content/70">
			Aquí se podrán combinar condiciones por columna para acotar la hoja.
		</p>
	</div>
</SidePanel>
