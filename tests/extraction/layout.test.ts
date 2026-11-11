/**
 * Reconstrucción de tablas por alineación (`bloquesDePagina`, método P de
 * SB-36), con coordenadas inventadas: sin PDF ni canvas, solo la geometría.
 */
import { describe, expect, it } from 'vitest';
import { bloquesDePagina } from '@spreadbase/server';
import type { TextoPosicionado } from '@spreadbase/server';

/** Un trozo de 4 pt de alto; el ancho, aproximado por el número de letras. */
const t = (x: number, y: number, texto: string, w = texto.length * 2): TextoPosicionado => ({ texto, x0: x, x1: x + w, y, h: 4 });

/** Filas de una tabla cada 12 pt, con columnas en x = 20, 60, 120, 170. */
const filas = (desde: number, datos: string[][]) => datos.flatMap((r, i) => r.map((v, j) => t([20, 60, 120, 170][j]!, desde - i * 12, v)).filter((x) => x.texto));

describe('bloquesDePagina', () => {
	it('encabezado, filas y un título encima; columnas por el espacio en blanco', () => {
		const items = [
			t(20, 300, 'Lista de precios'),
			t(20, 280, 'Clave'),
			t(60, 280, 'Producto'),
			t(120, 280, 'Precio'),
			...filas(268, [
				['A1', 'Camión', '$1,500'],
				['A2', 'Grúa azul', '$2,500'],
				['A3', 'Tractor', '']
			])
		];
		expect(bloquesDePagina(items, 3)).toEqual([
			{ pagina: 3, tipo: 'texto', contenido: 'Lista de precios' },
			{
				pagina: 3,
				tipo: 'tabla',
				titulo: 'Lista de precios',
				encabezados: ['Clave', 'Producto', 'Precio'],
				filas: [
					['A1', 'Camión', '$1,500'],
					['A2', 'Grúa azul', '$2,500'],
					['A3', 'Tractor', '']
				],
				confianza: 1
			}
		]);
	});

	it('encabezados y celdas de dos renglones se unen con un espacio', () => {
		const items = [
			t(20, 282, 'Código'),
			t(20, 278, 'GMM'),
			t(60, 280, 'Plan'),
			t(120, 280, 'Tasa'),
			...filas(268, [['RCC', 'Leasing', '']]),
			t(120, 270, 'Factor:'),
			t(120, 266, '16.09%'),
			...filas(256, [['BFC', 'Contado', '-']])
		];
		const [tabla] = bloquesDePagina(items, 1);
		expect(tabla!.encabezados).toEqual(['Código GMM', 'Plan', 'Tasa']);
		expect(tabla!.filas).toEqual([
			['RCC', 'Leasing', 'Factor: 16.09%'],
			['BFC', 'Contado', '-']
		]);
	});

	it('sin encabezado si la primera fila trae números', () => {
		const [tabla] = bloquesDePagina(
			filas(268, [
				['1', 'Camión', '$1,500'],
				['2', 'Grúa', '$2,500']
			]),
			1
		);
		expect(tabla!.encabezados).toBeUndefined();
		expect(tabla!.filas).toHaveLength(2);
	});

	it('una columna del principio casi vacía es una celda combinada: cada fila toma el valor más cercano', () => {
		const datos = Array.from({ length: 8 }, (_, i) => ['', `P${i + 1}`, `$${i + 1}00`, 'Contado']);
		const items = [
			t(20, 280, 'Modelo'),
			t(60, 280, 'Paq'),
			t(120, 280, 'Precio'),
			t(170, 280, 'Plan'),
			...filas(268, datos),
			// «AVEO HB 2026» centrado sobre las filas 1–4 (y = 268…232); «ONIX 2026» sobre las 5–8.
			t(18, 252, 'AVEO HB'),
			t(20, 246, '2026'),
			t(18, 204, 'ONIX'),
			t(20, 198, '2026')
		];
		const [tabla] = bloquesDePagina(items, 1);
		expect(tabla!.filas!.map((f) => f[0])).toEqual([...Array(4).fill('AVEO HB 2026'), ...Array(4).fill('ONIX 2026')]);
		expect(tabla!.confianza).toBe(0.9);
	});

	it('con lineaHorizontal, la celda combinada abarca exactamente las filas entre dos líneas', () => {
		// Grupos desiguales: «AVEO» abarca 6 filas y «ONIX» 2; por cercanía, la fila 5 sería de ONIX.
		const datos = Array.from({ length: 8 }, (_, i) => ['', `P${i + 1}`, `$${i + 1}00`, 'Contado']);
		const items = [t(20, 280, 'Modelo'), t(60, 280, 'Paq'), t(120, 280, 'Precio'), t(170, 280, 'Plan'), ...filas(268, datos), t(18, 238, 'AVEO'), t(18, 190, 'ONIX')];
		// Una línea en «Modelo» entre la fila 6 (y = 208) y la 7 (y = 196).
		const lineaHorizontal = (x0: number, x1: number, yArriba: number, yAbajo: number) =>
			x0 < 30 && Math.min(yArriba, yAbajo) < 202 && Math.max(yArriba, yAbajo) > 202;
		const [tabla] = bloquesDePagina(items, 1, { lineaHorizontal });
		expect(tabla!.filas!.map((f) => f[0])).toEqual([...Array(6).fill('AVEO'), ...Array(2).fill('ONIX')]);
	});

	it('un encabezado centrado sobre números alineados a la derecha es de esa columna', () => {
		const items = [
			t(20, 280, 'Clave'),
			t(60, 280, 'AMDA'),
			t(120, 280, 'Total'),
			// «55» queda a la derecha de «AMDA» (60…68), sin tocarlo.
			t(20, 268, 'K1'),
			t(70, 268, '55'),
			t(120, 268, '$1'),
			t(20, 256, 'K2'),
			t(70, 256, '55'),
			t(120, 256, '$2')
		];
		const [tabla] = bloquesDePagina(items, 1);
		expect(tabla!.encabezados).toEqual(['Clave', 'AMDA', 'Total']);
		expect(tabla!.filas).toEqual([
			['K1', '55', '$1'],
			['K2', '55', '$2']
		]);
	});

	it('texto encimado: se queda el que dice preferir (o el más ancho); el mismo texto dos veces, uno', () => {
		const base = [t(20, 280, 'Modelo'), t(60, 280, 'Paq'), t(120, 280, 'Precio'), t(170, 280, 'Plan'), ...filas(268, [['', 'A', '$1', 'Contado'], ['', 'B', '$2', 'Leasing']])];
		const encimados = [t(18, 262, 'AVEO HB', 14), t(17, 262.5, 'TAHOE', 13), t(60, 268.2, 'A')];
		const sinPreferir = bloquesDePagina([...base, ...encimados], 1)[0]!;
		expect(sinPreferir.filas!.map((f) => f[0])).toEqual(['AVEO HB', 'AVEO HB']);
		expect(sinPreferir.filas![0]![1]).toBe('A');
		const conPreferir = bloquesDePagina([...base, ...encimados], 1, { preferir: (a, b) => (a.texto === 'TAHOE' ? a : b) })[0]!;
		expect(conPreferir.filas!.map((f) => f[0])).toEqual(['TAHOE', 'TAHOE']);
	});

	it('una página sin texto no da bloques; dos tablas separadas por un hueco son dos', () => {
		expect(bloquesDePagina([], 1)).toEqual([]);
		const items = [...filas(700, [['A', 'B', 'C'], ['D', 'E', 'F']]), ...filas(400, [['G', 'H', 'I'], ['J', 'K', 'L']])];
		expect(bloquesDePagina(items, 1).map((b) => b.tipo)).toEqual(['tabla', 'tabla']);
	});
});
