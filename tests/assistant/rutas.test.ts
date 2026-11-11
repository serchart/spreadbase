/**
 * Las rutas del asistente (`importAssistantRoutes`, SB-36) por HTTP, como las
 * va a usar el cliente: crear la corrida, subir archivos (un zip se abre en el
 * servidor), fijar destino, analizar, leer el progreso, el detalle e importar.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { errorHandler, importAgent, importAssistantRoutes, inProcessRunner, memoryFileStorage, memoryRunStore } from '@spreadbase/server';
import type { ImportAssistantConfig, ImportFileRows, ImportRunFileView, ImportRunView } from '@spreadbase/server';
import { csvPlanes, FILAS_OK, planes } from '../support/planes.ts';
import { zip } from '../support/zip.ts';

const p = planes();
const runner = inProcessRunner();
const agent = importAgent({
	destinations: [{ tipo: 'filas', formato: p.formato, modos: ['upsert', 'replace'], modo: 'replace' }, { tipo: 'descartar' }],
	runs: memoryRunStore(),
	storage: memoryFileStorage(),
	runner,
	owner: (ctx) => (ctx.usuario as string) ?? null,
	limits: { maxArchivoMB: 1 }
});
const app = express();
app.use('/api/import-assistant', importAssistantRoutes(agent, { context: (req) => ({ usuario: req.get('X-User') ?? 'ana' }) }));
app.use(errorHandler);
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/import-assistant`;
afterAll(() => new Promise((resolve) => server.close(resolve)));

async function call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
	const raw = Buffer.isBuffer(body);
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { ...(body === undefined || raw ? {} : { 'content-type': 'application/json' }), ...headers },
		body: body === undefined ? undefined : raw ? new Uint8Array(body) : JSON.stringify(body)
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}
const subir = (run: string, bytes: Buffer, nombre: string, carpeta?: string) =>
	call<ImportRunFileView[]>('POST', `/runs/${run}/files`, bytes, { 'X-File-Name': encodeURIComponent(nombre), ...(carpeta ? { 'X-Folder': encodeURIComponent(carpeta) } : {}) });

describe('importAssistantRoutes', () => {
	it('config: destinos (con sus modos), límites y la bienvenida del chat', async () => {
		const { body } = await call<ImportAssistantConfig>('GET', '/config');
		expect(body.destinos).toEqual([
			{ tipo: 'filas', formato: 'planes', label: 'Planes GMF', description: 'Planes de financiamiento por modelo, paquete, versión y tipo de pago', modos: ['upsert', 'replace'], modo: 'replace' },
			{ tipo: 'descartar', label: 'Descartar' }
		]);
		expect(body.bienvenida).toMatch(/^Hola, soy el asistente de importación\./);
		expect(body.bienvenida).toContain('Destinos posibles:\n• Filas → Planes GMF (actualizar o agregar, reemplazar todo)\n• Descartar');
		expect(body.limites).toEqual({ maxArchivoMB: 1, maxLoteMB: 200, retencionDias: 30, tipos: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'heic', 'xlsx', 'csv', 'txt', 'json', 'md', 'docx', 'zip'] });
	});

	it('de punta a punta: corrida, zip con carpetas, destino, análisis, detalle e importación', async () => {
		const created = await call<ImportRunView>('POST', '/runs', { instrucciones: 'Planes de octubre' });
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({ estado: 'nueva', instrucciones: 'Planes de octubre', propietario: 'ana', archivos: [], chat: [] });
		const id = created.body.id;

		// Un zip se abre en el servidor: cada archivo con su ruta en «carpeta».
		const paquete = zip([
			{ path: 'octubre/planes.csv', bytes: csvPlanes(FILAS_OK) },
			{ path: 'octubre/notas/leeme.txt', bytes: 'Vigencia octubre', guardar: true },
			{ path: '__MACOSX/._planes.csv', bytes: 'basura' },
			{ path: 'octubre/programa.exe', bytes: 'MZ' }
		]);
		const up = await subir(id, paquete, 'Boletín.zip', 'descargas');
		expect(up.status).toBe(201);
		expect(up.body.map((f) => [f.nombre, f.carpeta, f.tipo, f.tamano])).toEqual([
			['planes.csv', 'descargas/Boletín/octubre', 'text/csv', csvPlanes(FILAS_OK).length],
			['leeme.txt', 'descargas/Boletín/octubre/notas', 'text/plain', 16]
		]);
		const [csv, txt] = up.body;

		// Otra persona no la ve.
		expect((await call('GET', `/runs/${id}`, undefined, { 'X-User': 'beto' })).status).toBe(404);

		// La persona fija el destino de la nota antes de analizar.
		const fixed = await call<ImportRunView>('PUT', `/runs/${id}/files/${txt!.id}/destination`, { destino: { tipo: 'descartar', motivo: 'solo notas' } });
		expect(fixed.body.archivos[1]).toMatchObject({ destino: { tipo: 'descartar', motivo: 'solo notas' }, destinoFijadoPorUsuario: true });
		expect((await call('PUT', `/runs/${id}/files/${txt!.id}/destination`, { destino: { tipo: 'filas', formato: 'nada', modo: 'upsert' } })).status).toBe(400);

		// Instrucción para un archivo; null la quita.
		const withInstruction = await call<ImportRunView>('PUT', `/runs/${id}/files/${csv!.id}/instruction`, { instruccion: 'solo octubre' });
		expect(withInstruction.body.archivos[0]!.instruccion).toBe('solo octubre');
		expect((await call('PUT', `/runs/${id}/files/${csv!.id}/instruction`, { instruccion: 3 })).status).toBe(400);
		expect((await call<ImportRunView>('PUT', `/runs/${id}/files/${txt!.id}/instruction`, { instruccion: null })).body.archivos[1]!.instruccion).toBeNull();

		const queued = await call<ImportRunView>('POST', `/runs/${id}/analyze`, {});
		expect(queued.status).toBe(202);
		expect(queued.body.estado).toBe('analizando');
		expect(queued.body.archivos.map((f) => f.estado)).toEqual(['en_cola', 'en_cola']);
		await runner.vacia();

		const run = (await call<ImportRunView>('GET', `/runs/${id}`)).body;
		expect(run.estado).toBe('lista');
		expect(run.archivos[0]).toMatchObject({ estado: 'analizado', destino: { tipo: 'filas', formato: 'planes', modo: 'replace' }, totalFilas: 3, totalErrores: 0 });
		expect(run.archivos[0]).not.toHaveProperty('filas');
		expect(run.archivos[1]).toMatchObject({ estado: 'analizado', analisis: 'Descartado: solo notas' });

		const rows = (await call<ImportFileRows>('GET', `/runs/${id}/files/${csv!.id}/rows`)).body;
		expect(rows.schema!.id).toBe('planes');
		expect(rows.filas).toHaveLength(3);
		expect(rows.resumen).toMatchObject({ formato: 'planes', rows: 3 });

		// Corregir en el Detalle: se revisa otra vez.
		const edited = await call<ImportFileRows>('PUT', `/runs/${id}/files/${csv!.id}/rows`, { filas: [{ ...rows.filas[0], precioFinal: 1 }, ...rows.filas.slice(1)] });
		expect(edited.body.issues).toEqual([expect.objectContaining({ row: 0, field: 'precioFinal', level: 'error' })]);
		await call('PUT', `/runs/${id}/files/${csv!.id}/rows`, { filas: rows.filas });

		const importing = await call<ImportRunView>('POST', `/runs/${id}/import`);
		expect(importing.status).toBe(202);
		expect(importing.body.estado).toBe('importando');
		await runner.vacia();
		const done = (await call<ImportRunView>('GET', `/runs/${id}`)).body;
		expect(done.estado).toBe('terminada');
		expect(done.archivos.map((f) => f.resultado?.status)).toEqual(['ok', 'ok']);
		expect(await p.leer()).toHaveLength(3);
		// Una corrida importada no recibe más archivos.
		expect((await subir(id, csvPlanes(FILAS_OK), 'otro.csv')).status).toBe(409);

		const list = (await call<ImportRunView[]>('GET', '/runs')).body;
		expect(list.map((r) => r.id)).toContain(id);
	});

	it('errores claros: archivo grande (413), tipo no admitido (415), sin nombre (400), chat vacío (400), corrida ajena (404)', async () => {
		const { body: run } = await call<ImportRunView>('POST', '/runs', {});
		expect((await subir(run.id, Buffer.alloc(1_100_000, 65), 'grande.txt')).body).toMatchObject({ error: { code: 'file_too_large' } });
		expect((await subir(run.id, Buffer.alloc(10, 1), 'raro.bin')).status).toBe(415);
		expect((await call('POST', `/runs/${run.id}/files`, Buffer.from('a'))).status).toBe(400);
		expect((await call('POST', `/runs/${run.id}/chat`, { texto: ' ' })).status).toBe(400);
		expect((await call('POST', `/runs/${run.id}/analyze`, {})).status).toBe(400);
		expect((await call('GET', '/runs/no-existe')).status).toBe(404);
	});

	it('chat sin modelo: el mensaje pasa a las instrucciones y lo dice', async () => {
		const { body: run } = await call<ImportRunView>('POST', '/runs', { instrucciones: 'base' });
		const { body } = await call('POST', `/runs/${run.id}/chat`, { texto: 'solo los cotizables' });
		expect(body.mensaje.rol).toBe('agente');
		expect(body.corrida.instrucciones).toBe('base\nsolo los cotizables');
		expect(body.corrida.chat.map((m: any) => m.texto)).toEqual(['solo los cotizables', body.mensaje.texto]);
	});
});
