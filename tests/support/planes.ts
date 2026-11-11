/**
 * El formato de prueba del asistente de importación (SB-36): «Planes», como
 * los planes de financiamiento del boletín de GM. La regla de negocio de la
 * app va en `review` (precio de lista + descuento = precio final, sin
 * duplicados) y `apply` escribe en una fuente: upsert por identidad o replace.
 */
import { importFormat, memorySource, types } from '@spreadbase/server';
import type { CellValue, ImportIssue, ImportRow, SheetSource } from '@spreadbase/server';

export const IDENTIDAD = ['modelo', 'paquete', 'version', 'tipoPago', 'codigoGMM', 'codigoGMF'] as const;
export const identidad = (r: Record<string, unknown>) => IDENTIDAD.map((f) => String(r[f] ?? '').toLowerCase()).join('|');

export const COLUMNAS = {
	modelo: { type: types.TEXT, label: 'Modelo', required: true },
	paquete: { type: types.TEXT, label: 'Paquete', aliases: ['Paq', 'Pqt.'] },
	version: { type: types.TEXT, label: 'Versión', required: true },
	tipoPago: { type: types.TEXT, label: 'Tipo de Pago', required: true },
	codigoGMM: { type: types.TEXT, label: 'Código GMM' },
	codigoGMF: { type: types.TEXT, label: 'Código GMF' },
	precioLista: { type: types.NUMBER, label: 'Precio de lista', required: true, aliases: ['MSRP'] },
	descuento: { type: types.NUMBER, label: 'Descuento' },
	precioFinal: { type: types.NUMBER, label: 'Precio Final', required: true },
	cxa0: { type: types.BOOLEAN, label: '0% CXA GMF' },
	seguro: { type: types.TEXT, label: 'Seguro Gratis' },
	tasa: { type: types.TEXT, label: 'Tasa GMF' },
	otros: { type: types.TEXT, label: 'Otros' }
};

/** La fuente donde escribe el formato: en memoria por omisión (las pruebas de Mongo pasan la suya). */
export function planes(destino: SheetSource = memorySource({ rows: [] })) {
	const leer = async () => (await destino.list({ offset: 0, limit: 100_000, sort: null, filters: {}, search: '' })).rows;
	const formato = importFormat({
		id: 'planes',
		label: 'Planes GMF',
		description: 'Planes de financiamiento por modelo, paquete, versión y tipo de pago',
		columns: COLUMNAS,
		review(rows) {
			const issues: ImportIssue[] = [];
			const seen = new Map<string, number>();
			rows.forEach((r, i) => {
				const lista = Number(r.precioLista);
				const final = Number(r.precioFinal);
				const desc = Number(r.descuento ?? 0);
				if (Math.round(lista + desc) !== Math.round(final)) {
					issues.push({ row: i, field: 'precioFinal', level: 'error', message: `${lista} + (${desc}) no da ${final}` });
				}
				const k = identidad(r);
				if (seen.has(k)) issues.push({ row: i, field: 'version', level: 'error', message: `Repetido: igual que la fila ${seen.get(k)! + 1}` });
				else seen.set(k, i);
			});
			return { issues, summary: { modelos: new Set(rows.map((r) => r.modelo)).size } };
		},
		async apply(rows: ImportRow[], ctx) {
			const modo = ctx.context.modo as 'upsert' | 'replace';
			const actuales = await leer();
			if (modo === 'replace') for (const r of actuales) await destino.remove(String(r.id));
			const porIdentidad = new Map(modo === 'replace' ? [] : actuales.map((r) => [identidad(r), r]));
			let creados = 0;
			let actualizados = 0;
			for (const r of rows) {
				const values = Object.fromEntries(Object.keys(COLUMNAS).map((f) => [f, (r[f] ?? null) as CellValue]));
				const actual = porIdentidad.get(identidad(r));
				if (actual) {
					await destino.update(String(actual.id), values);
					actualizados++;
				} else {
					await destino.insert(values);
					creados++;
				}
			}
			return { summary: { creados, actualizados, modo } };
		}
	});
	return { formato, destino, leer };
}

/** Un CSV de planes (encabezados como en el boletín). */
export const csvPlanes = (filas: string[][]) =>
	Buffer.from(
		[['Modelo', 'Paq', 'Versión', 'Tipo de Pago', 'Código GMM', 'Código GMF', 'MSRP', 'Descuento', 'Precio Final'], ...filas]
			.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))
			.join('\n'),
		'utf8'
	);

export const FILAS_OK = [
	['AVEO HB 2026', 'A', 'LS Manual', 'CONTADO CON SEGURO', 'RCC', 'HCCM', '$319,100', '-', '$319,100'],
	['AVEO HB 2026', 'A', 'LS Manual', 'GMF TASA SUBSIDIADA CON SEGURO', 'RCC', 'HCAM', '$319,100', '($60,000)', '$259,100'],
	['AVEO HB 2026', 'B', 'LT Manual', 'LEASING', 'RCC', 'LCCN', '$346,500', '($75,800)', '$270,700']
];
