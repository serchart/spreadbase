/**
 * Cliente HTTP real para las pruebas. Llamadas de verdad al backend encendido:
 * ningún mock (doc 09 §1).
 */
import { API_URL, NO_LATENCY } from './env.ts';

export interface ApiResponse<T = any> {
	status: number;
	headers: Headers;
	body: T;
}

export async function api<T = any>(
	path: string,
	options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<ApiResponse<T>> {
	const res = await fetch(API_URL + path, {
		method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
		headers: { 'content-type': 'application/json', ...NO_LATENCY, ...options.headers },
		body: options.body === undefined ? undefined : JSON.stringify(options.body)
	});
	const text = await res.text();
	return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
