import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

/** Pool a la base de pruebas. Cada archivo lo cierra en `afterAll`. */
export const createPool = () => new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
