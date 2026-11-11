/**
 * La tabla destino del ejemplo: «Planes GMF», en memoria. La hoja sirve para
 * ver lo importado (`/api/import-assistant/planes`) y de «filas actuales» para
 * el agente; el formato SB-34 declara las columnas, la regla de negocio
 * (`review`) y cómo se publica (`apply`: upsert por identidad o replace).
 */
import { SpreadBase, importFormat, memorySource, types } from '@spreadbase/server';
import { uploadsFor } from '../../common/uploads.ts';
import type { CellValue, ImportIssue, ImportRow } from '@spreadbase/server';

const COLUMNAS = {
	modelo: { type: types.TEXT, label: 'Modelo', required: true, width: 200 },
	paquete: { type: types.TEXT, label: 'Paquete', aliases: ['Paq', 'Pqt.'], width: 80 },
	version: { type: types.TEXT, label: 'Versión', required: true, width: 160 },
	tipoPago: { type: types.TEXT, label: 'Tipo de Pago', required: true, width: 220 },
	codigoGMM: { type: types.TEXT, label: 'Código GMM', width: 90 },
	codigoGMF: { type: types.TEXT, label: 'Código GMF', width: 90 },
	precioLista: { type: types.NUMBER, label: 'Precio de lista', required: true, aliases: ['MSRP'], prefix: '$', width: 120 },
	descuento: { type: types.NUMBER, label: 'Descuento', prefix: '$', width: 110 },
	precioFinal: { type: types.NUMBER, label: 'Precio Final', required: true, prefix: '$', width: 120 },
	cxa0: { type: types.BOOLEAN, label: '0% CXA GMF', width: 90 },
	seguro: { type: types.TEXT, label: 'Seguro Gratis', width: 130 },
	tasa: { type: types.TEXT, label: 'Tasa GMF', width: 200 },
	otros: { type: types.TEXT, label: 'Otros', width: 200 }
};

/** Lo que identifica un plan: la llave del staging (§8.3.1) y de `apply`. */
export const IDENTIDAD = ['modelo', 'paquete', 'version', 'tipoPago', 'codigoGMM', 'codigoGMF'];
const identidad = (r: Record<string, unknown>) => IDENTIDAD.map((f) => String(r[f] ?? '').toLowerCase()).join('|');

/**
 * Los planes «de septiembre» con que arranca el ejemplo: al soltar los de
 * octubre, el staging muestra qué cambia (precio), qué es nuevo y, con
 * reemplazar, qué desaparece.
 */
export const PLANES_INICIALES: Record<string, CellValue>[] = [
	{ modelo: 'AVEO HB 2026', paquete: 'A', version: 'LS Manual', tipoPago: 'CONTADO CON SEGURO', codigoGMM: 'RCC', codigoGMF: 'HCCM', precioLista: 319100, descuento: null, precioFinal: 319100 },
	{ modelo: 'AVEO HB 2026', paquete: 'A', version: 'LS Manual', tipoPago: 'GMF TASA SUBSIDIADA CON SEGURO', codigoGMM: 'RCC', codigoGMF: 'HCAM', precioLista: 319100, descuento: -60000, precioFinal: 259100 },
	{ modelo: 'ONIX 2026', paquete: 'A', version: 'LS', tipoPago: 'CONTADO CON SEGURO', codigoGMM: 'RCC', codigoGMF: 'HCCM', precioLista: 299900, descuento: null, precioFinal: 299900 }
].map((r) => ({ cxa0: null, seguro: null, tasa: null, otros: null, imagen: null, archivos: null, fichaTecnica: null, ...r }));

/** Donde se guardan los archivos que se suben desde las celdas de la hoja (SB-30). */
const archivos = uploadsFor('planes');

export const planesSource = memorySource({ rows: [], createId: (n) => `pl_${String(n).padStart(5, '0')}` });
planesSource.reset(PLANES_INICIALES.map((r, i) => ({ id: `pl_${String(i + 1).padStart(5, '0')}`, ...r })));

export const planesSheet = new SpreadBase({
	id: 'planes',
	allowInsert: true,
	allowDelete: true,
	columns: {
		id: { type: types.TEXT, label: 'ID', readOnly: true, width: 90 },
		...COLUMNAS,
		// Los archivos de cada plan (SB-38): su foto, su carpeta y su ficha técnica en texto (md o JSON).
		imagen: { type: types.IMAGE, label: 'Imagen', width: 64, upload: { storage: archivos, maxSize: '5mb' } },
		archivos: {
			type: types.FOLDER,
			label: 'Archivos',
			width: 220,
			upload: { storage: archivos, maxSize: '20mb', accept: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv'] }
		},
		fichaTecnica: { type: types.TEXT, label: 'Ficha técnica', width: 240, multiline: true },
		// La regla de la tabla también al guardar la hoja (solo en el servidor): lista + descuento = final.
		precioFinal: {
			...COLUMNAS.precioFinal,
			validate: (value, row) => {
				const esperado = Number(row.precioLista) + Number(row.descuento ?? 0);
				return value !== null && Math.round(esperado) !== Math.round(Number(value)) ? `Debería ser ${esperado} (lista + descuento)` : null;
			}
		}
	},
	source: planesSource
});

export const planesFormat = importFormat({
	id: 'planes',
	label: 'Planes GMF',
	description: 'Planes de financiamiento por modelo, paquete, versión y tipo de pago (boletín mensual de GM)',
	columns: COLUMNAS,
	review(rows) {
		const issues: ImportIssue[] = [];
		const seen = new Map<string, number>();
		rows.forEach((r, i) => {
			// La regla de la tabla: precio de lista + descuento = precio final.
			const esperado = Number(r.precioLista) + Number(r.descuento ?? 0);
			if (Math.round(esperado) !== Math.round(Number(r.precioFinal))) {
				issues.push({ row: i, field: 'precioFinal', level: 'error', message: `Debería ser ${esperado} (lista + descuento)` });
			}
			const k = identidad(r);
			if (seen.has(k)) issues.push({ row: i, field: 'version', level: 'error', message: `Repetido: igual que la fila ${seen.get(k)! + 1}` });
			else seen.set(k, i);
		});
		const existentes = new Set(planesSource.all().map(identidad));
		return { issues, summary: { modelos: new Set(rows.map((r) => r.modelo)).size, nuevos: rows.filter((r) => !existentes.has(identidad(r))).length } };
	},
	apply(rows: ImportRow[], ctx) {
		const modo = ctx.context.modo === 'replace' ? 'replace' : 'upsert';
		if (modo === 'replace') for (const r of [...planesSource.all()]) planesSource.remove(String(r.id));
		const actuales = new Map(planesSource.all().map((r) => [identidad(r), r]));
		let creados = 0;
		let actualizados = 0;
		for (const r of rows) {
			const values = Object.fromEntries(Object.keys(COLUMNAS).map((f) => [f, (r[f] ?? null) as CellValue]));
			const actual = actuales.get(identidad(r));
			if (actual) {
				planesSource.update(String(actual.id), values);
				actualizados++;
			} else {
				planesSource.insert(values);
				creados++;
			}
		}
		return { summary: { creados, actualizados, modo } };
	}
});
