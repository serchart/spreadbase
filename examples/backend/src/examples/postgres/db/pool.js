import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// DATABASE_URL: del entorno, de examples/backend/.env o de SpreadBase/.env.
// (El servidor ya los cargó; esto es para correr `db/setup.js` suelto.)
for (const file of ['../../../../.env', '../../../../../../.env']) {
	const path = fileURLToPath(new URL(file, import.meta.url));
	if (!process.env.DATABASE_URL && existsSync(path)) process.loadEnvFile(path);
}

if (!process.env.DATABASE_URL) {
	throw new Error('Falta DATABASE_URL: ponla en SpreadBase/.env o en examples/backend/.env');
}

/** El pool de la app. SpreadBase no abre conexiones propias: usa este. */
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
