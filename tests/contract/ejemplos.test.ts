/**
 * El kit de contrato (SB-26, `@spreadbase/testing`) contra las hojas de los
 * ejemplos: así se prueba el kit mismo, y es el modelo de cómo lo usa una app.
 *
 * - **Casos** (memoria): el «otro proceso» es `POST /api/cases/dev/mutate`.
 * - **Productos** (Postgres): el «otro proceso» es SQL directo, como un worker.
 *   Se omite si el ejemplo de Postgres no responde.
 */
import { afterAll } from 'vitest';
import { edit, sheetContract } from '@spreadbase/testing';
import { API_URL } from '../support/env.ts';
import { createPool } from '../support/postgres.ts';

const post = (path: string, body: unknown = {}) =>
	fetch(`${API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

sheetContract({
	name: 'casos (memoria)',
	url: `${API_URL}/api/cases`,
	reset: () => post('/api/cases/dev/reset'),
	edits: [edit.text('customer_name'), edit.option('stage_code')],
	external: (id, field) => post('/api/cases/dev/mutate', { ids: [id], fields: [field] })
});

const PRODUCTS = `${API_URL}/api/postgres/products/sheet`;
const postgres = await fetch(`${PRODUCTS}/schema`)
	.then((r) => r.ok)
	.catch(() => false);

if (postgres) {
	const pool = createPool();
	afterAll(() => pool.end());
	const ID = 'prd_0001';
	// La fila del caso vuelve a como estaba antes de la primera prueba.
	let seed: Record<string, unknown> | null = null;

	sheetContract({
		name: 'productos (Postgres)',
		url: PRODUCTS,
		reset: async () => {
			if (!seed) seed = (await pool.query('SELECT name, stock, status FROM products WHERE id = $1', [ID])).rows[0];
			await pool.query('UPDATE products SET name = $2, stock = $3, status = $4, deleted_at = NULL WHERE id = $1', [ID, seed!.name, seed!.stock, seed!.status]);
		},
		row: (rows) => rows.find((r) => r.id === ID) ?? rows[0],
		edits: [edit.text('name'), edit.custom('stock', (row) => Number(row.stock) + 7)],
		external: (id, field) => pool.query(`UPDATE products SET ${field} = ${field} || ' (worker)' WHERE id = $1`, [id])
	});
}
