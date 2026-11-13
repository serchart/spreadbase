/**
 * Columnas `file` y `folder` (SB-38) contra una base real: el valor canónico
 * `{ url, nombre, tipo, tamano }` (y su lista) se guarda como JSON —en `jsonb`
 * o en `text`— y se lee de vuelta como objeto; una URL suelta (SB-30) sigue
 * siendo texto. La huella de la fila (SB-4) y la concurrencia por campo
 * funcionan sobre el JSON.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SpreadBase, postgresSource, types } from '@spreadbase/server';
import type { FileRef, Row } from '@spreadbase/server';
import { createPool } from '../support/postgres.ts';

const pool = createPool();
const IDEMPOTENCY = 'sb_test_files_idempotency';

afterAll(async () => {
	await pool.end();
});

beforeEach(async () => {
	await pool.query(`
		DROP TABLE IF EXISTS sb_test_files, ${IDEMPOTENCY};
		CREATE TABLE sb_test_files (
			id       text PRIMARY KEY,
			nombre   text NOT NULL,
			contrato text,
			ficha    jsonb,
			carpeta  jsonb,
			anexos   text
		);
		INSERT INTO sb_test_files VALUES
			('p1', 'Aveo', '/uploads/docs/a1/contrato.pdf', NULL, NULL, NULL),
			('p2', 'Onix', NULL, '{"url":"/uploads/docs/b2/ficha.pdf","nombre":"ficha.pdf","tipo":"application/pdf","tamano":2048}', '[]', NULL);
	`);
});

let seq = 10;
const sheet = () =>
	new SpreadBase({
		id: 'archivos',
		allowInsert: true,
		columns: {
			id: { type: types.TEXT, label: 'ID' },
			nombre: { type: types.TEXT, label: 'Nombre', required: true },
			contrato: { type: types.FILE, label: 'Contrato' },
			ficha: { type: types.FILE, label: 'Ficha' },
			carpeta: { type: types.FOLDER, label: 'Carpeta' },
			anexos: { type: types.FOLDER, label: 'Anexos (texto)' }
		},
		source: postgresSource({ pool, table: 'sb_test_files', idempotencyTable: IDEMPOTENCY, createId: () => `p${++seq}` })
	});

const PDF: FileRef = { url: '/uploads/docs/c3/manual.pdf', name: 'manual.pdf', type: 'application/pdf', size: 10_240 };
const PNG: FileRef = { url: '/uploads/docs/d4/frente.png', name: 'frente.png', type: 'image/png', size: 512 };
const change = (row: Row, field: string, to: unknown) => ({ id: String(row.id), rowVersion: row.rowVersion, changes: { [field]: { from: row[field] as never, to: to as never } } });

describe('file y folder en Postgres (SB-38)', () => {
	it('lee: el JSON como objeto (jsonb), una lista vacía y la URL suelta de SB-30 como texto', async () => {
		const s = sheet();
		const [p1, p2] = (await s.list({ offset: 0, limit: 10, sort: null, filters: {}, search: '' })).rows;
		expect(p1).toMatchObject({ contrato: '/uploads/docs/a1/contrato.pdf', ficha: null, carpeta: null });
		expect(p2).toMatchObject({ ficha: { url: '/uploads/docs/b2/ficha.pdf', nombre: 'ficha.pdf', tipo: 'application/pdf', tamano: 2048 }, carpeta: [] });
	});

	it('escribe objetos y listas en jsonb y en text, y los lee iguales; la huella cambia y no hay conflicto falso', async () => {
		const s = sheet();
		const p1 = await s.get('p1');
		const { result } = await s.batch({
			creates: [{ key: 'n', values: { nombre: 'Tracker', contrato: PDF, carpeta: [PDF, PNG], anexos: [PNG] } }],
			updates: [{ ...change(p1, 'ficha', PDF), changes: { ficha: { from: null, to: PDF }, carpeta: { from: null, to: [PNG] }, anexos: { from: null, to: [PDF, PNG] } } }],
			deletes: []
		});
		expect(result.conflicts).toEqual([]);
		expect(result.created[0]!.row).toMatchObject({ contrato: PDF, carpeta: [PDF, PNG], anexos: [PNG] });
		const after = await s.get('p1');
		expect(after).toMatchObject({ ficha: PDF, carpeta: [PNG], anexos: [PDF, PNG] });
		expect(after.rowVersion).not.toBe(p1.rowVersion);
		// En la tabla: jsonb de verdad y JSON en la columna de texto.
		const raw = (await pool.query(`SELECT jsonb_typeof(carpeta) AS t, anexos FROM sb_test_files WHERE id = 'p1'`)).rows[0];
		expect(raw.t).toBe('array');
		expect(JSON.parse(raw.anexos)).toEqual([PDF, PNG]);
		// Otro lote que parte del objeto leído: el `from` coincide con lo guardado (sin conflicto).
		const { result: again } = await s.batch({ creates: [], updates: [change(after, 'carpeta', [PNG, PDF])], deletes: [] });
		expect(again.conflicts).toEqual([]);
		expect((await s.get('p1')).carpeta).toEqual([PNG, PDF]);
	});

	it('valida: una carpeta debe ser lista de archivos con URL; un archivo, URL o { url, nombre }', async () => {
		const s = sheet();
		const p1 = await s.get('p1');
		await expect(s.batch({ creates: [], updates: [change(p1, 'carpeta', 'no-es-lista')], deletes: [] })).rejects.toMatchObject({
			status: 400,
			details: [{ path: 'updates[0].changes.carpeta', message: 'Debe ser una lista de archivos' }]
		});
		await expect(s.batch({ creates: [], updates: [change(p1, 'carpeta', [{ url: 'javascript:alert(1)', nombre: 'x' }])], deletes: [] })).rejects.toMatchObject({
			details: [{ path: 'updates[0].changes.carpeta', message: 'URL de archivo inválida' }]
		});
		await expect(s.batch({ creates: [], updates: [change(p1, 'contrato', { url: '/a/b.pdf', nombre: '' })], deletes: [] })).rejects.toMatchObject({
			details: [{ path: 'updates[0].changes.contrato', message: 'El archivo necesita nombre' }]
		});
	});

	it('el esquema anuncia folder y una carpeta no se filtra', async () => {
		const s = sheet();
		expect(s.schema().columns.carpeta).toEqual({ type: 'folder', label: 'Carpeta' });
		await expect(s.values('carpeta', { offset: 0, limit: 10, sort: null, filters: {}, search: '' })).rejects.toMatchObject({ status: 404 });
	});
});
