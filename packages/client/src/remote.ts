/**
 * Cliente HTTP del protocolo de SpreadBase: habla con las cinco rutas que
 * monta `@spreadbase/server` bajo una URL base.
 */
import type { LookupResult, ResolveResult, SheetSchema } from '@spreadbase/core';
import type { BatchRequest, BatchResponse, PageRequest, PageResult } from './types';

/** Error de la API con el `code` estable del servidor (`{ error: { code, message, details } }`). */
export class SpreadBaseApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown
	) {
		super(message);
	}
}

export interface RemoteOptions {
	/** Cabeceras extra en cada petición, p. ej. `Authorization`. */
	headers?: () => Record<string, string>;
	fetch?: typeof fetch;
}

export function remoteClient(base: string, options: RemoteOptions = {}) {
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

	async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
		let res: Response;
		try {
			res = await doFetch(base + path, {
				...init,
				headers: { 'content-type': 'application/json', ...options.headers?.(), ...init.headers }
			});
		} catch (err) {
			if (init.signal?.aborted) throw err;
			// Sin red o servidor apagado: `fetch` lanza TypeError sin más detalle.
			throw new SpreadBaseApiError(0, 'network_error', `No se pudo conectar con ${base}`);
		}
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			const error = body?.error ?? {};
			throw new SpreadBaseApiError(res.status, error.code ?? 'http_error', error.message ?? `HTTP ${res.status}`, error.details);
		}
		return body as T;
	}

	return {
		schema: () => request<SheetSchema>('/schema'),

		loadPage: ({ offset, limit }: PageRequest, signal: AbortSignal) =>
			request<PageResult>(`?${new URLSearchParams({ offset: String(offset), limit: String(limit) })}`, { signal }),

		/** Posición global actual de una fila; `null` si la consulta la excluye. */
		locate: async (id: unknown, signal: AbortSignal) =>
			(await request<{ position: number | null }>(`/${encodeURIComponent(String(id))}/position`, { signal })).position,

		/** Un tramo del recurso de una columna `lookup` (SB-21). */
		lookup: (field: string, q: string, { offset, limit }: { offset: number; limit: number }, signal?: AbortSignal) =>
			request<LookupResult>(
				`/lookup/${encodeURIComponent(field)}?${new URLSearchParams({ q, offset: String(offset), limit: String(limit) })}`,
				{ signal }
			),

		/** Texto pegado → filas que coinciden, en una sola petición. */
		resolve: async (field: string, texts: string[]) =>
			(
				await request<ResolveResult>(`/lookup/${encodeURIComponent(field)}/resolve`, {
					method: 'POST',
					body: JSON.stringify({ texts })
				})
			).matches,

		/**
		 * `idempotencyKey` identifica el intento de guardado (G-12): un reintento
		 * con la misma llave recibe la misma respuesta sin aplicarse dos veces.
		 */
		saveBatch: (batch: BatchRequest, idempotencyKey: string) =>
			request<BatchResponse>('/batch', {
				method: 'POST',
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify(batch)
			})
	};
}
