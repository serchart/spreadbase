import { createApp } from './app.ts';
import { env } from './config/env.ts';

const started = performance.now();
const app = createApp();

app.listen(env.port, () => {
	console.log(
		`API en http://localhost:${env.port} · sandbox: ${env.sandbox.rows} filas, ` +
			`latencia ${env.sandbox.latencyMs} ms · listo en ${Math.round(performance.now() - started)} ms`
	);
});
