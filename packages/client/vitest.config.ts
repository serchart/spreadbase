import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

/**
 * Pruebas de código puro del cliente: importan el controlador —con runes de
 * Svelte, por eso el plugin— y no tocan navegador ni API. La norma sigue
 * siendo E2E en ../../tests.
 */
export default defineConfig({
	plugins: [svelte({ compilerOptions: { runes: true } })],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
