/**
 * Módulo `sandbox` del backend: 50 000 casos sintéticos para probar el
 * DataGrid con datos remotos. Contrato en `backend/README.md` y
 * `07-anexo-datagrid-engine.md` §11.5.
 */
import type {
	BatchRequest,
	BatchResponse,
	PageRequest,
	PageResult
} from '$lib/components/datagrid/types';
import { api } from './client';

export interface SandboxPage extends PageResult {
	offset: number;
	limit: number;
	/** Versión global del almacén. Si cambia entre dos páginas, los datos se modificaron en medio. */
	version: number;
}

export interface SandboxQuery {
	sort?: string;
	stage?: string[];
	handler?: string[];
	search?: string;
}

// -- guardado (§11.13, §11.14) ----------------------------------------------

/**
 * `POST /api/sandbox/cases/batch`.
 *
 * `idempotencyKey` identifica el intento de guardado (G-12): si se reintenta
 * con la misma llave —doble clic, corte de red— el servidor devuelve la misma
 * respuesta sin aplicar dos veces. Generar una nueva por cada clic en Guardar.
 */
export function saveSandboxCases(batch: BatchRequest, idempotencyKey: string): Promise<BatchResponse> {
	return api<BatchResponse>('/api/sandbox/cases/batch', {
		method: 'POST',
		headers: { 'Idempotency-Key': idempotencyKey },
		body: JSON.stringify(batch)
	});
}

function queryParams(query: SandboxQuery): URLSearchParams {
	const params = new URLSearchParams();
	if (query.sort) params.set('sort', query.sort);
	if (query.stage?.length) params.set('stage', query.stage.join(','));
	if (query.handler?.length) params.set('handler', query.handler.join(','));
	if (query.search) params.set('search', query.search);
	return params;
}

/** Posición global actual de una fila en la misma consulta; `null` si la consulta la excluye. */
export async function locateSandboxCase(
	id: unknown,
	signal: AbortSignal,
	query: SandboxQuery = {}
): Promise<number | null> {
	const res = await api<{ position: number | null }>(
		`/api/sandbox/cases/${encodeURIComponent(String(id))}/position?${queryParams(query)}`,
		{ signal }
	);
	return res.position;
}

export function loadSandboxCases(
	{ offset, limit }: PageRequest,
	signal: AbortSignal,
	query: SandboxQuery = {}
): Promise<SandboxPage> {
	const params = queryParams(query);
	params.set('offset', String(offset));
	params.set('limit', String(limit));
	return api<SandboxPage>(`/api/sandbox/cases?${params}`, { signal });
}
