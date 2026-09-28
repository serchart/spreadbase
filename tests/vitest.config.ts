import { defineConfig } from 'vitest/config';

/**
 * E2E de caja negra, por módulo (docs/09-estrategia-pruebas.md).
 *
 * - Un test puede llamar a la API y manejar el navegador.
 * - En serie: las pruebas comparten la base de datos del entorno de test y
 *   la reinician.
 * - Las pruebas de código puro no van aquí: viven junto al código, en
 *   frontend/src.
 */
export default defineConfig({
	test: {
		include: ['**/*.test.ts'],
		exclude: ['node_modules/**', 'dist/**'],
		globalSetup: ['support/global-setup.ts'],
		fileParallelism: false,
		testTimeout: 60_000
	}
});
