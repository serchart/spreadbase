/**
 * Cliente HTTP mínimo hacia el backend (`backend/`).
 *
 * La URL base sale de `PUBLIC_API_URL` (ver `.env.example`) y cae a
 * `http://localhost:4100`, el puerto por defecto del backend en desarrollo.
 */
import { env } from '$env/dynamic/public';

export const API_URL = (env.PUBLIC_API_URL || 'http://localhost:4100').replace(/\/$/, '');

/** Error de la API con el `code` estable del backend (`{ error: { code, message, details } }`). */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown
	) {
		super(message);
	}
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	let res: Response;
	try {
		res = await fetch(API_URL + path, {
			...init,
			headers: { 'content-type': 'application/json', ...init.headers }
		});
	} catch (err) {
		if (init.signal?.aborted) throw err;
		// Sin red o backend apagado: `fetch` lanza TypeError sin más detalle.
		throw new ApiError(0, 'network_error', `No se pudo conectar con el backend en ${API_URL}`);
	}
	const body = await res.json().catch(() => null);
	if (!res.ok) {
		const error = body?.error ?? {};
		throw new ApiError(res.status, error.code ?? 'http_error', error.message ?? `HTTP ${res.status}`, error.details);
	}
	return body as T;
}
