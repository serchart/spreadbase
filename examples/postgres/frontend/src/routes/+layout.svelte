<script lang="ts">
	import '../app.css';
	// Tema de la hoja a partir de los colores del tema de daisyUI.
	import '@spreadbase/client/theme-daisyui.css';

	let { children } = $props();
</script>

{@render children()}
