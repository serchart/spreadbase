/**
 * Subir archivos por el protocolo (SB-30): `POST /upload/:field` en la hoja de
 * casos, columna «Contrato» (`file`, PDF/PNG/JPEG, 2 MB).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SpreadBase, diskStorage, memorySource, sheetUpload, types } from '@spreadbase/server';
import { api } from '../support/api.ts';
import { API_URL, NO_LATENCY } from '../support/env.ts';
import { batch, getCase, reset } from './support.ts';

beforeEach(async () => {
	await reset();
});

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function upload(field: string, bytes: Uint8Array, name: string, type = 'application/octet-stream') {
	const res = await fetch(`${API_URL}/api/cases/upload/${field}`, {
		method: 'POST',
		headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name), ...NO_LATENCY },
		body: bytes
	});
	return { status: res.status, body: await res.json() };
}

describe('subir archivos', () => {
	it('UP-1 · un PDF se guarda con nombre limpio en una carpeta aleatoria y se sirve tal cual', async () => {
		const { status, body } = await upload('contract_file', PDF, 'Contrato Núñez (firmado).pdf', 'application/pdf');
		expect(status).toBe(201);
		expect(body).toMatchObject({ name: 'Contrato-Nunez-firmado.pdf', type: 'application/pdf', size: PDF.length });
		expect(body.url).toMatch(new RegExp(`^${API_URL}/uploads/cases/[A-Za-z0-9_-]{12}/Contrato-Nunez-firmado\\.pdf$`));

		const served = await fetch(body.url);
		expect(served.status).toBe(200);
		expect(served.headers.get('content-type')).toBe('application/pdf');
		expect(served.headers.get('x-content-type-options')).toBe('nosniff');
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(PDF);
	});

	it('UP-2 · el mismo nombre dos veces no choca', async () => {
		const a = await upload('contract_file', PDF, 'contrato.pdf', 'application/pdf');
		const b = await upload('contract_file', PDF, 'contrato.pdf', 'application/pdf');
		expect(a.body.url).not.toBe(b.body.url);
		expect(a.body.url.endsWith('/contrato.pdf') && b.body.url.endsWith('/contrato.pdf')).toBe(true);
	});

	it('UP-3 · el tipo es el del contenido: un HTML con nombre .png o un SVG no pasan', async () => {
		const html = await upload('contract_file', new TextEncoder().encode('<html><script>alert(1)</script></html>'), 'foto.png', 'image/png');
		expect(html).toMatchObject({ status: 415, body: { error: { code: 'file_type_not_allowed' } } });
		const svg = await upload('contract_file', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'logo.pdf');
		expect(svg.status).toBe(415);
		// Un PNG de verdad con extensión .pdf se guarda como .png.
		const png = await upload('contract_file', PNG, 'escaneo.pdf', 'application/pdf');
		expect(png.body).toMatchObject({ name: 'escaneo.png', type: 'image/png' });
	});

	it('UP-4 · más del máximo es 413; vacío, 400', async () => {
		const big = new Uint8Array(2 * 1024 * 1024 + 1);
		big.set(PDF);
		expect((await upload('contract_file', big, 'grande.pdf', 'application/pdf')).body).toMatchObject({ error: { code: 'file_too_large' } });
		expect((await upload('contract_file', new Uint8Array(), 'vacio.pdf', 'application/pdf')).status).toBe(400);
	});

	it('UP-5 · una columna sin upload es 400; una que no existe, 404', async () => {
		expect((await upload('customer_name', PDF, 'x.pdf')).body).toMatchObject({ error: { code: 'upload_not_allowed' } });
		expect((await upload('no_existe', PDF, 'x.pdf')).status).toBe(404);
	});

	it('UP-6 · el esquema dice qué acepta y cuánto, sin el destino', async () => {
		const column = (await api('/api/cases/schema')).body.columns.contract_file;
		expect(column).toMatchObject({ type: 'file', upload: { maxSize: 2 * 1024 * 1024, accept: ['application/pdf', 'image/png', 'image/jpeg'] } });
		expect(column.upload.storage).toBeUndefined();
	});

	it('UP-7 · la URL se guarda con el lote; una que no es http ni ruta, no', async () => {
		const { body } = await upload('contract_file', PDF, 'contrato.pdf', 'application/pdf');
		const row = await getCase('case_000001');
		const ok = await batch({ updates: [{ id: 'case_000001', rowVersion: row.rowVersion, changes: { contract_file: { from: null, to: body.url } } }] });
		expect(ok.status).toBe(200);
		expect((await getCase('case_000001')).contract_file).toBe(body.url);

		const again = await getCase('case_000002');
		const bad = await batch({
			updates: [{ id: 'case_000002', rowVersion: again.rowVersion, changes: { contract_file: { from: null, to: 'javascript:alert(1)' } } }]
		});
		expect(JSON.stringify(bad.body)).toContain('URL de archivo inválida');
		expect((await getCase('case_000002')).contract_file ?? null).toBeNull();
	});

	it('UP-8 · sin la ruta de subida montada, el esquema no anuncia upload (el cliente no muestra «Subir»)', () => {
		const sheet = new SpreadBase({
			id: 'fotos',
			columns: {
				id: { type: types.TEXT, label: 'ID' },
				foto: { type: types.IMAGE, label: 'Foto', upload: { storage: diskStorage({ dir: '/tmp/sb-no-usado', publicUrl: '/f' }) } }
			},
			source: memorySource({ rows: [] })
		});
		expect(sheet.schema().columns.foto!.upload).toBeUndefined();
		sheetUpload(sheet);
		expect(sheet.schema().columns.foto!.upload).toMatchObject({ maxSize: 5 * 1024 * 1024 });
	});
});
