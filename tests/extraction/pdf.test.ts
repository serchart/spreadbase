/**
 * Método P sobre un PDF (SB-36), con un PDF mínimo escrito en la prueba: una
 * tabla con encabezado de dos renglones, una celda de dos renglones, celdas
 * combinadas en «Modelo» separadas por las líneas de la tabla, y texto que no
 * se ve (blanco sobre blanco y en modo invisible) que la capa de texto sí trae.
 */
import { describe, expect, it } from 'vitest';
import { extraerDeterminista, renderizarPdf } from '@spreadbase/server';
import { linea, pdfMinimo, texto } from '../support/pdf.ts';

const ROWS = [
	{ y: 680, paq: 'A', version: 'LS Manual', codigo: 'HCCM', precio: '$319,100' },
	{ y: 665, paq: 'B', version: 'LT Manual', codigo: 'HCCM', precio: '$346,500' },
	{ y: 650, paq: 'C', version: 'LT Plus', codigo: 'HCAM', precio: '$378,900' },
	{ y: 635, paq: 'D', version: 'Premier', codigo: 'LCCN', precio: '($60,000)' }
];

const tabla = [
	texto(200, 740, 'LISTA DE PRECIOS'),
	// Encabezado: «Codigo» / «GMF» en dos renglones.
	texto(40, 700, 'Modelo'),
	texto(110, 700, 'Paq'),
	texto(150, 700, 'Version'),
	texto(210, 703, 'Codigo'),
	texto(211, 697, 'GMF'),
	texto(260, 700, 'Precio'),
	texto(340, 700, 'Notas'),
	...ROWS.flatMap((r) => [
		texto(112, r.y, r.paq),
		texto(150, r.y, r.version),
		texto(210, r.y, r.codigo),
		texto(260, r.y, r.precio),
		// Una columna auxiliar que no se ve: blanco sobre blanco.
		texto(135, r.y, 'L', { color: '1 1 1' })
	]),
	// Una celda de dos renglones.
	texto(340, 683, 'Factor:'),
	texto(345, 677, '16.09%'),
	// Celdas combinadas: «AVEO HB 2026» abarca las dos primeras filas; «ONIX 2026», las otras dos.
	texto(40, 675.5, 'AVEO HB'),
	texto(42, 669.5, '2026'),
	texto(40, 645.5, 'ONIX'),
	texto(42, 639.5, '2026'),
	// Texto en modo invisible (como el de un OCR) en una zona vacía.
	texto(300, 560, 'NO SE VE', { modo: 3 }),
	// Líneas: arriba y abajo de la tabla, entre filas solo de «Paq» a la derecha,
	// y en «Modelo» solo entre los dos grupos.
	linea(35, 420, 692),
	linea(35, 420, 627),
	...[672.5, 657.5, 642.5].map((y) => linea(100, 420, y)),
	linea(35, 100, 657.5)
].join('\n');

const notas = [texto(40, 710, 'NOTAS ACLARATORIAS:'), texto(40, 680, '1. Precios sujetos a cambio sin previo aviso.'), texto(40, 670, 'Consulte a su distribuidor.')].join(
	'\n'
);

const pdf = pdfMinimo([tabla, notas, '']);

describe('extraerDeterminista · PDF', () => {
	it('reconstruye la tabla: encabezado de dos renglones, celdas combinadas por las líneas, sin el texto oculto', async () => {
		const { archivo, bloques, avisos } = await extraerDeterminista(pdf, { nombre: 'precios.pdf', mime: 'application/pdf' });
		expect(archivo).toEqual({ nombre: 'precios.pdf', paginas: 3, tipo: 'pdf' });
		const tablas = bloques.filter((b) => b.tipo === 'tabla');
		expect(tablas).toHaveLength(1);
		const t = tablas[0]!;
		expect(t.pagina).toBe(1);
		expect(t.titulo).toBe('LISTA DE PRECIOS');
		expect(t.encabezados).toEqual(['Modelo', 'Paq', 'Version', 'Codigo GMF', 'Precio', 'Notas']);
		expect(t.filas).toEqual([
			['AVEO HB 2026', 'A', 'LS Manual', 'HCCM', '$319,100', 'Factor: 16.09%'],
			['AVEO HB 2026', 'B', 'LT Manual', 'HCCM', '$346,500', ''],
			['ONIX 2026', 'C', 'LT Plus', 'HCAM', '$378,900', ''],
			['ONIX 2026', 'D', 'Premier', 'LCCN', '($60,000)', '']
		]);
		expect(t.confianza).toBeGreaterThan(0.8);
		// La «L» blanca de cada fila y el texto invisible se descartaron, y se dice.
		expect(avisos).toContain('Página 1: 5 trozos de texto que no se ven, descartados');
		expect(JSON.stringify(bloques)).not.toContain('NO SE VE');
	});

	it('lo que no es tabla sale como texto; una página sin capa de texto, como imagen (para el método X)', async () => {
		const { bloques } = await extraerDeterminista(pdf, { nombre: 'precios.pdf' });
		expect(bloques.filter((b) => b.pagina === 2)).toEqual([
			{ pagina: 2, tipo: 'texto', contenido: 'NOTAS ACLARATORIAS:' },
			{ pagina: 2, tipo: 'texto', contenido: '1. Precios sujetos a cambio sin previo aviso.\nConsulte a su distribuidor.' }
		]);
		expect(bloques.filter((b) => b.pagina === 3)).toEqual([{ pagina: 3, tipo: 'imagen', contenido: 'La página no tiene capa de texto', confianza: 0 }]);
	});

	it('con ocultos: conservar, la columna oculta aparece (sin encabezado)', async () => {
		const { bloques } = await extraerDeterminista(pdf, { nombre: 'precios.pdf', ocultos: 'conservar', paginas: [1] });
		const t = bloques.find((b) => b.tipo === 'tabla')!;
		expect(t.encabezados).toEqual(['Modelo', 'Paq', '', 'Version', 'Codigo GMF', 'Precio', 'Notas']);
		expect(t.filas!.map((f) => f[2])).toEqual(['L', 'L', 'L', 'L']);
	});

	it('dibuja cada página a PNG para el método X', async () => {
		const { imagenes } = await extraerDeterminista(pdf, { nombre: 'precios.pdf', imagenes: true, escala: 1, paginas: [1, 2] });
		expect(imagenes!.map((i) => [i.pagina, i.ancho, i.alto])).toEqual([
			[1, 612, 792],
			[2, 612, 792]
		]);
		expect(imagenes![0]!.png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const solo = await renderizarPdf(pdf, { escala: 0.5, paginas: [3] });
		expect(solo.map((i) => [i.pagina, i.ancho, i.alto])).toEqual([[3, 306, 396]]);
	});
});
