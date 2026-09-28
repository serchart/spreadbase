/**
 * Crea las tablas del ejemplo y, si están vacías, siembra 500 productos.
 * Se puede correr las veces que haga falta: `npm run setup`.
 * `--reset` (desde la raíz: `npm run postgres:reset`) borra todo y vuelve a la semilla.
 * Desde la raíz: `npm run postgres:setup`.
 */
import { readFileSync } from 'node:fs';
import { pool } from './pool.js';

if (process.argv.includes('--reset')) {
	await pool.query('DROP VIEW IF EXISTS v_products; DROP TABLE IF EXISTS products, price_history, spreadbase_idempotency');
	console.log('Tablas del ejemplo borradas.');
}

const sql = readFileSync(new URL('./migrations/001_products.sql', import.meta.url), 'utf8');
await pool.query(sql);

const { rows } = await pool.query('SELECT count(*)::int AS n FROM products');
if (rows[0].n === 0) {
	const kinds = ['Camión', 'Grúa', 'Tractor', 'Remolque', 'Montacargas', 'Excavadora', 'Retroexcavadora', 'Compactadora'];
	const colors = ['Rojo', 'Azul', 'Verde', 'Negro', 'Blanco', 'Gris', 'Amarillo'];
	const statuses = ['draft', 'active', 'active', 'paused'];
	let seed = 7;
	const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
	const values = [];
	const params = [];
	for (let i = 1; i <= 500; i++) {
		const stock = Math.floor(rand() * 20);
		const status = stock === 0 ? 'draft' : statuses[Math.floor(rand() * statuses.length)];
		params.push(
			`prd_${String(i).padStart(4, '0')}`,
			`${kinds[i % kinds.length]} ${colors[Math.floor(rand() * colors.length)]} ${i}`,
			`SKU-${String(i).padStart(4, '0')}`,
			(Math.round(rand() * 500_000) / 100).toFixed(2),
			stock,
			status
		);
		const b = (i - 1) * 6;
		values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`);
	}
	await pool.query(`INSERT INTO products (id, name, sku, price, stock, status) VALUES ${values.join(', ')}`, params);
	console.log('Sembrados 500 productos.');
} else {
	console.log(`La tabla ya tiene ${rows[0].n} productos: no se siembra.`);
}
await pool.end();
