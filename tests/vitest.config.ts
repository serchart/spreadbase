import { defineConfig } from 'vitest/config';

/**
 * E2E de caja negra, por módulo (docs/01-diseno.md §7).
 *
 * - `e2e`: protocolo y navegador contra los ejemplos encendidos (la hoja de casos). Un test puede
 *   llamar a la API y manejar el navegador.
 * - `postgres`: las fuentes de datos contra una base real (`DATABASE_URL`). No
 *   necesitan los ejemplos encendidos.
 * - En serie: las pruebas comparten la base del entorno de test y la reinician.
 */
export default defineConfig({
	test: {
		exclude: ['node_modules/**', 'dist/**'],
		fileParallelism: false,
		testTimeout: 60_000,
		projects: [
			{
				extends: true,
				test: {
					name: 'e2e',
					include: ['protocol/**/*.test.ts', 'grid/**/*.test.ts'],
					globalSetup: ['support/global-setup.ts']
				}
			},
			{
				extends: true,
				test: {
					name: 'postgres',
					include: ['postgres/**/*.test.ts'],
					globalSetup: ['support/postgres-setup.ts']
				}
			}
		]
	}
});
