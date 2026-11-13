/**
 * Catálogo con fotos (SB-38, SB-29): una carpeta por modelo cuyo **principal**
 * —el primero de la lista— es la miniatura del modelo. En memoria, montado en
 * /api/catalog.
 *
 * - «Fotos» es una columna `folder`: la celda muestra el principal (miniatura
 *   si es imagen, ícono de su tipo si no) y el número de archivos; en el panel,
 *   «Hacer principal» pasa un archivo al primer lugar.
 * - «Modelo» lleva `avatar: { image: 'photos' }`: la foto principal de la misma
 *   fila (si el principal no es imagen, la primera imagen de la carpeta).
 * - En «Unidades», «Modelo» es un `lookup` con el mismo `avatar.image`: el
 *   servidor manda en `images` la foto principal del modelo elegido.
 *
 * Las fotos son PNG de un color generados aquí mismo, servidos en
 * /api/catalog/files/<nombre>: el ejemplo no depende de archivos en disco.
 */
import { Router } from 'express';
import { crc32, deflateSync } from 'node:zlib';
import { SpreadBase, memorySource, sheetRouter, types } from '@spreadbase/server';
import { env } from '../../config/env.ts';

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** Un PNG de 8×8 de un solo color. */
function solidPng([r, g, b]: [number, number, number]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body), body.length + 4);
		return out;
	};
	const size = 8;
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const line = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => line)))),
		chunk('IEND', Buffer.alloc(0))
	]);
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/** Los archivos del ejemplo, por nombre. */
const FILES: Record<string, { type: string; bytes: Buffer }> = {
	'onix-frente.png': { type: 'image/png', bytes: solidPng([220, 38, 38]) },
	'onix-lateral.png': { type: 'image/png', bytes: solidPng([37, 99, 235]) },
	'aveo-interior.png': { type: 'image/png', bytes: solidPng([22, 163, 74]) },
	'ficha.pdf': { type: 'application/pdf', bytes: PDF },
	'precios.xlsx': { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: Buffer.from('PK') }
};

const ref = (name: string) => ({
	url: `${env.publicUrl}/api/catalog/files/${name}`,
	name,
	type: FILES[name]!.type,
	size: FILES[name]!.bytes.length
});

/** Un archivo guardado en la forma obsoleta (≤ 0.1.3), `{ url, nombre, tipo, tamano }`: se sigue leyendo. */
const legacyRef = (name: string) => {
	const { url, type, size } = ref(name);
	return { url, nombre: name, tipo: type, tamano: size };
};

/**
 * Cuatro casos de la miniatura: principal imagen (Onix), principal PDF con una
 * imagen después (Aveo), sin imágenes (Tracker) y sin carpeta (Groove).
 */
const seedModels = () => [
	{ id: 'md_1', model: 'Onix 2026', photos: [ref('onix-frente.png'), ref('onix-lateral.png'), ref('ficha.pdf')] },
	// Guardada antes de 0.1.4, en la forma obsoleta: la celda y la miniatura la leen igual.
	{ id: 'md_2', model: 'Aveo 2026', photos: [legacyRef('ficha.pdf'), legacyRef('aveo-interior.png')] },
	{ id: 'md_3', model: 'Tracker 2026', photos: [ref('precios.xlsx'), ref('ficha.pdf')] },
	{ id: 'md_4', model: 'Groove 2026', photos: null }
];

const seedUnits = () => [
	{ id: 'un_1', vin: 'VIN-0001', model_id: 'md_1' },
	{ id: 'un_2', vin: 'VIN-0002', model_id: 'md_2' },
	{ id: 'un_3', vin: 'VIN-0003', model_id: 'md_3' },
	{ id: 'un_4', vin: 'VIN-0004', model_id: 'md_4' }
];

const modelsSource = memorySource({ rows: seedModels(), createId: (n) => `md_${n}` });
const unitsSource = memorySource({ rows: seedUnits(), createId: (n) => `un_${n}` });
const modelRows = () => modelsSource.all();

const models = new SpreadBase({
	id: 'catalog-models',
	allowInsert: true,
	columns: {
		id: { type: types.TEXT, label: 'ID', readOnly: true, width: 80 },
		// La foto principal de «Fotos», de la misma fila.
		model: { type: types.TEXT, label: 'Modelo y año', required: true, width: 200, avatar: { image: 'photos', shape: 'square' } },
		photos: { type: types.FOLDER, label: 'Fotos', width: 260 }
	},
	source: modelsSource
});

const units = new SpreadBase({
	id: 'catalog-units',
	allowInsert: true,
	columns: {
		id: { type: types.TEXT, label: 'ID', readOnly: true, width: 80 },
		vin: { type: types.TEXT, label: 'VIN', width: 140 },
		model_id: {
			type: types.LOOKUP,
			label: 'Modelo',
			width: 220,
			// Del modelo elegido: el servidor manda la foto principal de su carpeta (`images`).
			avatar: { image: 'photos', shape: 'square' },
			lookup: {
				value: 'id',
				display: 'model',
				columns: { model: { type: types.TEXT, label: 'Modelo', width: 200 } },
				search: (q, { offset, limit }) => {
					const found = modelRows().filter((m) => !q || fold(String(m.model)).includes(fold(q)));
					return { rows: found.slice(offset, offset + limit), total: found.length };
				},
				byIds: (ids) => modelRows().filter((m) => ids.includes(String(m.id)))
			}
		}
	},
	source: unitsSource
});

/**
 * Agencias con varias marcas (SB-41): «Marcas» es una selección múltiple. La
 * celda muestra cada marca como etiqueta; el filtro del encabezado, «contiene
 * alguna de» las elegidas, con cuántas agencias tiene cada una.
 */
export const BRANDS = [
	{ value: 'byd', label: 'BYD' },
	{ value: 'chevrolet', label: 'Chevrolet' },
	{ value: 'honda', label: 'Honda' },
	{ value: 'kia', label: 'Kia' },
	{ value: 'mazda', label: 'Mazda' },
	{ value: 'nissan', label: 'Nissan' },
	{ value: 'toyota', label: 'Toyota' },
	{ value: 'volkswagen', label: 'Volkswagen' },
	{ value: 'mg', label: 'MG' },
	{ value: 'jac', label: 'JAC' }
];

const seedAgencies = () => [
	{ id: 'ag_1', name: 'Agencia Centro', brands: ['byd', 'honda'] },
	{ id: 'ag_2', name: 'Agencia Norte', brands: ['chevrolet'] },
	{ id: 'ag_3', name: 'Agencia Sur', brands: ['byd', 'chevrolet', 'kia', 'mazda', 'nissan', 'toyota'] },
	{ id: 'ag_4', name: 'Agencia Poniente', brands: null },
	{ id: 'ag_5', name: 'Agencia Oriente', brands: ['honda', 'toyota'] }
];

const agenciesSource = memorySource({ rows: seedAgencies(), createId: (n) => `ag_${n}` });

const agencies = new SpreadBase({
	id: 'catalog-agencies',
	allowInsert: true,
	columns: {
		id: { type: types.TEXT, label: 'ID', readOnly: true, width: 80 },
		name: { type: types.TEXT, label: 'Agencia', required: true, width: 180 },
		brands: { type: types.MULTISELECT, label: 'Marcas', width: 220, options: BRANDS }
	},
	source: agenciesSource
});

export function createCatalogExample({ devRoutes = false } = {}): Router {
	const router = Router();
	if (devRoutes) {
		router.post('/reset', (_req, res) => {
			modelsSource.reset(seedModels());
			unitsSource.reset(seedUnits());
			agenciesSource.reset(seedAgencies());
			res.json({ ok: true });
		});
	}
	router.get('/files/:name', (req, res) => {
		const file = FILES[req.params.name];
		if (!file) return void res.status(404).end();
		res.type(file.type).send(file.bytes);
	});
	router.use('/models', sheetRouter(models));
	router.use('/units', sheetRouter(units));
	router.use('/agencies', sheetRouter(agencies));
	return router;
}
