/**
 * `mongoSource` contra un MongoDB real (replica set de un nodo), con la forma
 * de Aggy Legacy: muchas tablas en una colección compartida (`datadocuments`),
 * documentos planos, `_id` ObjectId y la hoja como el subconjunto
 * `{ accountId, dataTableId }`.
 *
 * El «otro usuario» escribe con el driver directo, como un worker o un
 * script: la concurrencia tiene que enterarse igual, sin campo de versión
 * (SB-4). Si no hay Mongo, se omite.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import type { ClientSession, Db } from 'mongodb';
import { SpreadBase, mongoSource, parseBatch, types } from '@spreadbase/server';
import type { BatchInput, Row, SheetHandlers } from '@spreadbase/server';
import { connectMongo } from '../support/mongo.ts';

const client = await connectMongo();
const db = client?.db('spreadbase_test') as Db;
const DOCS = 'datadocuments';
const HISTORY = 'sb_price_history';
const IDEMPOTENCY = 'sb_test_idempotency';
const LOCKS = 'sb_test_locks';

afterAll(async () => {
	await client?.close();
});

const accountId = new ObjectId();
const dataTableId = new ObjectId();
const otherTable = new ObjectId();
/** Los ids de la semilla, por nombre corto (`p1`…`p5`), y el de la otra tabla. */
const id: Record<string, string> = {};

beforeEach(async () => {
	if (!client) return;
	await db.collection(DOCS).drop().catch(() => undefined);
	await db.collection(HISTORY).drop().catch(() => undefined);
	await db.collection(IDEMPOTENCY).drop().catch(() => undefined);
	const seed = [
		['p1', 'Camión Rojo', 'CAM-001', 1500, 3, 'active', '2024-01-15'],
		['p2', 'Grúa Azul', 'GRU-002', 2500.5, 0, 'draft', '2024-02-01'],
		// Como lo guarda Aggy Legacy: números como texto.
		['p3', 'Tractor Verde', 'TRA-003', '1500', 10, 'active', null],
		['p4', 'Remolque Negro', 'REM-004', 800, 1, 'paused', '2023-12-31'],
		['p5', 'Montacargas', 'MON-005', 3200, 7, 'active', new Date('2024-03-10T00:00:00Z')]
	] as const;
	const docs = seed.map(([key, name, sku, price, stock, status, since]) => {
		const _id = new ObjectId();
		id[key] = _id.toHexString();
		return { _id, accountId, dataTableId, name, sku, price, stock, status, since };
	});
	// Otra tabla de la misma cuenta, en la misma colección: la hoja no la ve.
	const other = { _id: new ObjectId(), accountId, dataTableId: otherTable, name: 'Camión Ajeno', sku: 'OTR-001', price: 1, stock: 0, status: 'active' };
	id.other = other._id.toHexString();
	await db.collection(DOCS).insertMany([...docs, other]);
});

const columns = {
	id: { type: types.TEXT, label: 'ID', readOnly: true },
	name: { type: types.TEXT, label: 'Nombre', required: true, searchable: true },
	sku: { type: types.TEXT, label: 'SKU', required: true, searchable: true },
	price: { type: types.NUMBER, label: 'Precio', required: true, min: 0 },
	// Lo mueve el inventario, no la hoja: de solo lectura.
	stock: { type: types.NUMBER, label: 'Existencias', readOnly: true },
	status: {
		type: types.SELECT,
		label: 'Estado',
		required: true,
		options: ['draft', 'active', 'paused'].map((v) => ({ value: v, label: v }))
	},
	since: { type: types.DATE, label: 'Desde' }
};

function sheet(opts: { policy?: 'merge' | 'strict'; handlers?: SheetHandlers; versionField?: string } = {}) {
	return new SpreadBase({
		id: 'products',
		allowInsert: true,
		allowDelete: true,
		policy: opts.policy,
		columns,
		source: mongoSource({
			client: client!,
			db,
			collection: DOCS,
			filter: { accountId, dataTableId },
			versionField: opts.versionField,
			idempotencyCollection: IDEMPOTENCY,
			lockCollection: LOCKS
		}),
		handlers: opts.handlers
	});
}

const WRITABLE = ['name', 'sku', 'price', 'status', 'since'];
const query = (q: Partial<Parameters<SpreadBase['list']>[0]> = {}) => ({ offset: 0, limit: 100, sort: null, filters: {}, search: '', ...q });
const short = (rows: Row[]) => rows.map((r) => Object.keys(id).find((k) => id[k] === r.id));

/** Edición como la manda el cliente: `from`/`to` del campo y `base` con lo demás que leyó. */
const edit = (row: Row, field: string, to: unknown) => ({
	id: String(row.id),
	rowVersion: row.rowVersion,
	changes: { [field]: { from: row[field] as never, to: to as never } },
	base: Object.fromEntries(WRITABLE.filter((f) => f !== field).map((f) => [f, (row[f] ?? null) as never]))
});
const batch = (b: Partial<BatchInput>): BatchInput => ({ creates: [], updates: [], deletes: [], ...b });
const dbDoc = (key: string) => db.collection(DOCS).findOne({ _id: new ObjectId(id[key] ?? key) });
const external = (key: string, set: Record<string, unknown>) => db.collection(DOCS).updateOne({ _id: new ObjectId(id[key]) }, { $set: set });

describe.skipIf(!client)('mongoSource · lectura', () => {
	it('lista solo su tabla, con tipos del protocolo: id ObjectId como texto, números como número, fechas como texto', async () => {
		const page = await sheet().list(query());
		expect(page.total).toBe(5);
		expect(short(page.rows)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
		expect(page.rows[0]).toMatchObject({ id: id.p1, name: 'Camión Rojo', price: 1500, stock: 3, since: '2024-01-15' });
		expect(page.rows[2]).toMatchObject({ price: 1500, since: null });
		expect(page.rows[4]!.since).toBe('2024-03-10');
		expect(page.rows[0]!.rowVersion).toMatch(/^[0-9a-f]{32}$/);
	});

	it('ordena con desempate por id (número guardado como texto incluido) y pagina sin repetir ni saltar', async () => {
		const s = sheet();
		const byPrice = await s.list(query({ sort: { field: 'price', dir: 'asc' } }));
		expect(short(byPrice.rows)).toEqual(['p4', 'p1', 'p3', 'p2', 'p5']); // p1 y p3 empatan: por id
		const seen: Row[] = [];
		for (let offset = 0; offset < 5; offset += 2) {
			const page = await s.list(query({ sort: { field: 'price', dir: 'desc' }, offset, limit: 2 }));
			seen.push(...page.rows);
		}
		expect(short(seen)).toEqual(['p5', 'p2', 'p1', 'p3', 'p4']);
		// Vacíos al final en los dos sentidos.
		expect(short((await s.list(query({ sort: { field: 'since', dir: 'asc' } }))).rows).at(-1)).toBe('p3');
		expect(short((await s.list(query({ sort: { field: 'since', dir: 'desc' } }))).rows).at(-1)).toBe('p3');
	});

	it('filtra por columna y busca sin distinguir acentos ni mayúsculas', async () => {
		const s = sheet();
		expect((await s.list(query({ filters: { status: ['active'] } }))).total).toBe(3);
		expect(short((await s.list(query({ search: 'camion' }))).rows)).toEqual(['p1']); // el «Camión Ajeno» es de otra tabla
		expect(short((await s.list(query({ search: 'GRUA' }))).rows)).toEqual(['p2']);
		expect(short((await s.list(query({ search: 'tra-003' }))).rows)).toEqual(['p3']);
	});

	it('da la posición de una fila en la consulta, o null si la excluye', async () => {
		const s = sheet();
		expect(await s.position(id.p3!, query({ sort: { field: 'price', dir: 'asc' } }))).toEqual({ id: id.p3, position: 2, total: 5 });
		expect(await s.position(id.p2!, query({ filters: { status: ['active'] } }))).toEqual({ id: id.p2, position: null, total: 3 });
	});

	it('la huella cambia con cualquier escritura en un campo escribible, venga de donde venga', async () => {
		const s = sheet();
		const before = (await s.get(id.p1!)).rowVersion;
		await external('p1', { name: 'Camión Rojo 2' });
		const after = (await s.get(id.p1!)).rowVersion;
		expect(after).not.toBe(before);
		// Uno de solo lectura (existencias) no cuenta: no es «otro usuario» (SB-16).
		await external('p1', { stock: 99 });
		expect((await s.get(id.p1!)).rowVersion).toBe(after);
	});

	it('una fila inexistente, o de otra tabla de la colección, es 404', async () => {
		await expect(sheet().get('nada')).rejects.toMatchObject({ status: 404, code: 'not_found' });
		await expect(sheet().get(new ObjectId().toHexString())).rejects.toMatchObject({ status: 404 });
		await expect(sheet().get(id.other!)).rejects.toMatchObject({ status: 404 });
	});
});

describe.skipIf(!client)('mongoSource · colecciones grandes (SB-35)', () => {
	const BIG = 'sb_test_big';
	const big = (opts: { count?: 'exact' | 'auto' | 'estimate'; filter?: Record<string, unknown> } = {}) =>
		new SpreadBase({
			id: 'big',
			columns: { id: { type: types.TEXT, label: 'ID' }, grupo: { type: types.TEXT, label: 'Grupo' } },
			source: mongoSource({ client: client!, db, collection: BIG, exactCountUpTo: 100, ...opts })
		});

	beforeEach(async () => {
		await db.collection(BIG).drop().catch(() => undefined);
		await db.collection(BIG).insertMany(Array.from({ length: 500 }, (_, i) => ({ _id: `r${String(i).padStart(4, '0')}`, grupo: `g${i % 5}` }) as never));
	});

	it('la colección entera se estima con los metadatos; con filtro se cuenta exacto; al final, lo que hay', async () => {
		expect((await big().list(query({ limit: 10 }))).total).toBe(500);
		expect((await big({ filter: { grupo: 'g1' } }).list(query({ limit: 10 }))).total).toBe(100);
		expect((await big().list(query({ limit: 10, filters: { grupo: ['g2'] } }))).total).toBe(100);
		const last = await big({ count: 'estimate' }).list(query({ offset: 495, limit: 100 }));
		expect(last.rows).toHaveLength(5);
		expect(last.total).toBe(500);
		// Un id de texto (no ObjectId) también sirve de llave.
		expect((await big().get('r0007')).grupo).toBe('g2');
	});
});

describe.skipIf(!client)('mongoSource · lote sin handlers: escribe la fuente', () => {
	it('edita, crea (con los campos del filtro fijo) y elimina', async () => {
		const s = sheet();
		const p1 = await s.get(id.p1!);
		const { result } = await s.batch(
			batch({
				updates: [edit(p1, 'price', 1750)],
				creates: [{ key: 'tmp_1', values: { name: 'Nuevo', sku: 'NEW-001', price: 10, status: 'draft' } }],
				deletes: [{ id: id.p4!, rowVersion: (await s.get(id.p4!)).rowVersion }]
			})
		);
		expect(result.conflicts).toEqual([]);
		expect(result.updated[0]).toMatchObject({ id: id.p1, price: 1750 });
		expect(result.updated[0]!.rowVersion).not.toBe(p1.rowVersion);
		const created = result.created[0]!.row;
		expect(created).toMatchObject({ name: 'Nuevo', price: 10 });
		expect(String(created.id)).toMatch(/^[0-9a-f]{24}$/);
		expect(result.deleted).toEqual([id.p4]);
		expect((await dbDoc('p1'))!.price).toBe(1750);
		expect(await dbDoc('p4')).toBeNull();
		// El documento nuevo nace dentro de la tabla: con accountId y dataTableId (ObjectId).
		const doc = await db.collection(DOCS).findOne({ _id: new ObjectId(String(created.id)) });
		expect(doc).toMatchObject({ accountId, dataTableId, name: 'Nuevo' });
		expect(doc!._id).toBeInstanceOf(ObjectId);
	});

	it('no toca documentos de otra tabla aunque se pida su id', async () => {
		const s = sheet();
		const fake = { id: id.other!, rowVersion: 'x', name: 'Camión Ajeno', sku: 'OTR-001', price: 1, status: 'active', since: null } as Row;
		const { result } = await s.batch(batch({ updates: [edit(fake, 'name', 'Mío')] }));
		// Para la hoja no existe: editarlo es not_found y eliminarlo no hace nada.
		expect(result.conflicts).toEqual([expect.objectContaining({ op: 'update', reason: 'not_found' })]);
		await s.batch(batch({ deletes: [{ id: id.other!, rowVersion: 'x' }] }));
		expect(await dbDoc('other')).toMatchObject({ name: 'Camión Ajeno' });
	});

	it('un lote inválido no escribe nada', async () => {
		const s = sheet();
		const p1 = await s.get(id.p1!);
		await expect(s.batch(batch({ updates: [edit(p1, 'price', 1), { ...edit(p1, 'stock', 5), id: id.p2! }] }))).rejects.toMatchObject({
			status: 400
		});
		expect((await dbDoc('p1'))!.price).toBe(1500);
	});

	it('con versionField: contador que la fuente sube en cada escritura', async () => {
		await db.collection(DOCS).updateMany({ dataTableId }, { $set: { v: 1 } });
		const s = sheet({ versionField: 'v' });
		const p1 = await s.get(id.p1!);
		expect(p1.rowVersion).toBe('1');
		const { result } = await s.batch(batch({ updates: [edit(p1, 'price', 1750)] }));
		expect(result.updated[0]!.rowVersion).toBe('2');
		// Otro proceso que respeta el contador: conflicto.
		await db.collection(DOCS).updateOne({ _id: new ObjectId(id.p1) }, { $set: { price: 1 }, $inc: { v: 1 } });
		const again = await s.batch(batch({ updates: [edit(result.updated[0]!, 'price', 9)] }));
		expect(again.result.conflicts[0]).toMatchObject({ reason: 'field_conflict' });
	});
});

describe.skipIf(!client)('mongoSource · concurrencia contra escrituras externas', () => {
	it('mismo campo, valores distintos → field_conflict y no se escribe', async () => {
		const s = sheet();
		const mine = await s.get(id.p1!);
		await external('p1', { price: 1600 });
		const { result } = await s.batch(batch({ updates: [edit(mine, 'price', 1750)] }));
		expect(result.conflicts[0]).toMatchObject({
			id: id.p1,
			reason: 'field_conflict',
			fields: [{ field: 'price', from: 1500, yours: 1750, remote: 1600 }]
		});
		expect((await dbDoc('p1'))!.price).toBe(1600);
	});

	it('otro campo, merge → se aplica, se conserva lo ajeno y se avisa (SB-16); strict → version_mismatch', async () => {
		const mine = await sheet().get(id.p1!);
		await external('p1', { status: 'paused' });
		const { result } = await sheet().batch(batch({ updates: [edit(mine, 'price', 1750)] }));
		expect(result.notices).toEqual([{ id: id.p1, fields: ['status'] }]);
		expect(result.updated[0]).toMatchObject({ price: 1750, status: 'paused' });

		const strict = sheet({ policy: 'strict' });
		const read = await strict.get(id.p2!);
		await external('p2', { status: 'paused' });
		const res = await strict.batch(batch({ updates: [edit(read, 'price', 1)] }));
		expect(res.result.conflicts[0]).toMatchObject({ id: id.p2, reason: 'version_mismatch' });
	});

	it('bajas: eliminar lo editado es conflicto; lo eliminado se reporta; editar lo eliminado es not_found', async () => {
		const s = sheet();
		const p2 = await s.get(id.p2!);
		const p3 = await s.get(id.p3!);
		const p5 = await s.get(id.p5!);
		await external('p2', { name: 'Otra' });
		await db.collection(DOCS).deleteMany({ _id: { $in: [new ObjectId(id.p3), new ObjectId(id.p5)] } });
		const { result } = await s.batch(
			batch({
				deletes: [
					{ id: id.p2!, rowVersion: p2.rowVersion },
					{ id: id.p3!, rowVersion: p3.rowVersion }
				],
				updates: [edit(p5, 'price', 1)]
			})
		);
		expect(result.deleted).toEqual([id.p3]);
		expect(result.conflicts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ op: 'delete', id: id.p2, reason: 'version_mismatch' }),
				expect.objectContaining({ op: 'update', id: id.p5, reason: 'not_found' })
			])
		);
	});

	it('dos lotes a la vez sobre la misma fila: el candado los ordena y el segundo ve el conflicto', async () => {
		const s = sheet();
		const read = await s.get(id.p1!);
		const [a, b] = await Promise.all([
			s.batch(batch({ updates: [edit(read, 'price', 1111)] })),
			s.batch(batch({ updates: [edit(read, 'price', 2222)] }))
		]);
		const applied = [a, b].filter((o) => o.result.updated.length === 1);
		const clashed = [a, b].filter((o) => o.result.conflicts.length === 1);
		expect(applied).toHaveLength(1);
		expect(clashed).toHaveLength(1);
		expect((await dbDoc('p1'))!.price).toBe(applied[0]!.result.updated[0]!.price);
	});
});

describe.skipIf(!client)('mongoSource · transacción y handlers (SB-19, SB-20)', () => {
	/** Handlers con reglas: historial de precios y activación; escriben con la sesión de `ctx.tx.db`. */
	const shop = (): SheetHandlers => ({
		updateMany: async (items, ctx) => {
			const session = ctx.tx!.db as ClientSession;
			for (const { id: rowId, values, row } of items) {
				if (values.status === 'active' && Number(row.stock) <= 0) throw new Error(`${row.name} no se puede activar sin existencias`);
				if ('price' in values) {
					await db.collection(HISTORY).insertOne({ productId: rowId, old: row.price, new: values.price, by: ctx.user }, { session });
				}
				await db.collection(DOCS).updateOne({ _id: new ObjectId(rowId) }, { $set: values }, { session });
			}
			return items.map((i) => ({ id: i.id })); // sin rowVersion: el motor relee la fila y la fuente pone la huella
		}
	});

	it('el handler escribe con la sesión de la transacción y recibe el contexto', async () => {
		await db.createCollection(HISTORY);
		const s = sheet({ handlers: shop() });
		const p1 = await s.get(id.p1!);
		const { result } = await s.batch(batch({ updates: [edit(p1, 'price', 1750)] }), { context: { user: 'ana' } });
		expect(result.updated[0]).toMatchObject({ id: id.p1, price: 1750 });
		expect(result.updated[0]!.rowVersion).toMatch(/^[0-9a-f]{32}$/);
		expect(await db.collection(HISTORY).find().toArray()).toEqual([expect.objectContaining({ productId: id.p1, by: 'ana' })]);
	});

	it('si el handler lanza, se deshace todo el lote (y su llave de idempotencia)', async () => {
		await db.createCollection(HISTORY);
		const s = sheet({ handlers: shop() });
		const p1 = await s.get(id.p1!);
		const p2 = await s.get(id.p2!); // sin existencias
		await expect(
			s.batch(batch({ updates: [edit(p1, 'price', 1750), edit(p2, 'status', 'active')] }), { idempotencyKey: 'k-rollback' })
		).rejects.toThrow('no se puede activar sin existencias');
		expect((await dbDoc('p1'))!.price).toBe(1500);
		expect(await db.collection(HISTORY).countDocuments()).toBe(0);
		expect(await db.collection(IDEMPOTENCY).countDocuments()).toBe(0);
	});

	it('sin replica set o con transactions: false, el motor aplica los lotes de uno en uno', async () => {
		const s = new SpreadBase({
			id: 'products',
			columns,
			source: mongoSource({ db, collection: DOCS, filter: { accountId, dataTableId }, transactions: false })
		});
		const p1 = await s.get(id.p1!);
		const { result } = await s.batch(batch({ updates: [edit(p1, 'price', 1750)] }));
		expect(result.updated[0]).toMatchObject({ price: 1750 });
	});
});

describe.skipIf(!client)('mongoSource · idempotencia en la base (SB-18)', () => {
	const create = (name: string) => batch({ creates: [{ key: 'tmp', values: { name, sku: 'IDE-001', price: 1, status: 'draft' } }] });
	const countByName = (name: string) => db.collection(DOCS).countDocuments({ name });

	it('la librería guarda la respuesta en su colección, con vencimiento (TTL)', async () => {
		await sheet().batch(create('Idem A'), { idempotencyKey: 'k-a' });
		const stored = await db.collection(IDEMPOTENCY).find().toArray();
		expect(stored).toEqual([expect.objectContaining({ _id: { sheet: 'products', key: 'k-a' } })]);
		expect(stored[0]!.expiresAt).toBeInstanceOf(Date);
		const ttl = (await db.collection(IDEMPOTENCY).indexes()).find((i) => i.key.expiresAt === 1);
		expect(ttl?.expireAfterSeconds).toBe(0);
	});

	it('el reintento con la misma llave devuelve la misma respuesta y no duplica; con otro cuerpo es 422', async () => {
		const s = sheet();
		const first = await s.batch(create('Idem B'), { idempotencyKey: 'k-b' });
		const retry = await s.batch(create('Idem B'), { idempotencyKey: 'k-b' });
		expect(first.replayed).toBe(false);
		expect(retry.replayed).toBe(true);
		expect(retry.result).toEqual(first.result);
		expect(await countByName('Idem B')).toBe(1);
		await expect(s.batch(create('Otro'), { idempotencyKey: 'k-b' })).rejects.toMatchObject({ status: 422, code: 'idempotency_key_reused' });
	});

	it('dos envíos simultáneos con la misma llave no aplican el lote dos veces', async () => {
		const s = sheet();
		const outcomes = await Promise.allSettled([
			s.batch(create('Idem D'), { idempotencyKey: 'k-d' }),
			s.batch(create('Idem D'), { idempotencyKey: 'k-d' })
		]);
		expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
		expect(await countByName('Idem D')).toBe(1);
	});

	it('el lote del cliente llega por parseBatch con el id ObjectId como texto', async () => {
		const s = sheet();
		const row = await s.get(id.p3!);
		const input = parseBatch({ updates: [{ id: row.id, rowVersion: row.rowVersion, changes: { price: { from: row.price, to: 1 } } }] });
		const { result } = await s.batch(input);
		expect(result.updated[0]).toMatchObject({ id: id.p3, price: 1 });
	});
});
