/**
 * Método X (SB-36) y el cruce con P. SpreadBase no llama a ningún proveedor:
 * aquí el `ImportLLM` es falso, con respuestas fijas, y lo que se prueba es lo
 * que sí es de la librería: instrucciones, esquema, recorrido por páginas,
 * normalización y comparación celda por celda.
 */
import { describe, expect, it } from 'vitest';
import { ESQUEMA_PAGINA, armarInstrucciones, compararExtracciones, extraerConLLM, textoDePagina } from '@spreadbase/server';
import type { Extraccion, ImportLLM, ImportSchema } from '@spreadbase/server';

const schema: ImportSchema = {
	id: 'planes',
	label: 'Planes de financiamiento',
	columns: {
		version: { type: 'text', label: 'Versión', from: 'file' },
		precio: { type: 'number', label: 'Precio final', aliases: ['Precio Final', 'Precio'], from: 'file' },
		vigencia: { type: 'date', label: 'Vigencia', from: 'form' }
	}
};

/** Un LLM que responde según la página y guarda lo que recibió. */
function llmFalso(respuestas: Record<number, unknown>) {
	const llamadas: Parameters<ImportLLM['generateStructured']>[0][] = [];
	const llm: ImportLLM = {
		async generateStructured(input) {
			llamadas.push(input);
			const pagina = Number(/página (\d+)/.exec(input.instrucciones)?.[1]);
			const r = respuestas[pagina];
			if (r instanceof Error) throw r;
			return r;
		}
	};
	return { llm, llamadas };
}

describe('extraerConLLM', () => {
	it('recorre las páginas con su imagen, el esquema de respuesta y las columnas buscadas; arma la misma estructura que P', async () => {
		const { llm, llamadas } = llmFalso({
			1: {
				bloques: [
					{ tipo: 'texto', contenido: 'GUIA RAPIDA PARA VENDEDOR' },
					{ tipo: 'tabla', encabezados: ['Versión', 'Precio Final'], filas: [['LS Manual', '$319,100'], ['LT Plus', '$378,900', 'de más']], confianza: 0.9 }
				]
			},
			2: { bloques: [{ tipo: 'imagen', contenido: 'logotipo' }, { tipo: 'grafica' }, null] }
		});
		const png = Buffer.from('png');
		const x = await extraerConLLM(
			[
				{ pagina: 1, imagen: png, texto: 'Versión\tPrecio Final' },
				{ pagina: 2, imagen: 'https://ejemplo/p2.png' }
			],
			llm,
			{ schema, archivo: { nombre: 'boletin.pdf', paginas: 2, tipo: 'pdf' }, instrucciones: 'Los importes llevan signo de pesos.' }
		);
		expect(x).toEqual({
			archivo: { nombre: 'boletin.pdf', paginas: 2, tipo: 'pdf' },
			bloques: [
				{ pagina: 1, tipo: 'texto', contenido: 'GUIA RAPIDA PARA VENDEDOR' },
				{
					pagina: 1,
					tipo: 'tabla',
					// Todas las filas al ancho de la más ancha.
					encabezados: ['Versión', 'Precio Final', ''],
					filas: [
						['LS Manual', '$319,100', ''],
						['LT Plus', '$378,900', 'de más']
					],
					confianza: 0.9
				},
				{ pagina: 2, tipo: 'imagen', contenido: 'logotipo' }
			]
		});
		expect(llamadas).toHaveLength(2);
		expect(llamadas[0]!.imagenes).toEqual([png]);
		expect(llamadas[0]!.texto).toBe('Versión\tPrecio Final');
		expect(llamadas[0]!.schema).toBe(ESQUEMA_PAGINA);
		expect(llamadas[0]!.instrucciones).toContain('página 1 de 2');
		expect(llamadas[0]!.instrucciones).toContain('- Precio final (también: Precio Final, Precio)');
		expect(llamadas[0]!.instrucciones).not.toContain('Vigencia'); // del formulario, no del archivo
		expect(llamadas[0]!.instrucciones).toContain('Los importes llevan signo de pesos.');
		expect(llamadas[1]!.imagenes).toEqual(['https://ejemplo/p2.png']);
		expect(llamadas[1]!.texto).toBeUndefined();
	});

	it('una página que falla no detiene las demás: queda en avisos; varias a la vez, en su orden', async () => {
		const { llm } = llmFalso({
			1: { bloques: [{ tipo: 'texto', contenido: 'uno' }] },
			2: new Error('límite de tokens'),
			3: { bloques: [{ tipo: 'texto', contenido: 'tres' }] }
		});
		const x = await extraerConLLM([1, 2, 3].map((pagina) => ({ pagina, imagen: Buffer.from('') })), llm, { concurrencia: 3 });
		expect(x.bloques.map((b) => b.contenido)).toEqual(['uno', 'tres']);
		expect(x.avisos).toEqual(['Página 2: el LLM falló (límite de tokens)']);
	});

	it('las instrucciones se arman sin modelo (para ajustarlas en pruebas)', () => {
		const text = armarInstrucciones(4, { total: 24 });
		expect(text).toContain('página 4 de 24');
		expect(text).toContain('Una celda combinada que abarca varias filas');
		expect(text).not.toContain('Se buscan sobre todo');
	});
});

describe('compararExtracciones', () => {
	const p: Extraccion = {
		archivo: { nombre: 'b.pdf', paginas: 2, tipo: 'pdf' },
		bloques: [
			{ pagina: 1, tipo: 'texto', contenido: 'título' },
			{
				pagina: 1,
				tipo: 'tabla',
				encabezados: ['Modelo', 'Versión', '', 'Precio Final'],
				filas: [
					['AVEO HB 2026', 'LS Manual', 'L', '$319,100'],
					['AVEO HB 2026', 'LT Manual', 'L', '$346,500'],
					['AVEO HB 2026', 'LT Plus', 'L', '$378,900'],
					['AVEO NB 2026', 'LS Manual', 'N', '$332,800']
				]
			},
			{ pagina: 2, tipo: 'tabla', encabezados: ['A'], filas: [['1']] }
		]
	};
	const x: Extraccion = {
		archivo: { nombre: 'b.pdf', paginas: 2, tipo: 'pdf' },
		bloques: [
			{
				pagina: 1,
				tipo: 'tabla',
				// Otro orden de columnas, otra forma de escribir el encabezado, sin la columna oculta.
				encabezados: ['precio final', 'Modelo', 'Version'],
				filas: [
					['$319,100', 'AVEO HB 2026', 'LS Manual'],
					// Falta la fila de LT Manual.
					['$378,900', 'AVEO  HB 2026', 'LT Plus'],
					['$333,800', 'AVEO NB 2026', 'LS Manual'],
					['$1', 'ONIX 2026', 'LT']
				]
			},
			{ pagina: 2, tipo: 'tabla', encabezados: ['A'], filas: [['1']] }
		]
	};

	it('celda por celda: columnas por encabezado, filas alineadas aunque falte una; espacios de más no cuentan', () => {
		const diffs = compararExtracciones(p, x);
		const cols = (fila: number) => diffs.filter((d) => d.fila === fila && d.valorP !== null && d.valorX !== null);
		// La fila que solo está en P, y la que solo está en X.
		expect(diffs.filter((d) => d.valorX === null && d.columna !== '#3')).toEqual([
			{ pagina: 1, bloque: 0, fila: 1, filaX: null, columna: 'Modelo', valorP: 'AVEO HB 2026', valorX: null },
			{ pagina: 1, bloque: 0, fila: 1, filaX: null, columna: 'Versión', valorP: 'LT Manual', valorX: null },
			{ pagina: 1, bloque: 0, fila: 1, filaX: null, columna: 'Precio Final', valorP: '$346,500', valorX: null }
		]);
		expect(diffs.filter((d) => d.valorP === null)).toEqual([
			// Con el nombre de la columna en P.
			{ pagina: 1, bloque: 0, fila: 3, filaX: 3, columna: 'Modelo', valorP: null, valorX: 'ONIX 2026' },
			{ pagina: 1, bloque: 0, fila: 3, filaX: 3, columna: 'Versión', valorP: null, valorX: 'LT' },
			{ pagina: 1, bloque: 0, fila: 3, filaX: 3, columna: 'Precio Final', valorP: null, valorX: '$1' }
		]);
		// Las filas emparejadas: solo el importe distinto de AVEO NB.
		expect(cols(3)).toEqual([{ pagina: 1, bloque: 0, fila: 3, filaX: 2, columna: 'Precio Final', valorP: '$332,800', valorX: '$333,800' }]);
		expect(cols(0)).toEqual([]);
		expect(cols(2)).toEqual([]);
		// La columna sin encabezado de P (la oculta) no está en X.
		expect(diffs.filter((d) => d.columna === '#3').map((d) => d.valorP)).toEqual(['L', 'L', 'L', 'N']);
		// La página 2 coincide.
		expect(diffs.some((d) => d.pagina === 2)).toBe(false);
	});

	it('sin diferencias consigo misma; textoDePagina da el texto de apoyo para el LLM', () => {
		expect(compararExtracciones(p, p)).toEqual([]);
		expect(textoDePagina(p, 1).split('\n').slice(0, 3)).toEqual(['título', '', 'Modelo\tVersión\t\tPrecio Final']);
	});
});
