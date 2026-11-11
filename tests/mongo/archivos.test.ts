/**
 * Columnas `file` y `folder` (SB-38) sobre MongoDB: el archivo se guarda como
 * subdocumento y la carpeta como lista; se leen igual (con los números de BSON
 * como número) y la concurrencia por campo funciona sobre ellos. Si no hay
 * Mongo, se omite.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { Int32 } from 'mongodb';
import { SpreadBase, mongoSource, types } from '@spreadbase/server';
import type { FileRef, Row } from '@spreadbase/server';
import { connectMongo } from '../support/mongo.ts';

const client = await connectMongo();
const db = client?.db('spreadbase_test') as Db;
const DOCS = 'sb_test_archivos';

afterAll(async () => {
	await client?.close();
});

beforeEach(async () => {
	if (!client) return;
	await db.collection(DOCS).drop().catch(() => undefined);
	await db.collection(DOCS).insertMany([
		{ _id: 'p1' as never, nombre: 'Aveo', contrato: '/uploads/docs/a1/contrato.pdf' },
		{ _id: 'p2' as never, nombre: 'Onix', ficha: { url: '/uploads/docs/b2/ficha.pdf', nombre: 'ficha.pdf', tipo: 'application/pdf', tamano: new Int32(2048) }, carpeta: [] }
	]);
});

const PDF: FileRef = { url: '/uploads/docs/c3/manual.pdf', nombre: 'manual.pdf', tipo: 'application/pdf', tamano: 10_240 };
const PNG: FileRef = { url: '/uploads/docs/d4/frente.png', nombre: 'frente.png', tipo: 'image/png', tamano: 512 };
const change = (row: Row, field: string, to: unknown) => ({ id: String(row.id), rowVersion: row.rowVersion, changes: { [field]: { from: row[field] as never, to: to as never } } });

const sheet = () =>
	new SpreadBase({
		id: 'archivos',
		allowInsert: true,
		columns: {
			id: { type: types.TEXT, label: 'ID', readOnly: true },
			nombre: { type: types.TEXT, label: 'Nombre', required: true },
			contrato: { type: types.FILE, label: 'Contrato' },
			ficha: { type: types.FILE, label: 'Ficha' },
			carpeta: { type: types.FOLDER, label: 'Carpeta' }
		},
		source: mongoSource({ client: client!, db, collection: DOCS, createId: () => `p${Date.now()}` })
	});

describe.skipIf(!client)('file y folder en MongoDB (SB-38)', () => {
	it('lee el subdocumento y la lista (Int32 → número) y la URL suelta como texto', async () => {
		const s = sheet();
		const rows = (await s.list({ offset: 0, limit: 10, sort: null, filters: {}, search: '' })).rows;
		expect(rows.find((r) => r.id === 'p1')).toMatchObject({ contrato: '/uploads/docs/a1/contrato.pdf', ficha: null, carpeta: null });
		expect(rows.find((r) => r.id === 'p2')).toMatchObject({ ficha: { url: '/uploads/docs/b2/ficha.pdf', nombre: 'ficha.pdf', tipo: 'application/pdf', tamano: 2048 }, carpeta: [] });
	});

	it('escribe y lee objetos y listas; otro lote desde lo leído no da conflicto', async () => {
		const s = sheet();
		const p1 = await s.get('p1');
		const { result } = await s.batch({
			creates: [{ key: 'n', values: { nombre: 'Tracker', contrato: PDF, carpeta: [PDF, PNG] } }],
			updates: [{ ...change(p1, 'ficha', PDF), changes: { ficha: { from: null, to: PDF }, carpeta: { from: null, to: [PNG] } } }],
			deletes: []
		});
		expect(result.conflicts).toEqual([]);
		expect(result.created[0]!.row).toMatchObject({ contrato: PDF, carpeta: [PDF, PNG] });
		const after = await s.get('p1');
		expect(after).toMatchObject({ ficha: PDF, carpeta: [PNG] });
		const doc = await db.collection(DOCS).findOne({ _id: 'p1' as never });
		expect(doc?.carpeta).toEqual([PNG]);
		const { result: again } = await s.batch({ creates: [], updates: [change(after, 'carpeta', [PNG, PDF])], deletes: [] });
		expect(again.conflicts).toEqual([]);
		expect((await s.get('p1')).carpeta).toEqual([PNG, PDF]);
	});
});
