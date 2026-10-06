import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** Para `svelte-package`: el TypeScript de los componentes se compila al publicar. */
export default { preprocess: vitePreprocess() };
