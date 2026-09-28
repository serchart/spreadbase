/**
 * Registro de temas.
 *
 * Agregar un tema son dos pasos, y ninguno toca componentes:
 *   1. Un bloque `@plugin "daisyui/theme"` en `app.css`.
 *   2. Una entrada en `THEMES`, aquí abajo.
 *
 * Los `swatch` se escriben a mano en lugar de leerse del CSS porque el
 * selector tiene que poder pintar la muestra de un tema **sin aplicarlo**. Si
 * cambias un color en `app.css`, actualiza su muestra aquí.
 */

export type ColorScheme = 'light' | 'dark';

export interface ThemeDef {
	/** Valor de `data-theme`. Debe coincidir con `name` en `app.css`. */
	id: string;
	/** Nombre visible para el usuario. */
	label: string;
	/** Una línea sobre para qué sirve, no sobre cómo se ve. */
	hint: string;
	scheme: ColorScheme;
	/** Muestra para el selector: [fondo, superficie, primario, acento]. */
	swatch: [string, string, string, string];
}

export const THEMES: ThemeDef[] = [
	{
		id: 'oc-light',
		label: 'Jardín',
		hint: 'Por defecto. Claro y cálido, amarillo de acción sobre gris.',
		scheme: 'light',
		swatch: [
			'oklch(92% 0 0)',
			'oklch(98% 0.003 247.858)',
			'oklch(90% 0.182 98.111)',
			'oklch(89% 0.196 126.665)'
		]
	},
	{
		id: 'oc-midnight',
		label: 'Medianoche',
		hint: 'Oscuro de trabajo. Para turnos largos y salas con poca luz.',
		scheme: 'dark',
		swatch: [
			'oklch(20.5% 0.022 268)',
			'oklch(25% 0.022 268)',
			'oklch(70% 0.17 268)',
			'oklch(74% 0.16 328)'
		]
	},
	{
		id: 'oc-graphite',
		label: 'Grafito',
		hint: 'Casi monocromo. El color solo aparece cuando significa algo.',
		scheme: 'dark',
		swatch: [
			'oklch(19% 0.005 250)',
			'oklch(23.5% 0.005 250)',
			'oklch(84% 0.19 118)',
			'oklch(76% 0.13 196)'
		]
	},
	{
		id: 'oc-paper',
		label: 'Papel',
		hint: 'Claro cálido. Lectura larga de estados de cuenta e impresión.',
		scheme: 'light',
		swatch: [
			'oklch(96.4% 0.015 85)',
			'oklch(99.2% 0.008 85)',
			'oklch(46% 0.13 162)',
			'oklch(51% 0.12 42)'
		]
	}
];

export const DEFAULT_THEME = 'oc-light';

/** Clave de `localStorage`. Con prefijo para no chocar con otras apps del host. */
export const THEME_STORAGE_KEY = 'sb:theme';

const THEME_IDS = new Set(THEMES.map((t) => t.id));

/**
 * Valida un identificador venido de `localStorage`.
 *
 * Importa: si se elimina un tema de `app.css` pero quedó guardado en el
 * navegador de alguien, `data-theme` apuntaría a un tema inexistente y la app
 * se vería sin estilos sin ninguna pista del motivo.
 */
export function isThemeId(value: unknown): value is string {
	return typeof value === 'string' && THEME_IDS.has(value);
}

export function getTheme(id: string): ThemeDef {
	return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
