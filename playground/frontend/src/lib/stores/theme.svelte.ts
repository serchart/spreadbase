/**
 * Tema activo.
 *
 * Primer store del proyecto y plantilla de los que vienen: el estado vive
 * aquí, los componentes solo leen. Es la regla que cierra F-4 — los
 * contadores del sidebar leerán de stores, nunca de `data` de página, para
 * que cambiar su origen a WebSocket sea tocar un archivo.
 */

import { browser } from '$app/environment';
import { DEFAULT_THEME, THEME_STORAGE_KEY, getTheme, isThemeId } from '$lib/themes';

class ThemeStore {
	#id = $state(DEFAULT_THEME);

	/** Identificador activo (`data-theme`). */
	get id(): string {
		return this.#id;
	}

	/** Definición completa del tema activo. */
	get def() {
		return getTheme(this.#id);
	}

	/** `true` si el tema activo es oscuro. Útil para gráficas y mapas. */
	get isDark(): boolean {
		return this.def.scheme === 'dark';
	}

	/**
	 * Lee la preferencia guardada. Se llama una vez desde el layout raíz.
	 *
	 * El tema ya viene aplicado por el script en línea de `app.html`; esto solo
	 * sincroniza el estado de Svelte con lo que el DOM ya muestra, para que el
	 * selector nazca marcando la opción correcta.
	 */
	init(): void {
		if (!browser) return;

		const stored = safeRead();
		if (isThemeId(stored)) {
			this.#id = stored;
		}
		apply(this.#id);
	}

	set(id: string): void {
		if (!isThemeId(id)) return;

		this.#id = id;
		apply(id);
		safeWrite(id);
	}
}

function apply(id: string): void {
	if (!browser) return;
	document.documentElement.dataset.theme = id;
}

// localStorage lanza en modo privado de Safari y con cookies bloqueadas. Un
// tema no es motivo para tirar la aplicación.
function safeRead(): string | null {
	try {
		return localStorage.getItem(THEME_STORAGE_KEY);
	} catch {
		return null;
	}
}

function safeWrite(value: string): void {
	try {
		localStorage.setItem(THEME_STORAGE_KEY, value);
	} catch {
		/* preferencia no persistida: aceptable */
	}
}

export const theme = new ThemeStore();
