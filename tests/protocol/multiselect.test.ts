/**
 * Selección múltiple (SB-41) por el protocolo, sobre «Agencias» del ejemplo
 * del catálogo (fuente en memoria): filtros por valor «contiene alguna de»,
 * vacías, lista de valores con su cuenta, filtro fijo y validación del lote.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { API_URL } from '../support/env.ts';

const BASE = `${API_URL}/api/catalog/agencies`;

const list = async (params: Record<string, string> = {}) => {
	const res = await fetch(`${BASE}?${new URLSearchParams({ offset: '0', limit: '50', ...params })}`);
	return (await res.json()) as { rows: Record<string, unknown>[] };
};
const ids = async (params: Record<string, string>) => (await list(params)).rows.map((r) => r.id).sort();
const where = (filters: unknown[]) => ({ where: JSON.stringify(filters) });
const batch = (body: unknown) => fetch(`${BASE}/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
	await fetch(`${API_URL}/api/catalog/reset`, { method: 'POST' });
});

describe('multiselect por el protocolo (SB-41)', () => {
	it('el esquema la anuncia con sus opciones; las filas traen la lista', async () => {
		const schema = await (await fetch(`${BASE}/schema`)).json();
		expect(schema.columns.brands).toMatchObject({ type: 'multiselect', options: expect.arrayContaining([{ value: 'byd', label: 'BYD' }]) });
		const rows = (await list()).rows;
		expect(rows.find((r) => r.id === 'ag_1')!.brands).toEqual(['byd', 'honda']);
		expect(rows.find((r) => r.id === 'ag_4')!.brands).toBeNull();
	});

	it('filtra por «contiene alguna de», por vacías y con el filtro fijo', async () => {
		expect(await ids(where([{ field: 'brands', op: 'in', values: ['honda'] }]))).toEqual(['ag_1', 'ag_5']);
		expect(await ids(where([{ field: 'brands', op: 'in', values: ['kia', 'chevrolet'] }]))).toEqual(['ag_2', 'ag_3']);
		expect(await ids(where([{ field: 'brands', op: 'in', values: [null] }]))).toEqual(['ag_4']);
		expect(await ids(where([{ field: 'brands', op: 'not_empty' }]))).toEqual(['ag_1', 'ag_2', 'ag_3', 'ag_5']);
		expect(await ids({ brands: 'toyota' })).toEqual(['ag_3', 'ag_5']);
	});

	it('la lista de valores cuenta las filas que contienen cada opción', async () => {
		const body = await (await fetch(`${BASE}/values/brands`)).json();
		expect(body.values).toEqual([
			{ value: null, count: 1 },
			{ value: 'byd', count: 2 },
			{ value: 'chevrolet', count: 2 },
			{ value: 'honda', count: 2 },
			{ value: 'kia', count: 1 },
			{ value: 'mazda', count: 1 },
			{ value: 'nissan', count: 1 },
			{ value: 'toyota', count: 2 }
		]);
	});

	it('el lote acepta una lista de options y rechaza lo que no es del catálogo o se repite', async () => {
		const row = (await list()).rows.find((r) => r.id === 'ag_2')!;
		const update = (to: unknown) => ({ creates: [], deletes: [], updates: [{ id: 'ag_2', rowVersion: row.rowVersion, changes: { brands: { from: ['chevrolet'], to } } }] });
		const bad = await batch(update(['chevrolet', 'ferrari']));
		expect(bad.status).toBe(400);
		expect(JSON.stringify(await bad.json())).toContain('Valor fuera del catálogo');
		expect((await batch(update(['honda', 'honda']))).status).toBe(400);
		const ok = await batch(update(['chevrolet', 'honda']));
		expect(ok.status).toBe(200);
		expect((await list()).rows.find((r) => r.id === 'ag_2')!.brands).toEqual(['chevrolet', 'honda']);
	});
});
