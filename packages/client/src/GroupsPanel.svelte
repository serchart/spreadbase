<!--
	GroupsPanel — grupos de la hoja. Marcador: el contenido real llega después.

	Un grupo es una carpeta virtual, un tipo especial de filtro: se agrupa por
	una columna (p. ej. «Atiende») y cada valor es una carpeta con su número de
	filas. Al elegir una, la hoja muestra solo esas filas.
-->
<script lang="ts">
	import FolderTree from '@lucide/svelte/icons/folder-tree';
	import SidePanel from './SidePanel.svelte';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();
</script>

<SidePanel title="Grupos" subtitle="Carpetas virtuales para organizar la hoja" {onclose}>
	<div class="flex flex-col items-center gap-2 px-6 py-12 text-center">
		<FolderTree size={24} class="text-base-content/50" aria-hidden="true" />
		<p class="font-semibold">Grupos próximamente</p>
		<p class="text-xs text-base-content/70">
			Agrupa las filas por una columna —por ejemplo, por asesor asignado— y verás cada valor como
			una carpeta con su número de casos. Al elegir una, la hoja mostrará solo esas filas.
		</p>
	</div>
</SidePanel>
