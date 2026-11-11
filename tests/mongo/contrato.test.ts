/**
 * El kit de contrato (SB-26, `@spreadbase/testing`) contra una hoja sobre
 * `mongoSource`, servida por HTTP con `sheetRouter` en un puerto libre: la
 * forma en que la montaría una app. La hoja es una tabla dentro de la
 * colección compartida (`{ accountId, dataTableId }`, como Aggy Legacy) y el
 * «otro proceso» escribe con el driver directo. Si no hay Mongo, se omite.
 */
import { afterAll, describe, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { SpreadBase, errorHandler, mongoSource, sheetRouter, types } from '@spreadbase/server';
import { edit, sheetContract } from '@spreadbase/testing';
import { connectMongo } from '../support/mongo.ts';

const client = await connectMongo();

if (!client) {
	describe.skip('contrato de la hoja · clientes (Mongo)', () => it('sin MongoDB', () => undefined));
} else {
	const db: Db = client.db('spreadbase_test');
	const COLLECTION = 'sb_test_contract';
	const accountId = new ObjectId();
	const dataTableId = new ObjectId();

	const sheet = new SpreadBase({
		id: 'clientes',
		allowInsert: true,
		allowDelete: true,
		columns: {
			id: { type: types.TEXT, label: 'ID', readOnly: true },
			name: { type: types.TEXT, label: 'Nombre', required: true, maxLength: 120 },
			tier: {
				type: types.SELECT,
				label: 'Nivel',
				options: ['bronce', 'plata', 'oro'].map((v) => ({ value: v, label: v }))
			},
			active: { type: types.BOOLEAN, label: 'Activo' }
		},
		source: mongoSource({ client, db, collection: COLLECTION, filter: { accountId, dataTableId }, idempotencyCollection: 'sb_test_contract_idem' })
	});

	const app = express();
	app.use(express.json());
	app.use('/api/clientes', sheetRouter(sheet));
	app.use(errorHandler);
	// Escucha antes de registrar el contrato: el kit lee la URL al llamarlo.
	const server: Server = app.listen(0);
	await new Promise((resolve) => server.once('listening', resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/clientes`;

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
		await client.close();
	});

	sheetContract({
		name: 'clientes (Mongo)',
		url,
		reset: async () => {
			await db.collection(COLLECTION).deleteMany({});
			await db.collection(COLLECTION).insertMany([
				{ accountId, dataTableId, name: 'Transportes del Norte', tier: 'plata', active: true },
				{ accountId, dataTableId, name: 'Grúas Azules', tier: 'oro', active: false },
				// Otra tabla en la misma colección.
				{ accountId, dataTableId: new ObjectId(), name: 'Ajeno', tier: 'bronce', active: true }
			]);
		},
		edits: [edit.text('name'), edit.option('tier')],
		external: (id, field) =>
			db.collection(COLLECTION).updateOne({ _id: new ObjectId(id) }, [{ $set: { [field]: { $concat: [`$${field}`, ' (worker)'] } } }])
	});
}
