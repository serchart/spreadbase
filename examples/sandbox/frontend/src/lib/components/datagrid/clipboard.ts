/**
 * Serialización TSV para el portapapeles del DataGrid.
 *
 * El formato es el que usan Excel, Google Sheets y Numbers: celdas separadas
 * por tabulador, filas por salto de línea. Eso permite copiar de la grilla y
 * pegar en una hoja de cálculo, y viceversa.
 *
 * El parser respeta el entrecomillado de Excel, que es cómo esas herramientas
 * representan una celda que contiene tabuladores o saltos de línea. Sin eso,
 * pegar una nota multilínea desplaza toda la matriz.
 */

/** Convierte una matriz de texto en TSV, entrecomillando solo si hace falta. */
export function toTsv(matrix: string[][]): string {
	return matrix
		.map((row) =>
			row
				.map((cell) => {
					const needsQuotes = /[\t\n\r"]/.test(cell);
					return needsQuotes ? `"${cell.replace(/"/g, '""')}"` : cell;
				})
				.join('\t')
		)
		.join('\n');
}

/**
 * Parsea TSV a una matriz. Tolera CRLF y campos entrecomillados con comillas
 * dobles escapadas (`""`), tal como los emite Excel.
 */
export function fromTsv(text: string): string[][] {
	const matrix: string[][] = [];
	let row: string[] = [];
	let cell = '';
	let inQuotes = false;

	const endCell = () => {
		row.push(cell);
		cell = '';
	};
	const endRow = () => {
		endCell();
		matrix.push(row);
		row = [];
	};

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (inQuotes) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					cell += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				cell += char;
			}
			continue;
		}

		if (char === '"' && cell === '') {
			inQuotes = true;
		} else if (char === '\t') {
			endCell();
		} else if (char === '\n') {
			endRow();
		} else if (char === '\r') {
			// Se ignora: el '\n' siguiente cierra la fila (CRLF de Windows).
		} else {
			cell += char;
		}
	}

	// Última celda pendiente, salvo que el texto termine en salto de línea.
	if (cell !== '' || row.length > 0) endRow();

	return matrix;
}
