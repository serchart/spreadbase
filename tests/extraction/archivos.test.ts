/**
 * Método P para lo que no es PDF (SB-36): Excel y CSV con la misma lectura que
 * la vista previa de SB-34 (`readXlsx`, `parseDelimited` y `locateTable` de
 * core), texto, JSON e imágenes. Los archivos se generan en la prueba.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { extraerDeterminista } from '@spreadbase/server';
import type { ImportSchema } from '@spreadbase/server';

async function libro(): Promise<Buffer> {
	const wb = new ExcelJS.Workbook();
	const instrucciones = wb.addWorksheet('Instrucciones');
	instrucciones.addRow(['Llena la hoja Precios']);
	const precios = wb.addWorksheet('Precios');
	precios.addRow(['Boletín de octubre']);
	precios.addRow([]);
	precios.addRow(['Modelo', 'Versión', 'Precio', 'Vigencia']);
	precios.addRow(['Aveo', 'LS Manual', 319100, new Date(Date.UTC(2026, 9, 1))]);
	precios.addRow(['Onix', 'Premier', { formula: 'C4+1', result: 319101 }, null]);
	return Buffer.from(await wb.xlsx.writeBuffer());
}

const schema: ImportSchema = {
	id: 'precios',
	label: 'Precios',
	columns: {
		modelo: { type: 'text', label: 'Modelo', from: 'file', required: true },
		precio: { type: 'number', label: 'Precio final', aliases: ['Precio'], from: 'file', required: true }
	}
};

describe('extraerDeterminista · hojas de cálculo y texto', () => {
	it('Excel: un bloque tabla por hoja, el encabezado en la primera fila con datos; fechas como día, fórmulas por su resultado', async () => {
		const { archivo, bloques } = await extraerDeterminista(await libro(), { nombre: 'precios.xlsx' });
		expect(archivo).toEqual({ nombre: 'precios.xlsx', paginas: 2, tipo: 'xlsx' });
		expect(bloques[0]).toMatchObject({ pagina: 1, tipo: 'tabla', titulo: 'Instrucciones', encabezados: ['Llena la hoja Precios'], filas: [] });
		expect(bloques[1]).toEqual({
			pagina: 2,
			tipo: 'tabla',
			titulo: 'Precios',
			encabezados: ['Boletín de octubre', '', '', ''],
			filas: [
				['Modelo', 'Versión', 'Precio', 'Vigencia'],
				['Aveo', 'LS Manual', '319100', '2026-10-01'],
				['Onix', 'Premier', '319101', '']
			],
			confianza: 1
		});
	});

	it('Excel con el formato destino: el encabezado se encuentra con locateTable (por etiqueta o alias)', async () => {
		const { bloques } = await extraerDeterminista(await libro(), { nombre: 'precios.xlsx', schema });
		expect(bloques[1]).toMatchObject({
			encabezados: ['Modelo', 'Versión', 'Precio', 'Vigencia'],
			filas: [
				['Aveo', 'LS Manual', '319100', '2026-10-01'],
				['Onix', 'Premier', '319101', '']
			]
		});
	});

	it('CSV (y punto y coma, con comillas): un bloque tabla', async () => {
		const csv = Buffer.from('﻿Modelo;Precio;Nota\nAveo;"319,100";"dice ""hola"""\nOnix;;\n', 'utf8');
		const { archivo, bloques } = await extraerDeterminista(csv, { nombre: 'precios.csv', mime: 'text/csv' });
		expect(archivo.tipo).toBe('csv');
		expect(bloques).toEqual([
			{
				pagina: 1,
				tipo: 'tabla',
				titulo: 'precios.csv',
				encabezados: ['Modelo', 'Precio', 'Nota'],
				filas: [
					['Aveo', '319,100', 'dice "hola"'],
					['Onix', '', '']
				],
				confianza: 1
			}
		]);
	});

	it('texto, Markdown y JSON: un bloque texto; una imagen: un bloque imagen para el método X', async () => {
		const md = await extraerDeterminista(Buffer.from('# Notas\n\nVigencia: octubre'), { nombre: 'notas.md' });
		expect(md).toEqual({ archivo: { nombre: 'notas.md', paginas: 1, tipo: 'texto' }, bloques: [{ pagina: 1, tipo: 'texto', contenido: '# Notas\n\nVigencia: octubre', confianza: 1 }] });
		const json = await extraerDeterminista(Buffer.from('{"a":1}'), { nombre: 'datos.json' });
		expect(json.bloques[0]!.contenido).toBe('{\n  "a": 1\n}');
		const png = await extraerDeterminista(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { nombre: 'foto.png', mime: 'image/png' });
		expect(png.archivo.tipo).toBe('imagen');
		expect(png.bloques).toEqual([{ pagina: 1, tipo: 'imagen', contenido: 'Una imagen no tiene texto: la lee el método X (LLM)', confianza: 0 }]);
		await expect(extraerDeterminista(Buffer.from('x'), { nombre: 'raro.bin', mime: 'application/octet-stream' })).rejects.toThrow(/No se sabe extraer/);
	});
});
