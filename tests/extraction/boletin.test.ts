/**
 * El caso real de SB-36: un boletín de planes de financiamiento (24 páginas
 * de tablas). Es de un cliente: no está en el repo. Se usa si
 * `EXTRACTION_PDF` apunta a él (en `.env` o en el entorno); si no, se omite.
 *
 *     EXTRACTION_PDF="/ruta/01 Oct Planes Chevrolet MY26.pdf" npm test -- --project extraccion
 *
 * Lo difícil de su capa de texto: una columna auxiliar oculta (L/N/U/A), un
 * «AVEO HB 2026» recortado que reaparece encimado en todas las páginas, celdas
 * de dos renglones («Factor de Arrendamiento:» / «16.09%»), celdas combinadas
 * («Modelo», «Otros»), una fórmula de Excel oculta en p. 16 («=I F») y
 * palomitas en Wingdings 2 («P»).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { compararExtracciones, extraerConLLM, extraerDeterminista } from '@spreadbase/server';
import type { BloqueExtraido, Extraccion, ImportLLM } from '@spreadbase/server';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (!process.env.EXTRACTION_PDF && existsSync(envFile)) process.loadEnvFile(envFile);
const file = process.env.EXTRACTION_PDF;
const available = Boolean(file && existsSync(file));

describe.skipIf(!available)('boletín real (EXTRACTION_PDF)', () => {
	let p: Extraccion;
	const tabla = (pagina: number) => p.bloques.find((b) => b.pagina === pagina && b.tipo === 'tabla') as BloqueExtraido;

	beforeAll(async () => {
		p = await extraerDeterminista(readFileSync(file!), { nombre: 'boletin.pdf' });
	}, 60_000);

	it('página 2 (Aveo HB y NB): encabezados, celdas combinadas, celdas de dos renglones, palomitas y sin la columna oculta', () => {
		const t = tabla(2);
		expect(t.titulo).toBe('GUIA RAPIDA PARA VENDEDOR APLICABLES A PARTIR DEL 1 DE OCTUBRE DE 2026');
		expect(t.encabezados).toEqual([
			'Modelo',
			'Paq',
			'Versión',
			'Tipo de Pago',
			'Código GMM',
			'Código GMF',
			'MSRP',
			'Descuento',
			'Precio Final',
			'0% CXA GMF',
			'Seguro Gratis',
			'Tasa GMF',
			'Otros'
		]);
		expect(t.filas).toHaveLength(35);
		expect(t.filas![0]).toEqual(['AVEO HB 2026', 'A', 'LS Manual', 'CONTADO CON SEGURO', 'RCC', 'HCCM', '$319,100', '-', '$319,100', '', '1 AÑO HDI', '', '']);
		expect(t.filas![4]).toEqual([
			'AVEO HB 2026',
			'A',
			'LS Manual',
			'GMF TASA SUBSIDIADA CON SEGURO',
			'RCC',
			'HCAM',
			'$319,100',
			'($60,000)',
			'$259,100',
			'✓',
			'1 AÑO HDI',
			'Tasa Especial desde 14.59%',
			''
		]);
		expect(t.filas![16]!.slice(3, 12)).toEqual(['LEASING', 'RCC', 'LCCN', '$319,100', '($81,000)', '$238,100', '', '', 'Factor de Arrendamiento: 16.09%']);
		// El grupo de la izquierda: 20 filas de HB y 15 de NB.
		expect(t.filas!.map((f) => f[0])).toEqual([...Array(20).fill('AVEO HB 2026'), ...Array(15).fill('AVEO NB 2026')]);
		expect(p.avisos).toContain('Página 2: 36 trozos de texto que no se ven, descartados');
	});

	it('todas las páginas: los mismos encabezados que se ven, sin columnas fantasma ni «AVEO HB» encimado ni la fórmula oculta', () => {
		const tablas = p.bloques.filter((b) => b.tipo === 'tabla');
		expect(tablas.map((b) => b.pagina)).toEqual(Array.from({ length: 22 }, (_, i) => i + 2));
		for (const t of tablas) expect(t.encabezados, `p. ${t.pagina}`).not.toContain('');
		const modelos = new Set(tablas.filter((t) => t.pagina <= 21).flatMap((t) => t.filas!.map((f) => f[0])));
		expect([...modelos].filter((m) => /AVEO/.test(m!) && !/^AVEO (HB|NB) 2026$/.test(m!))).toEqual([]);
		expect(modelos).toContain('TAHOE 2026');
		expect(modelos).toContain('SILVERADO DOBLE CABINA 2026');
		expect(JSON.stringify(tabla(16))).not.toMatch(/=|"F"|"I"/);
		// Precios al distribuidor: «AMDA» centrado sobre importes alineados a la derecha.
		expect(tabla(22).encabezados).toEqual(['AM', 'Código', 'Modelo', 'Pqt.', 'Versión', 'Precio', 'AMDGM', 'AMDA', 'Seguro P.P.', 'Traslado', 'I.V.A.', 'Total']);
		expect(tabla(22).filas![0]).toEqual(['2026', '1VC48', 'Aveo HB', 'A', 'LS Manual', '240,039', '1,070', '55', '646', '7,270', '39,853', '288,933']);
	});

	it('cruce con el método X: un LLM falso que devuelve la página 2 con un importe distinto da exactamente esa diferencia', async () => {
		const page2 = tabla(2);
		const llm: ImportLLM = {
			async generateStructured() {
				const filas = page2.filas!.map((f) => [...f]);
				filas[5]![8] = '$293,600';
				return { bloques: [{ tipo: 'tabla', encabezados: page2.encabezados, filas }] };
			}
		};
		const x = await extraerConLLM([{ pagina: 2, imagen: Buffer.from('') }], llm);
		const solo2: Extraccion = { ...p, bloques: p.bloques.filter((b) => b.pagina === 2) };
		expect(compararExtracciones(solo2, x)).toEqual([
			{ pagina: 2, bloque: 0, fila: 5, filaX: 5, columna: 'Precio Final', valorP: '$293,500', valorX: '$293,600' }
		]);
	});
});
