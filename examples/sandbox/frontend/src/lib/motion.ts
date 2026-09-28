/**
 * Movimiento en JS — espejo de los tokens de `app.css` (docs/07 §2.6).
 *
 * Las transiciones de Svelte necesitan duración en milisegundos y una función
 * de curva, no variables CSS. Este módulo es la única traducción: si cambia un
 * token en `app.css`, se cambia aquí y nada más.
 *
 * Dos familias, como fija §2.6: lo que **empuja contenido** (paneles laterales,
 * filas que se expanden) anima su tamaño real con `grow` y `expand`, igual que
 * el sidebar; lo que **flota** (toasts, menús) usa `transform` y `opacity` con
 * `panel`. Con `prefers-reduced-motion`
 * las duraciones valen 0: la regla global de `app.css` recorta la animación,
 * pero Svelte esperaría igualmente la duración completa antes de retirar el
 * nodo, y el elemento quedaría visible sin moverse durante ese tiempo.
 */
import { fly, slide, type FlyParams, type TransitionConfig } from 'svelte/transition';

const reduced = () =>
	typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const DURATION = { fast: 120, base: 200, slow: 320 } as const;

/** `cubic-bezier(0.32, 0.72, 0, 1)` — la curva única del producto (`--oc-ease`). */
export const ocEase = cubicBezier(0.32, 0.72, 0, 1);

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
	const cx = 3 * x1;
	const bx = 3 * (x2 - x1) - cx;
	const ax = 1 - cx - bx;
	const cy = 3 * y1;
	const by = 3 * (y2 - y1) - cy;
	const ay = 1 - cy - by;
	const x = (t: number) => ((ax * t + bx) * t + cx) * t;
	const y = (t: number) => ((ay * t + by) * t + cy) * t;
	const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
	return (p: number) => {
		// Newton-Raphson: resuelve t tal que x(t) = p.
		let t = p;
		for (let i = 0; i < 8; i++) {
			const err = x(t) - p;
			const d = dx(t);
			if (Math.abs(err) < 1e-5 || Math.abs(d) < 1e-6) break;
			t -= err / d;
		}
		return y(Math.min(1, Math.max(0, t)));
	};
}

function duration(token: keyof typeof DURATION): number {
	return reduced() ? 0 : DURATION[token];
}

/**
 * Panel lateral que empuja contenido: su hueco crece de 0 a su ancho al abrir y
 * vuelve a 0 al cerrar, y la hoja se ajusta a la par. Quien lo monta alinea el
 * panel a la derecha dentro del hueco (`justify-end`), así se descubre desde el
 * borde, como un cajón, y el panel no se comprime mientras anima.
 */
export function grow(node: Element): TransitionConfig {
	return slide(node, { axis: 'x', duration: duration('base'), easing: ocEase });
}

/** Contenido que se despliega hacia abajo y se recoge hacia arriba (filas, acordeones). */
export function expand(node: Element): TransitionConfig {
	return slide(node, { axis: 'y', duration: duration('base'), easing: ocEase });
}

/**
 * Cambio de contenido dentro de un mismo hueco (p. ej. de un panel lateral a
 * otro): el nuevo entra por un lado y empuja al anterior hacia el opuesto, como
 * un carrusel. `from: 'left'` hace entrar el nuevo desde la izquierda; úsese la
 * misma dirección en `in:` y `out:` para que ambos se muevan juntos.
 *
 * Solo `transform`: los dos contenidos se superponen en la misma celda (quien
 * lo monta los apila con grid) y el hueco no cambia de tamaño.
 */
export function swap(
	node: Element,
	{ from, leaving = false }: { from: 'left' | 'right'; leaving?: boolean }
): TransitionConfig {
	// Entrando: parte del lado `from`. Saliendo: se va hacia el lado opuesto.
	const sign = (from === 'left') !== leaving ? -1 : 1;
	return {
		duration: duration('base'),
		easing: ocEase,
		css: (t) => `transform: translateX(${sign * (1 - t) * 100}%)`
	};
}

/** Elemento flotante (toast, menú) que no empuja nada: aparece desplazándose. */
export function panel(node: Element, params: FlyParams = {}): TransitionConfig {
	return fly(node, { x: 24, opacity: 0, duration: duration('base'), easing: ocEase, ...params });
}
