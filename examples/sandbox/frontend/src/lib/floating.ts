/**
 * Colocación de paneles flotantes: desplegables, popovers y editores de celda.
 *
 * El problema que resuelve: un panel anclado con CSS puro (`top: 100%`) se sale
 * de la pantalla en cuanto su disparador está cerca de un borde. Y como el alto
 * de un panel depende de su contenido —una lista filtrada, un calendario—, no
 * hay valor fijo de CSS que sirva: hay que medir en el momento de abrir.
 *
 * Reglas, en orden de prioridad:
 *   1. Respetar la preferencia indicada mientras el panel quepa.
 *   2. Si no cabe, voltear al lado opuesto del disparador.
 *   3. Si tampoco cabe volteado, pegarlo al borde sin taparlo.
 *   4. Si es más alto que la ventana, limitar su alto y dejarlo con scroll.
 *
 * Nunca se deja que el contenido se desborde: preferimos mover o recortar el
 * panel antes que perder parte de él.
 *
 * Requiere `position: fixed` en el panel. Las coordenadas son de viewport, que
 * además lo libera de cualquier ancestro con `overflow: hidden`.
 */

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface FloatingOptions {
	/** Separación entre disparador y panel, en px. */
	gap?: number;
	/** Margen mínimo que se respeta con el borde de la ventana, en px. */
	margin?: number;
	/** Posición preferida. Se abandona solo si el panel no cabe ahí. */
	placement?: Placement;
}

/** Coloca el panel junto a su disparador procurando que se vea completo. */
export function positionFloating(
	panel: HTMLElement,
	anchor: Element,
	options: FloatingOptions = {}
): void {
	const { gap = 6, margin = 8, placement = 'bottom-start' } = options;

	const a = anchor.getBoundingClientRect();
	const vw = window.innerWidth;
	const vh = window.innerHeight;

	// Los límites de una colocación anterior falsearían la medición, y si ya no
	// hacen falta deben desaparecer para que el CSS del panel vuelva a mandar.
	panel.style.maxHeight = '';
	panel.style.overflowY = '';
	const width = panel.offsetWidth;
	const height = panel.offsetHeight;

	// --- vertical ---
	const roomBelow = vh - a.bottom - gap - margin;
	const roomAbove = a.top - gap - margin;
	const fitsBelow = height <= roomBelow;
	const fitsAbove = height <= roomAbove;

	let top: number;
	if (height > vh - margin * 2) {
		// Más alto que la ventana: no hay colocación buena, así que se recorta y
		// se le da scroll propio. Mejor un panel con scroll que uno cortado.
		panel.style.maxHeight = `${vh - margin * 2}px`;
		panel.style.overflowY = 'auto';
		top = margin;
	} else {
		const wantsTop = placement.startsWith('top');
		// Se vuelve al lado contrario solo cuando el preferido no da espacio.
		const above = wantsTop ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;
		top = above ? a.top - gap - height : a.bottom + gap;
		top = Math.min(Math.max(margin, top), vh - height - margin);
	}

	// --- horizontal ---
	let left = placement.endsWith('end') ? a.right - width : a.left;
	// Alinear por el otro extremo del disparador conserva la relación visual con
	// él; recortar contra el borde la rompería sin necesidad.
	if (left + width > vw - margin) left = a.right - width;
	left = Math.min(Math.max(margin, left), Math.max(margin, vw - width - margin));

	panel.style.top = `${top}px`;
	panel.style.left = `${left}px`;
}

/**
 * Acción de Svelte para paneles que viven mientras están abiertos.
 *
 * Reposiciona al abrir y ante scroll o cambio de tamaño, porque un panel fijo
 * se quedaría atrás al desplazar la página. El scroll se escucha en captura
 * para enterarse también del de contenedores internos, que no burbujea.
 */
export function floating(
	node: HTMLElement,
	params: { anchor: Element | undefined } & FloatingOptions
) {
	let current = params;

	const update = () => {
		if (current.anchor) positionFloating(node, current.anchor, current);
	};

	update();
	window.addEventListener('scroll', update, true);
	window.addEventListener('resize', update);

	return {
		update(next: typeof params) {
			current = next;
			update();
		},
		destroy() {
			window.removeEventListener('scroll', update, true);
			window.removeEventListener('resize', update);
		}
	};
}
