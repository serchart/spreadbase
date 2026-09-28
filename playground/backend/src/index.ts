import { createApp } from './app.ts';
import { env } from './config/env.ts';

const started = performance.now();
const app = createApp();

app.listen(env.port, () => {
	console.log(
		`API en http://localhost:${env.port} · ${env.appEnv} · casos: ${env.cases.rows} filas, ` +
			`política ${env.cases.policy}, latencia ${env.latencyMs} ms · listo en ${Math.round(performance.now() - started)} ms`
	);
});
