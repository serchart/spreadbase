/**
 * Configuración leída del entorno, validada una sola vez al arrancar.
 *
 * Un valor inválido detiene el proceso con un mensaje claro: es preferible a
 * descubrirlo en la primera petición, con un `NaN` propagándose por el código.
 */

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
	/** `test` habilita las rutas destructivas (reset, mutate). El playground arranca en test. */
	appEnv: process.env.APP_ENV ?? 'test',
	latencyMs: intFromEnv('LATENCY_MS', 150),
	cases: {
		rows: intFromEnv('CASES_ROWS', 50_000),
		policy: policyFromEnv('CASES_POLICY')
	}
} as const;
