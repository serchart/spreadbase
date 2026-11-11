import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (!process.env.MONGO_URL && existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * Las pruebas de `mongo/` corren contra un MongoDB en `MONGO_URL` (se lee de
 * `../.env`). Las transacciones exigen un replica set; en local, uno de un nodo:
 *
 *     docker run -d --name sb-mongo -p 27019:27017 mongo:7 --replSet rs0
 *     docker exec sb-mongo mongosh --eval "rs.initiate()"
 *     MONGO_URL=mongodb://localhost:27019/?directConnection=true
 *
 * Si no responde, la suite se omite (no falla).
 */
export const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27019/?directConnection=true';

/** Un cliente conectado, o `null` si no hay Mongo (la suite se omite). Cada archivo lo cierra en `afterAll`. */
export async function connectMongo(): Promise<MongoClient | null> {
	const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 1500 });
	try {
		await client.connect();
		await client.db('admin').command({ ping: 1 });
		return client;
	} catch {
		await client.close().catch(() => undefined);
		console.warn(`\n  mongo/: no hay MongoDB en ${MONGO_URL}; se omite la suite.\n`);
		return null;
	}
}
