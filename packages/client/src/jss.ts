/**
 * Ciclo de vida de instancias de jspreadsheet que conviven en la misma página.
 *
 * jspreadsheet registra **un solo juego** de listeners en `document`, común a
 * todas las instancias, y enruta cada evento a `jspreadsheet.current`: la
 * última hoja que recibió un clic. Dos consecuencias:
 *
 * - `destroy(el, true)` retira esos listeners compartidos. Si lo hace una hoja
 *   cualquiera, las demás se quedan sin teclado. Solo la última debe hacerlo.
 * - Si la hoja destruida era `current`, el siguiente `keydown` del documento se
 *   enrutaría a una instancia ya desmontada.
 */
import jspreadsheet from 'jspreadsheet-ce';

export function destroySheet(host: HTMLElement, worksheet: unknown): void {
	const lib = jspreadsheet as any;
	if (lib.current === worksheet) lib.current = null;
	const isLast = (lib.spreadsheet?.length ?? 0) <= 1;
	try {
		lib.destroy(host, isLast);
	} catch {
		// La instancia ya fue destruida o el nodo se desmontó.
	}
}
