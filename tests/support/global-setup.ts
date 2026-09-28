import { API_URL, FRONT_URL } from './env.ts';

/**
 * Las pruebas exigen backend y frontend encendidos, en modo test. Si no
 * responden, se falla de inmediato con la instrucción, en lugar de decenas de
 * timeouts (doc 09 §3).
 */
export default async function setup() {
	const fail = (why: string) => {
		throw new Error(`\n\n  ${why}\n  Arranca los ejemplos en modo test, cada uno en su terminal (desde la raíz):\n    npm run back\n    npm run front\n  (o apunta a otros con TEST_API_URL / TEST_FRONT_URL)\n`);
	};
	const check = async (url: string) => {
		const res = await fetch(url);
		if (!res.ok) fail(`${url} respondió ${res.status}.`);
	};
	try {
		await check(`${API_URL}/api/health`);
		await check(FRONT_URL);
	} catch (err) {
		if (err instanceof Error && err.message.includes('Arranca los servicios')) throw err;
		fail('No hay servicios escuchando.');
	}
	// La hoja de casos de los ejemplos es la «base de datos de pruebas».
	try {
		await check(`${API_URL}/api/cases/schema`);
	} catch {
		fail(`${API_URL} no expone la hoja de casos (/api/cases).`);
	}
	const health = await (await fetch(`${API_URL}/api/health`)).json();
	if (health.env !== 'test') fail(`${API_URL} no está en modo test (APP_ENV=${health.env}): las pruebas lo reinician.`);
}
