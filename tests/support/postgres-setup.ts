import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Las pruebas de `postgres/` exigen una base encendida en `DATABASE_URL`
 * (se lee de `../.env` si no está en el entorno). Si no responde, se falla de
 * inmediato con la instrucción.
 */
export default async function setup() {
	const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
	if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
	const url = process.env.DATABASE_URL;
	const help =
		'\n  Define DATABASE_URL (en SpreadBase/.env) apuntando a un Postgres de pruebas. En local:\n' +
		'    docker run -d --name dev-pg -e POSTGRES_PASSWORD=spreadbase -e POSTGRES_DB=spreadbase -p 5433:5432 postgres:16-alpine\n' +
		'    DATABASE_URL=postgres://postgres:spreadbase@localhost:5433/spreadbase\n';
	if (!url) throw new Error(`\n\n  Falta DATABASE_URL.${help}`);
	const pool = new pg.Pool({ connectionString: url });
	try {
		await pool.query('SELECT 1');
	} catch (err) {
		throw new Error(`\n\n  No hay Postgres en ${url.replace(/:[^:@/]+@/, ':***@')}: ${(err as Error).message}${help}`);
	} finally {
		await pool.end();
	}
}
