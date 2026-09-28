import type { RequestHandler } from 'express';

/**
 * Retrasa la respuesta para simular red real.
 *
 * La variación de ±40 % es deliberada: con una latencia fija, dos peticiones
 * lanzadas en orden siempre llegan en orden, y el caso que hay que probar es
 * justo el contrario —el usuario baja rápido, pide dos páginas y la segunda
 * llega antes que la primera—.
 *
 * `x-sandbox-latency: <ms>` la sustituye en una petición concreta. Sirve para
 * medir el servidor sin el retraso artificial.
 */
export function simulatedLatency(baseMs: number): RequestHandler {
	return (req, _res, next) => {
		const header = req.header('x-sandbox-latency');
		const override = header === undefined ? NaN : Number(header);
		const base = Number.isFinite(override) && override >= 0 ? override : baseMs;
		if (base === 0) return next();
		const jitter = base * 0.4 * (Math.random() * 2 - 1);
		setTimeout(next, Math.max(0, Math.round(base + jitter)));
	};
}
