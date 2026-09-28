import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '../support/api.ts';
import { reset } from './support.ts';

beforeEach(async () => {
	await reset();
});

describe('lectura por páginas', () => {
	it('devuelve el tramo pedido y el total del dataset', async () => {
		const { status, body } = await api('/api/sandbox/cases?offset=10&limit=5');
		expect(status).toBe(200);
		expect(body.total).toBe(50_000);
		expect(body.rows).toHaveLength(5);
		expect(body.rows.map((r: { id: string }) => r.id)).toEqual([
			'case_000011',
			'case_000012',
			'case_000013',
			'case_000014',
			'case_000015'
		]);
	});

	it('cada fila trae su rowVersion, que empieza en 1', async () => {
		const { body } = await api('/api/sandbox/cases?offset=0&limit=3');
		for (const row of body.rows) expect(row.rowVersion).toBe(1);
	});

	it('el último tramo se recorta al final del dataset', async () => {
		const { body } = await api('/api/sandbox/cases?offset=49998&limit=10');
		expect(body.rows).toHaveLength(2);
	});

	it('locate da la posición global de una fila (0-based)', async () => {
		const { body } = await api('/api/sandbox/cases/case_000123/position');
		expect(body).toEqual({ id: 'case_000123', position: 122, total: 50_000 });
	});

	it('una fila inexistente es 404', async () => {
		const { status, body } = await api('/api/sandbox/cases/case_999999');
		expect(status).toBe(404);
		expect(body.error.code).toBe('not_found');
	});
});
