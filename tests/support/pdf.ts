/**
 * PDFs mínimos para las pruebas de extracción, escritos a mano: una página
 * carta con Helvetica (fuente estándar, sin incrustar) y lo que se le dibuje
 * en el flujo de contenido. Sin librerías: así cada prueba dice exactamente
 * qué texto hay, dónde y de qué color.
 */

/** Texto en (x, y) —línea base, en puntos desde abajo a la izquierda—, de 5 pt (como un boletín denso). */
export function texto(x: number, y: number, s: string, opciones: { color?: string; modo?: number; tamano?: number } = {}): string {
	const escaped = s.replace(/[\\()]/g, (c) => `\\${c}`);
	return `BT ${opciones.color ?? '0 0 0'} rg ${opciones.modo ?? 0} Tr /F1 ${opciones.tamano ?? 5} Tf ${x} ${y} Td (${escaped}) Tj ET`;
}

/** Línea de `(x0, y)` a `(x1, y)`. */
export const linea = (x0: number, x1: number, y: number) => `0 0 0 RG 0.8 w ${x0} ${y} m ${x1} ${y} l S`;

/** Un PDF de una página por cada flujo de contenido. */
export function pdfMinimo(paginas: string[]): Buffer {
	const objects: string[] = [];
	const pageIds = paginas.map((_, i) => 4 + i * 2);
	objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
	objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${paginas.length} >>`;
	objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
	paginas.forEach((content, i) => {
		const id = pageIds[i]!;
		objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
		const body = Buffer.from(content, 'latin1');
		objects[id + 1] = `<< /Length ${body.length} >>\nstream\n${content}\nendstream`;
	});
	let out = '%PDF-1.4\n';
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id++) {
		offsets[id] = Buffer.byteLength(out, 'latin1');
		out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xref = Buffer.byteLength(out, 'latin1');
	out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}
