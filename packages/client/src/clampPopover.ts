/**
 * Globo con el texto completo de una celda recortada (`clampedTextCell`).
 *
 * Aparece solo si el texto **de verdad** se recortó —se mide al pasar el
 * mouse, no se supone por su longitud— y muestra el contenido en un textarea
 * de solo lectura, para poder leerlo y seleccionarlo.
 *
 * Un único globo por hoja, con delegación sobre el contenedor: jspreadsheet
 * reconstruye los `<td>` al repintar y un listener por celda se perdería.
 *
 * Flota sobre todo lo demás, así que solo anima `opacity` y `transform`
 * (docs/07 §2.6). Vive en `<body>` para no quedar recortado por el
 * `overflow: hidden` del panel, y copia los overrides `--dg-*` de su hoja.
 */
import { positionFloating } from './internal/floating';

/** Espera antes de mostrar: cruzar la tabla con el mouse no debe encender globos. */
const SHOW_DELAY = 250;
/** Margen para pasar del texto al globo sin que se cierre. */
const HIDE_DELAY = 120;

export function attachClampPopover(host: HTMLElement): () => void {
	let popover: HTMLDivElement | null = null;
	let anchor: HTMLElement | null = null;
	let showTimer: ReturnType<typeof setTimeout> | undefined;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;

	const isClipped = (box: HTMLElement) =>
		box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1;

	function open(box: HTMLElement) {
		close(true);
		const cell = box.closest('td') ?? box;
		anchor = box;

		popover = document.createElement('div');
		popover.className = 'oc-cell-popover';
		popover.setAttribute('role', 'tooltip');

		const grid = host.closest<HTMLElement>('.oc-grid');
		if (grid) {
			for (const prop of Array.from(grid.style)) {
				if (prop.startsWith('--dg-')) popover.style.setProperty(prop, grid.style.getPropertyValue(prop));
			}
		}

		const text = document.createElement('textarea');
		text.className = 'oc-cell-popover__text';
		text.readOnly = true;
		text.value = box.textContent ?? '';
		text.rows = 1;
		popover.appendChild(text);

		// Mismo motivo que en los editores: jspreadsheet da por terminada la
		// interacción si el clic cae fuera de su contenedor.
		popover.addEventListener('mousedown', (e) => e.stopPropagation());
		popover.addEventListener('pointerenter', () => clearTimeout(hideTimer));
		popover.addEventListener('pointerleave', scheduleHide);

		document.body.appendChild(popover);
		// Alto a la medida del texto; el CSS pone el tope y el scroll.
		text.style.height = `${text.scrollHeight}px`;
		positionFloating(popover, cell, { gap: 4, placement: 'bottom-start' });
		requestAnimationFrame(() => popover?.classList.add('is-open'));
	}

	function close(immediate = false) {
		clearTimeout(showTimer);
		clearTimeout(hideTimer);
		const el = popover;
		popover = null;
		anchor = null;
		if (!el) return;
		if (immediate) return el.remove();
		el.classList.remove('is-open');
		el.addEventListener('transitionend', () => el.remove(), { once: true });
		// Respaldo: sin transición (movimiento reducido) `transitionend` no llega.
		setTimeout(() => el.remove(), 400);
	}

	function scheduleHide() {
		clearTimeout(showTimer);
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => close(), HIDE_DELAY);
	}

	function handleOver(event: PointerEvent) {
		const box = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('.oc-clamp');
		if (!box || !host.contains(box)) return;
		clearTimeout(hideTimer);
		if (box === anchor) return;
		clearTimeout(showTimer);
		showTimer = setTimeout(() => {
			if (isClipped(box)) open(box);
			else close();
		}, SHOW_DELAY);
	}

	function handleOut(event: PointerEvent) {
		const from = (event.target as HTMLElement | null)?.closest?.('.oc-clamp');
		const to = (event.relatedTarget as HTMLElement | null)?.closest?.('.oc-clamp');
		if (from && from !== to) scheduleHide();
	}

	// Con scroll la celda se mueve y el globo, fijo, quedaría suelto. Se cierra;
	// el scroll del propio textarea no cuenta.
	const handleScroll = (event: Event) => {
		if (popover && !popover.contains(event.target as Node)) close(true);
	};

	host.addEventListener('pointerover', handleOver);
	host.addEventListener('pointerout', handleOut);
	window.addEventListener('scroll', handleScroll, true);

	return () => {
		host.removeEventListener('pointerover', handleOver);
		host.removeEventListener('pointerout', handleOut);
		window.removeEventListener('scroll', handleScroll, true);
		close(true);
	};
}
