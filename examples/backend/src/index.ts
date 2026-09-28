import { createApp } from './app.ts';
import { env } from './config/env.ts';

const started = performance.now();
const app = await createApp();

app.listen(env.port, () => {
	const base = `http://localhost:${env.port}/api`;
	console.log(
		[
			`Ejemplos de SpreadBase en http://localhost:${env.port} · ${env.appEnv} · listo en ${Math.round(performance.now() - started)} ms`,
			`  básico    ${base}/basic/contacts`,
			`  casos     ${base}/cases   (${env.cases.rows} filas, ${env.cases.policy}, latencia ${env.cases.latencyMs} ms)`,
			`  postgres  ${base}/postgres/products/sheet   ${env.databaseUrl ? '' : '(sin DATABASE_URL: responde 503)'}`
		].join('\n')
	);
});
