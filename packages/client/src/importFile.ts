/**
 * Leer un archivo en el navegador para importarlo (SB-34): Excel (.xlsx) o
 * texto separado (CSV, TSV). Devuelve cada hoja como filas de celdas (un CSV es
 * una sola); encontrar la tabla —y en qué hoja está— es de `locateTable` (core).
 *
 * La lectura vive en core (`readXlsx`, `parseDelimited`): la usa también el
 * servidor al extraer archivos (SB-36). `exceljs` pesa: se carga solo la
 * primera vez que alguien suelta un Excel.
 */
import { parseDelimited, readXlsx } from '@spreadbase/core';
import type { ExcelJSLike, FileSheet } from '@spreadbase/core';

export { parseDelimited };
export type { FileCell, FileSheet } from '@spreadbase/core';

export async function readImportFile(file: File): Promise<FileSheet[]> {
	const name = file.name.toLowerCase();
	if (name.endsWith('.xlsx') || file.type.includes('spreadsheetml')) {
		const { default: ExcelJS } = await import('exceljs');
		return readXlsx(ExcelJS as unknown as ExcelJSLike, await file.arrayBuffer());
	}
	if (name.endsWith('.xls')) throw new Error('El formato .xls (Excel 97) no se lee: guárdalo como .xlsx');
	return [{ name: file.name, cells: parseDelimited(await file.text()) }];
}
