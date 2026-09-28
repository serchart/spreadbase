import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

/**
 * Pruebas de código puro del frontend (doc 09 §5, la excepción): importan el
 * código —con runes de Svelte, por eso el plugin— y no tocan navegador ni API.
 * La norma sigue siendo E2E en ../tests.
 */
export default defineConfig({
	plugins: [
		svelte({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
		})
	],
	resolve: {
		alias: { $lib: new URL('./src/lib', import.meta.url).pathname }
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
