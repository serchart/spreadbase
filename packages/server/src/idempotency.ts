import type { RequestHandler } from 'express';
import { HttpError } from './errors.ts';

/**
 * Idempotencia por cabecera `Idempotency-Key` (decisión G-12).
 *
 * La primera petición con una llave se ejecuta y su respuesta se guarda. Las
 * siguientes con la misma llave reciben esa respuesta sin volver a ejecutarse:
 * un doble clic en Guardar o un reintento tras un corte de red no duplica
 * altas. Reusar la llave con otro cuerpo es un error del cliente (422).
 *
 * Sin cabecera, la petición pasa tal cual. En memoria: suficiente para el
 * sandbox; en producción iría a la base de datos con el mismo contrato.
 */
export function idempotent(ttlMs = 24 * 60 * 60 * 1000): RequestHandler {
	const saved = new Map<string, { expires: number; body: string; status: number; response: unknown }>();

	return (req, res, next) => {
		const key = req.header('idempotency-key');
		if (!key) return next();
		if (key.length > 200) {
			throw new HttpError(400, 'invalid_idempotency_key', 'Idempotency-Key admite hasta 200 caracteres');
		}

		const now = Date.now();
		for (const [k, v] of saved) if (v.expires < now) saved.delete(k);

		const id = `${req.method} ${req.originalUrl} ${key}`;
		const body = JSON.stringify(req.body ?? null);
		const hit = saved.get(id);
		if (hit) {
			if (hit.body !== body) {
				throw new HttpError(422, 'idempotency_key_reused', 'Esta Idempotency-Key ya se usó con otro cuerpo');
			}
			console.log(`[idempotency] ${key.slice(0, 8)} repetida: se devuelve la respuesta guardada sin aplicar de nuevo`);
			res.setHeader('Idempotent-Replayed', 'true');
			res.status(hit.status).json(hit.response);
			return;
		}

		// Se guarda la respuesta al enviarla. Un 5xx no: el cliente debe poder reintentar.
		const json = res.json.bind(res);
		res.json = (response: unknown) => {
			if (res.statusCode < 500) saved.set(id, { expires: now + ttlMs, body, status: res.statusCode, response });
			return json(response);
		};
		next();
	};
}
