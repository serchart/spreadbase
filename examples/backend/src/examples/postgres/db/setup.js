/**
 * Crea las tablas del ejemplo y siembra lo que falte: 2 000 usuarios y 500
 * productos, con un valor en cada columna nueva.
 * Se puede correr las veces que haga falta. Desde la raíz: `npm run postgres:setup`.
 * `npm run postgres:reset` borra todo y vuelve a la semilla.
 */
import { readFileSync } from 'node:fs';
import { pool } from './pool.js';

if (process.argv.includes('--reset')) {
	await pool.query('DROP VIEW IF EXISTS v_products; DROP TABLE IF EXISTS products, price_history, users, spreadbase_idempotency');
	console.log('Tablas del ejemplo borradas.');
}

// La vista se recrea en cada migración; una versión anterior con menos columnas
// no se puede reemplazar, así que se quita primero.
await pool.query('DROP VIEW IF EXISTS v_products');
for (const file of ['001_products.sql', '002_catalog.sql', '003_users_sheet.sql']) {
	await pool.query(readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8'));
}

let seed = 7;
const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
const pick = (list) => list[Math.floor(rand() * list.length)];
const COLORS = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777'];

/** Una imagen SVG en línea: sin red ni archivos, cabe en la columna. */
const svg = (text, color, round) =>
	'data:image/svg+xml,' +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="${round ? 32 : 10}" fill="${color}"/>` +
			`<text x="32" y="33" font-family="system-ui,sans-serif" font-size="24" font-weight="600" fill="#fff" text-anchor="middle" dominant-baseline="middle">${text}</text></svg>`
	);

/** Inserta en lotes de 500 filas. */
async function insertAll(table, columns, rows) {
	for (let i = 0; i < rows.length; i += 500) {
		const chunk = rows.slice(i, i + 500);
		const params = chunk.flat();
		const values = chunk.map((_, r) => `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`);
		await pool.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}`, params);
	}
}

// -- usuarios: el recurso externo de la columna «Responsable» -----------------
const users = await pool.query('SELECT count(*)::int AS n FROM users');
if (users.rows[0].n === 0) {
	// Pocos nombres y apellidos a propósito: habrá homónimos, para ver el «ambiguo» al pegar.
	const first = ['Ana', 'Luis', 'María', 'José', 'Sofía', 'Carlos', 'Lucía', 'Jorge', 'Elena', 'Miguel', 'Paula', 'Andrés', 'Valeria', 'Diego', 'Camila', 'Raúl', 'Daniela', 'Iván', 'Fernanda', 'Óscar'];
	const last = ['López', 'Martínez', 'García', 'Hernández', 'Pérez', 'Sánchez', 'Ramírez', 'Torres', 'Flores', 'Rivera', 'Gómez', 'Díaz', 'Cruz', 'Morales', 'Ortiz', 'Gutiérrez', 'Chávez', 'Ruiz', 'Núñez', 'Vargas', 'Castillo', 'Jiménez', 'Mendoza', 'Aguilar', 'Rojas'];
	const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
	const rows = [];
	for (let i = 1; i <= 2000; i++) {
		const f = pick(first);
		const l = pick(last);
		const id = `usr_${String(i).padStart(4, '0')}`;
		rows.push([id, `${f} ${l}`, `${plain(f)}.${plain(l)}.${i}@tienda.mx`, svg(`${f[0]}${l[0]}`, pick(COLORS), true)]);
	}
	await insertAll('users', ['id', 'name', 'email', 'avatar'], rows);
	console.log('Sembrados 2 000 usuarios.');
}

// -- productos ----------------------------------------------------------------
const KINDS = ['Camión', 'Grúa', 'Tractor', 'Remolque', 'Montacargas', 'Excavadora', 'Retroexcavadora', 'Compactadora'];
const products = await pool.query('SELECT count(*)::int AS n FROM products');
if (products.rows[0].n === 0) {
	const colors = ['Rojo', 'Azul', 'Verde', 'Negro', 'Blanco', 'Gris', 'Amarillo'];
	const statuses = ['draft', 'active', 'active', 'paused'];
	const rows = [];
	for (let i = 1; i <= 500; i++) {
		const stock = Math.floor(rand() * 20);
		const status = stock === 0 ? 'draft' : pick(statuses);
		rows.push([
			`prd_${String(i).padStart(4, '0')}`,
			`${KINDS[i % KINDS.length]} ${pick(colors)} ${i}`,
			`SKU-${String(i).padStart(4, '0')}`,
			(Math.round(rand() * 500_000) / 100).toFixed(2),
			stock,
			status
		]);
	}
	await insertAll('products', ['id', 'name', 'sku', 'price', 'stock', 'status'], rows);
	console.log('Sembrados 500 productos.');
}

// Las columnas nuevas, en los productos que aún no las tengan (también en una base sembrada con la versión anterior).
const { rows: pending } = await pool.query(`SELECT id, name FROM products WHERE owner_id IS NULL ORDER BY id`);
if (pending.length > 0) {
	const { rows: userIds } = await pool.query(`SELECT id FROM users ORDER BY id`);
	for (const { id, name } of pending) {
		const kind = KINDS.findIndex((k) => name.startsWith(k));
		const day = new Date(Date.UTC(2024, 0, 1) + Math.floor(rand() * 900) * 86_400_000);
		const restocked = new Date(Date.UTC(2026, 5, 1) + Math.floor(rand() * 120 * 24 * 60) * 60_000);
		await pool.query(
			`UPDATE products SET owner_id = $2, image_url = $3, launch_date = $4, restocked_at = $5 WHERE id = $1`,
			[
				id,
				pick(userIds).id,
				rand() < 0.85 ? svg((name[0] ?? '?').toUpperCase(), COLORS[Math.max(0, kind) % COLORS.length], false) : null,
				day.toISOString().slice(0, 10),
				`${restocked.toISOString().slice(0, 10)} ${restocked.toISOString().slice(11, 16)}`
			]
		);
	}
	console.log(`Completadas las columnas nuevas de ${pending.length} productos.`);
}

// Contraseñas de la semilla: un solo hash para todos (scrypt es lento a propósito;
// 2 000 hashes distintos tardarían minutos). La contraseña es «demo-12345».
const noPassword = await pool.query('SELECT count(*)::int AS n FROM users WHERE password_hash IS NULL');
if (noPassword.rows[0].n > 0) {
	const { hashPassword } = await import('../common/passwords.js');
	await pool.query('UPDATE users SET password_hash = $1 WHERE password_hash IS NULL', [await hashPassword('demo-12345')]);
	await pool.query(`UPDATE users SET role = CASE WHEN id <= 'usr_0005' THEN 'admin' WHEN id <= 'usr_0050' THEN 'supervisor' ELSE 'ejecutivo' END`);
	console.log(`Contraseña y rol a ${noPassword.rows[0].n} usuarios (contraseña: demo-12345).`);
}

console.log('Base del ejemplo lista.');
await pool.end();
