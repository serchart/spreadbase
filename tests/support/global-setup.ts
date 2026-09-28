import { API_URL, DEMO_URL } from './env.ts';

/**
 * Las pruebas exigen el backend de la demo encendido (`apps/demo`). No es el
 * sistema real: es la app de referencia de la librería, con su semilla.
 */
export default async function setup() {
	const fail = (why: string) => {
		throw new Error(`\n\n  ${why}\n  Arranca la demo en otra terminal:  npm run demo\n  (o apunta a otra con TEST_API_URL)\n`);
	};
	try {
		const health = await fetch(`${API_URL}/api/health`);
		if (!health.ok) fail(`La demo en ${API_URL} respondió ${health.status} en /api/health.`);
		const catalogs = await fetch(`${DEMO_URL}/catalogs`);
		if (!catalogs.ok) fail(`La demo en ${DEMO_URL} no expone el sheet (/catalogs).`);
	} catch (err) {
		if (err instanceof Error && err.message.includes('npm run demo')) throw err;
		fail(`No hay demo escuchando en ${API_URL}.`);
	}
}
