/**
 * Configuración leída del entorno, validada una sola vez al arrancar.
 *
 * Se cargan, si existen, `examples/backend/.env` y `SpreadBase/.env` (el de la
 * raíz guarda DATABASE_URL y las llaves). Un valor ya definido no se pisa.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const file of ['../../.env', '../../../../.env']) {
	const path = fileURLToPath(new URL(file, import.meta.url));
	if (existsSync(path)) process.loadEnvFile(path);
}

function intFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} debe ser un entero no negativo; se recibió "${raw}"`);
	}
	return value;
}

function policyFromEnv(name: string): 'merge' | 'strict' {
	const raw = process.env[name] ?? 'merge';
	if (raw !== 'merge' && raw !== 'strict') {
		throw new Error(`${name} debe ser "merge" o "strict"; se recibió "${raw}"`);
	}
	return raw;
}

export const env = {
	port: intFromEnv('PORT', 4100),
	corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5180')
		.split(',')
		.map((o) => o.trim())
		.filter(Boolean),
	/** `test` habilita las rutas destructivas del ejemplo de casos (reset, mutate). Por defecto, test. */
	appEnv: process.env.APP_ENV ?? 'test',
	/** Postgres del ejemplo `postgres`. Sin ella, ese ejemplo responde 503 y el resto funciona. */
	databaseUrl: process.env.DATABASE_URL ?? '',
	cases: {
		/** Latencia simulada solo en el ejemplo de casos: ahí se prueba la red real. */
		latencyMs: intFromEnv('LATENCY_MS', 150),
		rows: intFromEnv('CASES_ROWS', 50_000),
		policy: policyFromEnv('CASES_POLICY')
	}
} as const;
