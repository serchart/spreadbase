/**
 * El asistente de importación (SB-36) de punta a punta sobre MongoDB, con la
 * forma de Aggy Legacy: el formato «Planes» escribe con `mongoSource` en una
 * tabla dentro de la colección compartida. Si no hay Mongo, se omite.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { SpreadBase, importAgent, inProcessRunner, memoryFileStorage, memoryRunStore, mongoSource, types } from '@spreadbase/server';
import { connectMongo } from '../support/mongo.ts';
import { COLUMNAS, csvPlanes, FILAS_OK, planes } from '../support/planes.ts';

const client = await connectMongo();
const db = client?.db('spreadbase_test') as Db;
const DOCS = 'sb_test_asistente';
const accountId = new ObjectId();
const dataTableId = new ObjectId();

afterAll(async () => {
	await client?.close();
});

beforeEach(async () => {
	if (!client) return;
	await db.collection(DOCS).drop().catch(() => undefined);
	// Otra tabla en la misma colección: el replace no la toca.
	await db.collection(DOCS).insertOne({ accountId, dataTableId: new ObjectId(), modelo: 'AJENO' });
});

function montar() {
	const source = mongoSource({ client: client!, db, collection: DOCS, filter: { accountId, dataTableId } });
	// La hoja de la tabla: une la fuente a sus columnas (y sirve de «filas actuales» al agente).
	const sheet = new SpreadBase({ id: 'planes', columns: { id: { type: types.TEXT, label: 'ID', readOnly: true }, ...COLUMNAS }, source });
	const p = planes(source);
	const runner = inProcessRunner();
	const agent = importAgent({
		destinations: [{ tipo: 'filas', formato: p.formato, actuales: sheet }],
		runs: memoryRunStore(),
		storage: memoryFileStorage(),
		runner
	});
	return { agent, runner, p, sheet };
}

async function corrida(agent: ReturnType<typeof montar>['agent'], runner: ReturnType<typeof montar>['runner'], filas: string[][], modo: 'upsert' | 'replace') {
	const run = await agent.crearCorrida({});
	const [file] = await agent.agregarArchivo(run.id, { bytes: csvPlanes(filas), nombre: 'planes.csv' });
	await agent.fijarDestino(run.id, file!.id, { tipo: 'filas', formato: 'planes', modo });
	await agent.analizar(run.id);
	await runner.vacia();
	await agent.importar(run.id);
	await runner.vacia();
	return (await agent.obtener(run.id)).archivos[0]!;
}

describe.skipIf(!client)('asistente de importación sobre mongoSource', () => {
	it('analizar → review → importar: upsert crea y luego actualiza por identidad; replace deja solo lo nuevo', async () => {
		const { agent, runner, p } = montar();
		const first = await corrida(agent, runner, FILAS_OK, 'upsert');
		expect(first.resultado).toMatchObject({ status: 'ok', ok: 3, resumen: { creados: 3, actualizados: 0 } });
		const docs = await db.collection(DOCS).find({ dataTableId }).toArray();
		expect(docs).toHaveLength(3);
		expect(docs[0]).toMatchObject({ accountId, dataTableId, modelo: 'AVEO HB 2026', precioLista: 319100 });

		// El mismo plan con otro precio: se actualiza, no se duplica.
		const changed = [['AVEO HB 2026', 'A', 'LS Manual', 'CONTADO CON SEGURO', 'RCC', 'HCCM', '$320,000', '-', '$320,000']];
		const second = await corrida(agent, runner, changed, 'upsert');
		expect(second.resultado).toMatchObject({ status: 'ok', ok: 1, resumen: { creados: 0, actualizados: 1 } });
		expect((await p.leer()).find((r) => r.tipoPago === 'CONTADO CON SEGURO')!.precioFinal).toBe(320000);
		expect(await db.collection(DOCS).countDocuments({ dataTableId })).toBe(3);

		const third = await corrida(agent, runner, changed, 'replace');
		expect(third.resultado).toMatchObject({ status: 'ok', ok: 1 });
		expect(await db.collection(DOCS).countDocuments({ dataTableId })).toBe(1);
		// La otra tabla de la colección sigue ahí.
		expect(await db.collection(DOCS).countDocuments({ modelo: 'AJENO' })).toBe(1);
	});

	it('replace con un error no borra nada; la tool leerFilasActuales lee la tabla por la hoja', async () => {
		const { agent, runner } = montar();
		await corrida(agent, runner, FILAS_OK, 'upsert');
		const bad = await corrida(agent, runner, [...FILAS_OK, ['ONIX 2026', 'A', 'LS', 'CONTADO', 'RCC', 'HCCN', '$1', '-', '$2']], 'replace');
		expect(bad.resultado).toMatchObject({ status: 'error', ok: 0, error: 1 });
		expect(await db.collection(DOCS).countDocuments({ dataTableId })).toBe(3);

		const tool = (agent as any).tools(false).find((t: any) => t.nombre === 'leerFilasActuales');
		const run = await agent.crearCorrida({});
		const out = await tool.ejecutar({ formato: 'planes', buscar: 'leasing', limite: 10 }, { corrida: run, archivo: null, contexto: {}, leer: async () => new Uint8Array() });
		expect(out.total).toBe(1);
		expect(out.filas[0]).toMatchObject({ tipoPago: 'LEASING', precioFinal: 270700 });
	});
});
