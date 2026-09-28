/**
 * Atajos del módulo de protocolo: su «base de datos de pruebas» y cómo reiniciarla.
 * La historia de cada prueba importa esto y la API (../support/api.ts).
 */
import { api } from '../support/api.ts';

/** Vuelve la hoja de casos a sus 50 000 filas deterministas. */
export const reset = () => api('/api/cases/dev/reset', { body: {} });

export const getCase = async (id: string) => (await api(`/api/cases/${id}`)).body;

/** Simula a otro usuario cambiando campos de una fila. */
export const mutate = (id: string, fields: string[]) =>
	api('/api/cases/dev/mutate', { body: { ids: [id], fields } });

export const batch = (body: unknown, idempotencyKey?: string) =>
	api('/api/cases/batch', {
		body,
		headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}
	});

/** Política de cambios ajenos con la que arrancó el servidor (merge | strict). */
export const policy = async (): Promise<'merge' | 'strict'> =>
	(await api('/api/cases/schema')).body.policy;
