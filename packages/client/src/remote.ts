/**
 * Cliente HTTP del protocolo de SpreadBase: habla con las cinco rutas que
 * monta `@spreadbase/server` bajo una URL base.
 */
import type { LookupResult, ResolveResult, SheetSchema, ValuesResult } from '@spreadbase/core';
import type { BatchRequest, BatchResponse, PageRequest, PageResult, QueryState, UploadResult } from './types';

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
	/**
	 * Filtros fijos de la hoja (SB-28): viajan en cada lectura de filas y de
	 * posición (`?customer_id=…`), como los filtros por columna del protocolo.
	 * Para mostrar una parte del recurso —el estado de cuenta de un cliente—
	 * con la misma hoja del servidor. Es una vista, no un permiso: la
	 * autorización sigue siendo del servidor.
	 */
	filters?: Record<string, string | number | boolean | (string | number)[]>;
}

/** `{ customer_id: 'x', status: ['a', 'b'] }` → pares `campo=a,b`, en orden estable. */
export function filterParams(filters: RemoteOptions['filters']): [string, string][] {
	return Object.entries(filters ?? {})
		.filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([field, v]) => [field, Array.isArray(v) ? v.join(',') : String(v)]);
}

/** Orden y filtros de la persona (SB-33) → `sort=campo:dir` y `where=[…]`. */
export function queryParams(state: QueryState = {}): Record<string, string> {
	const params: Record<string, string> = {};
	if (state.sort) params.sort = `${state.sort.field}:${state.sort.dir}`;
	if (state.where?.length) params.where = JSON.stringify(state.where);
	return params;
}

export function remoteClient(base: string, options: RemoteOptions = {}) {
	const fixed = filterParams(options.filters);
	const query = (params: Record<string, string>) => new URLSearchParams([...Object.entries(params), ...fixed]).toString();
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

		loadPage: ({ offset, limit, sort, where }: PageRequest, signal: AbortSignal) =>
			request<PageResult>(`?${query({ offset: String(offset), limit: String(limit), ...queryParams({ sort, where }) })}`, { signal }),

		/** Posición global actual de una fila en la consulta; `null` si la consulta la excluye. */
		locate: async (id: unknown, signal: AbortSignal, state?: QueryState) => {
			const qs = query(queryParams(state));
			return (await request<{ position: number | null }>(`/${encodeURIComponent(String(id))}/position${qs ? `?${qs}` : ''}`, { signal })).position;
		},

		/** Valores distintos de una columna con su cuenta, en la consulta dada (SB-33). */
		values: (field: string, state: QueryState, signal?: AbortSignal) => {
			const qs = query(queryParams({ where: state.where }));
			return request<ValuesResult>(`/values/${encodeURIComponent(field)}${qs ? `?${qs}` : ''}`, { signal });
		},

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
		 * Sube un archivo a una columna `image` o `file` (SB-30): los bytes tal
		 * cual, el nombre en `X-File-Name`. Devuelve la URL que queda en la celda.
		 */
		upload: (field: string, file: Blob & { name?: string }) =>
			request<UploadResult>(`/upload/${encodeURIComponent(field)}`, {
				method: 'POST',
				headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name ?? '') },
				body: file
			}),

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
