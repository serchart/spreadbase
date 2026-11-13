/**
 * Registry de tipos de celda del DataGrid.
 *
 * Cada tipo encapsula cuatro responsabilidades:
 *   parse()    → normaliza lo que escribe el usuario a un valor canónico
 *   format()   → convierte el valor canónico en el texto visible
 *   validate() → reglas del tipo + reglas de la columna
 *   toColumn() → traduce la definición a una columna de jspreadsheet
 *
 * Para agregar un tipo nuevo basta con `registerCellType({...})`.
 */

import { flushSync, mount, unmount, type Component } from 'svelte';
import { canonicalJson, fileNameOf, fileRefsOf, isFileRef, isImageFile, isPasswordMark, normalizeFileRef, normalizeFileValue, toFileRef } from '@spreadbase/core';
import type { FileRef } from '@spreadbase/core';
import { avatarNode, cachedMedia, hasIcon, iconSvg, recordMedia, rememberMedia } from './avatar';
import { positionFloating } from './internal/floating';
import type { CellTypeContext, CellTypeDef, CellValue, ColumnDef, GridRow, LookupColumnDef, Option } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isBlank = (v: unknown): boolean => v === null || v === undefined || v === '';

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/** Acepta 'YYYY-MM-DD', 'DD/MM/YYYY', ISO o Date. Devuelve 'YYYY-MM-DD' o null. */
function toCanonicalDate(raw: unknown): string | null {
	if (isBlank(raw)) return null;
	if (raw instanceof Date && !isNaN(raw.getTime())) {
		return `${raw.getFullYear()}-${pad(raw.getMonth() + 1)}-${pad(raw.getDate())}`;
	}
	const s = String(raw).trim();

	let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (m) return `${m[1]}-${m[2]}-${m[3]}`;

	// Formato local DD/MM/YYYY: primer grupo es día, segundo es mes.
	m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;

	const d = new Date(s);
	if (!isNaN(d.getTime())) {
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
	return null;
}

/** Devuelve 'YYYY-MM-DD HH:mm' o null. */
function toCanonicalDateTime(raw: unknown): string | null {
	if (isBlank(raw)) return null;
	const datePart = toCanonicalDate(raw);
	if (!datePart) return null;
	const s = raw instanceof Date ? raw.toISOString() : String(raw);
	const m = s.match(/(\d{1,2}):(\d{2})/);
	const hh = m ? pad(Math.min(23, +m[1])) : '00';
	const mm = m ? pad(Math.min(59, +m[2])) : '00';
	return `${datePart} ${hh}:${mm}`;
}

function formatDateDisplay(canonical: CellValue): string {
	if (isBlank(canonical)) return '';
	const m = String(canonical).match(/^(\d{4})-(\d{2})-(\d{2})/);
	return m ? `${m[3]}/${m[2]}/${m[1]}` : String(canonical);
}

function formatDateTimeDisplay(canonical: CellValue): string {
	if (isBlank(canonical)) return '';
	const s = String(canonical);
	const time = s.match(/(\d{2}):(\d{2})/);
	return `${formatDateDisplay(s)}${time ? ` ${time[1]}:${time[2]}` : ''}`;
}

function toCanonicalNumber(raw: unknown): number | null {
	if (isBlank(raw)) return null;
	if (typeof raw === 'number') return isNaN(raw) ? null : raw;
	// Tolera separadores de miles, símbolos de moneda y espacios.
	const cleaned = String(raw)
		.replace(/[^\d.,\-]/g, '')
		.replace(/,/g, '');
	if (cleaned === '' || cleaned === '-') return null;
	const n = Number(cleaned);
	return isNaN(n) ? null : n;
}

function formatNumberDisplay(value: CellValue, column: ColumnDef): string {
	if (isBlank(value)) return '';
	const n = Number(value);
	if (isNaN(n)) return String(value);
	const precision = column.precision ?? 0;
	const body =
		column.thousands === false
			? n.toFixed(precision)
			: n.toLocaleString('es-MX', {
					minimumFractionDigits: precision,
					maximumFractionDigits: precision
				});
	return `${column.prefix ?? ''}${body}${column.suffix ?? ''}`;
}

/** Igualdad laxa: '' y null son el mismo "vacío" para efectos de dirty-checking. */
function looseEquals(a: CellValue, b: CellValue): boolean {
	if (isBlank(a) && isBlank(b)) return true;
	return a === b;
}

/**
 * Normaliza para comparar: sin may\u00fasculas y sin acentos.
 *
 * Buscar «organico» debe encontrar «Orgánico». En un catálogo en español,
 * exigir la tilde exacta convierte el filtro en un estorbo.
 */
export function normalizeForSearch(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '');
}

function requiredError(value: CellValue, column: ColumnDef): string | null {
	if (column.required && isBlank(value)) return `"${column.label}" es obligatorio`;
	return null;
}

// ---------------------------------------------------------------------------
// Overlay compartido para editores personalizados
// ---------------------------------------------------------------------------

interface ActiveEditor {
	cell: HTMLTableCellElement;
	overlay: HTMLDivElement;
	/** Valor que se devolverá si el cierre es con guardado. */
	value: CellValue;
	original: CellValue;
	/**
	 * Lo que confirmaría Enter en este momento (lo tecleado), si el editor lo
	 * tiene. jspreadsheet cierra con guardado al clicar fuera o en otra celda
	 * llamando directo a `closeEditor`, sin pasar por el Enter del editor: sin
	 * esto, ese cierre devolvía `value` —aún el original— y lo escrito se
	 * perdía. Salir de la celda confirma, como en una hoja de cálculo.
	 */
	read?: () => CellValue;
	dispose: () => void;
}

let activeEditor: ActiveEditor | null = null;

function mountOverlay(cell: HTMLTableCellElement, width = 280): HTMLDivElement {
	const rect = cell.getBoundingClientRect();
	const overlay = document.createElement('div');
	overlay.className = 'oc-cell-editor';
	// El panel nunca es más angosto que la celda que edita.
	overlay.style.width = `${Math.max(width, rect.width)}px`;

	/*
		El panel vive en <body>, fuera del componente, así que no hereda las
		variables `--dg-*` que la prop `theme` pone en línea sobre `.oc-grid`. Se
		copian aquí para que el editor use el mismo tema que su hoja.
	*/
	const host = cell.closest<HTMLElement>('.oc-grid');
	if (host) {
		for (const prop of Array.from(host.style)) {
			if (prop.startsWith('--dg-')) overlay.style.setProperty(prop, host.style.getPropertyValue(prop));
		}
	}

	/*
		jspreadsheet escucha `mousedown` en el documento y, si el clic no cae
		dentro de un `.jss_container`, da la edición por terminada. El panel vive
		en <body> para poder desbordar la hoja, así que sus propios clics —el
		buscador, un día del calendario, el campo de hora— cumplían esa condición
		y lo cerraban al instante.

		Se corta aquí la propagación: dentro del panel el clic ya tiene dueño, y
		nada de lo que ocurra en él es asunto del documento. El cierre al clicar
		fuera lo sigue haciendo cada editor con su propio manejador.
	*/
	overlay.addEventListener('mousedown', (e) => e.stopPropagation());
	// Por la misma razón, el menú contextual de la hoja no debe secuestrar el
	// clic derecho sobre un campo de texto, donde se espera el menú del navegador.
	overlay.addEventListener('contextmenu', (e) => e.stopPropagation());

	/*
		Dentro de un `<dialog>` modal (un formulario en una ventana), el panel va
		dentro del diálogo: el diálogo está en la capa superior del navegador y
		taparía a cualquier cosa en <body>, sin importar su z-index.
	*/
	(cell.closest('dialog[open]') ?? document.body).appendChild(overlay);
	return overlay;
}

/**
 * Recoloca el panel del editor junto a su celda.
 *
 * Hay que llamarla cada vez que el contenido cambia de alto —una lista que se
 * filtra, una vista previa que carga—, porque la colocación depende de la
 * medida real del panel y una medida vieja lo deja desbordado.
 */
function placeOverlay(overlay: HTMLElement, cell: HTMLTableCellElement): void {
	positionFloating(overlay, cell, { gap: 2 });
}

/** El valor de un cierre con guardado: lo tecleado si el editor lo expone; si no, `value`. */
function committedValue(): CellValue {
	if (!activeEditor) return null;
	return activeEditor.read ? activeEditor.read() : activeEditor.value;
}

/**
 * Lo que el editor propio abierto en `cell` confirmaría ahora (su `read`), o
 * `undefined` si no hay uno o no lo expone (listas y paneles con Aceptar, que
 * cuentan al elegir). Para encender «Guardar» en vivo.
 */
export function liveEditorValue(cell: HTMLElement): { value: CellValue } | undefined {
	if (!activeEditor?.read || activeEditor.cell !== cell) return undefined;
	return { value: activeEditor.read() };
}

function disposeActiveEditor() {
	if (!activeEditor) return;
	activeEditor.dispose();
	activeEditor.overlay.remove();
	activeEditor = null;
}

/** Cierra el editor pidiéndole a jspreadsheet que confirme o descarte. */
function closeThroughInstance(instance: any, cell: HTMLTableCellElement, save: boolean) {
	try {
		instance.closeEditor(cell, save);
	} catch {
		disposeActiveEditor();
	}
}

// ---------------------------------------------------------------------------
// Editor unificado de selección (lista fija y fuente externa)
// ---------------------------------------------------------------------------

/**
 * Fuente de datos de un selector.
 *
 * Es lo único que distingue una lista fija de una fuente externa. El render de
 * la celda, el desplegable, el teclado y el commit son idénticos en ambos
 * casos, así que viven una sola vez en `buildPickerEditor`.
 */
interface PickerSource {
	/** Opciones para una consulta. Síncrona en listas fijas, asíncrona si va al servidor. */
	search: (query: string) => Option[] | Promise<Option[]>;
	/** Valor canónico → etiqueta visible. */
	label: (value: CellValue) => string;
	/** Caracteres mínimos antes de consultar. Una lista fija no necesita ninguno. */
	minLength?: number;
	/** Espera entre pulsaciones. Solo tiene sentido si la consulta viaja por red. */
	debounceMs?: number;
	/** Oportunidad de memorizar la etiqueta elegida. */
	remember?: (opt: Option) => void;
	/** Valor canónico → nombre del ícono de su opción (`Option.icon`, SB-39), para la celda. */
	icon?: (value: CellValue) => string | undefined;
	placeholder?: string;
}

/**
 * El ícono de una opción (`Option.icon`, SB-39) como marcado, o vacío si el
 * nombre no está en el registro. El SVG es del registro, no de los datos.
 */
function optionIconHtml(name: string | undefined): string {
	return hasIcon(name) ? `<span class="oc-option-icon" data-icon="${escapeHtml(name)}" aria-hidden="true">${iconSvg(name)}</span>` : '';
}

const CHEVRON_SVG =
	'<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 10l5 5 5-5z" /></svg>';

/**
 * Pinta una celda de selector: etiqueta más botón de expansión.
 *
 * El texto va en un `flex: 1` con `min-width: 0` y el chevron en un
 * `flex-shrink: 0`. Eso corrige el defecto del dropdown nativo, que pintaba el
 * chevron como `background-image` y dejaba que el texto largo pasara por
 * debajo: aquí el botón ocupa su propio espacio en el flujo y el texto se
 * recorta **antes** de alcanzarlo, nunca encima.
 *
 * El envoltorio es un `<div>` y el `<td>` conserva su `display` a propósito: un
 * `td` con `display: flex` sale del modelo de tabla y descuadra la fila.
 */
function renderPickerCell(cell: HTMLTableCellElement, text: string, avatar: HTMLElement | null = null, icon?: string): void {
	cell.classList.add('oc-picker-cell');
	cell.innerHTML = '';

	const wrap = document.createElement('div');
	wrap.className = 'oc-picker';
	if (avatar) wrap.appendChild(avatar);
	// El ícono de la opción (SB-39), solo con un valor que pintar.
	if (text && icon) wrap.insertAdjacentHTML('beforeend', optionIconHtml(icon));

	const label = document.createElement('span');
	label.className = 'oc-picker__text';
	label.textContent = text;

	const chevron = document.createElement('span');
	chevron.className = 'oc-picker__chevron';
	chevron.setAttribute('role', 'button');
	chevron.setAttribute('aria-label', 'Abrir selector');
	chevron.innerHTML = CHEVRON_SVG;

	wrap.append(label, chevron);
	cell.appendChild(wrap);
}

function buildPickerEditor(source: PickerSource) {
	const minLength = source.minLength ?? 0;
	const debounceMs = source.debounceMs ?? 0;
	const paint = (cell: HTMLTableCellElement, value: CellValue) =>
		renderPickerCell(cell, source.label(value), null, source.icon?.(value));

	return {
		createCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return value;
		},
		openEditor(
			cell: HTMLTableCellElement,
			value: CellValue,
			_x: number,
			_y: number,
			instance: any
		) {
			disposeActiveEditor();

			const overlay = mountOverlay(cell, 320);
			overlay.innerHTML = `
				<input class="oc-cell-editor__input" type="text" placeholder="${escapeHtml(
					source.placeholder ?? 'Escribe para filtrar…'
				)}" />
				<div class="oc-cell-editor__list" role="listbox"></div>
			`;
			const input = overlay.querySelector('input') as HTMLInputElement;
			const list = overlay.querySelector('.oc-cell-editor__list') as HTMLDivElement;
			// Se coloca ya, antes de enfocar: dar foco a un elemento sin posición
			// haría que el navegador desplazara la página para alcanzarlo.
			placeOverlay(overlay, cell);

			let results: Option[] = [];
			let highlighted = 0;
			let debounce: ReturnType<typeof setTimeout>;
			let requestToken = 0;

			const renderList = (message?: string) => {
				if (message) {
					list.innerHTML = `<div class="oc-cell-editor__hint">${escapeHtml(message)}</div>`;
				} else if (results.length === 0) {
					list.innerHTML = `<div class="oc-cell-editor__hint">Sin resultados</div>`;
				} else {
					list.innerHTML = results
						.map(
							(opt, i) =>
								// El valor a la derecha sirve cuando es un código (`chg_programado`);
								// si es igual a la etiqueta, solo la repetiría (SB-39).
								`<div class="oc-cell-editor__option${i === highlighted ? ' is-active' : ''}" data-index="${i}">
								${optionIconHtml(opt.icon)}<span class="oc-cell-editor__label">${escapeHtml(opt.label)}</span>
								${opt.value === opt.label ? '' : `<span class="oc-cell-editor__value">${escapeHtml(opt.value)}</span>`}
							</div>`
						)
						.join('');
				}
				// Filtrar cambia el alto de la lista, y con él la colocación correcta:
				// un panel abierto hacia arriba debe recrecer hacia arriba, no taparse.
				placeOverlay(overlay, cell);
			};

			/** Deja resaltada la opción que ya tiene la celda, si sigue en la lista. */
			const highlightCurrent = () => {
				const at = results.findIndex((o) => o.value === activeEditor?.value);
				highlighted = at >= 0 ? at : 0;
			};

			const runSearch = async (query: string) => {
				if (query.length < minLength) {
					results = [];
					renderList(`Escribe al menos ${minLength} caracteres`);
					return;
				}

				const token = ++requestToken;
				const outcome = source.search(query);

				// Una lista fija responde en el mismo tick: mostrar «Buscando…»
				// provocaría un parpadeo por algo que nunca llega a esperarse.
				if (!(outcome instanceof Promise)) {
					results = outcome;
					highlightCurrent();
					renderList();
					return;
				}

				renderList('Buscando…');
				try {
					const found = await outcome;
					if (token !== requestToken) return; // llegó una respuesta vieja
					results = found;
					highlightCurrent();
					renderList();
				} catch {
					if (token === requestToken) renderList('Error al consultar la fuente');
				}
			};

			const commit = (opt: Option) => {
				source.remember?.(opt);
				if (activeEditor) activeEditor.value = opt.value;
				closeThroughInstance(instance, cell, true);
			};

			/**
			 * Confirma lo escrito aunque no case con ninguna opción.
			 *
			 * Es la misma regla que en el pegado: se admite el valor y el validador
			 * lo marca como fuera de catálogo. Descartarlo en silencio dejaría al
			 * usuario sin saber por qué su dato desapareció.
			 */
			const commitRaw = () => {
				const typed = input.value.trim();
				if (activeEditor) activeEditor.value = typed === '' ? null : typed;
				closeThroughInstance(instance, cell, true);
			};

			input.addEventListener('input', () => {
				clearTimeout(debounce);
				const q = input.value.trim();
				if (debounceMs === 0) runSearch(q);
				else debounce = setTimeout(() => runSearch(q), debounceMs);
			});

			input.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					e.stopPropagation();
					if (results.length === 0) return;
					highlighted =
						(highlighted + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
					renderList();
				} else if (e.key === 'Enter') {
					e.preventDefault();
					e.stopPropagation();
					if (results[highlighted]) commit(results[highlighted]);
					else commitRaw();
				} else if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					closeThroughInstance(instance, cell, false);
				} else {
					// Evita que jspreadsheet capture las teclas de navegación.
					e.stopPropagation();
				}
			});

			list.addEventListener('mousedown', (e: MouseEvent) => {
				const target = (e.target as HTMLElement).closest('.oc-cell-editor__option');
				if (!target) return;
				e.preventDefault();
				const opt = results[Number(target.getAttribute('data-index'))];
				if (opt) commit(opt);
			});

			const onDocMouseDown = (e: MouseEvent) => {
				if (!overlay.contains(e.target as Node)) closeThroughInstance(instance, cell, false);
			};
			// Solo si el editor sigue abierto: un cierre rápido (Enter antes de este
			// turno) dejaría el listener vivo, y el siguiente clic en cualquier parte
			// «cerraría» un editor que ya no existe, dejando la celda en null.
			setTimeout(() => {
				if (activeEditor?.overlay === overlay) document.addEventListener('mousedown', onDocMouseDown);
			}, 0);

			activeEditor = {
				cell,
				overlay,
				value,
				original: value,
				dispose: () => {
					clearTimeout(debounce);
					document.removeEventListener('mousedown', onDocMouseDown);
				}
			};

			input.focus();
			runSearch('');
		},
		closeEditor(cell: HTMLTableCellElement, save: boolean): CellValue {
			const result = save ? (activeEditor?.value ?? null) : (activeEditor?.original ?? null);
			disposeActiveEditor();
			paint(cell, result);
			return result;
		}
	};
}

function remoteLabel(value: CellValue, ctx: CellTypeContext): string {
	if (isBlank(value)) return '';
	return ctx.labelCache.get(String(value)) ?? String(value);
}

function escapeHtml(s: string): string {
	return s.replace(
		/[&<>"']/g,
		(c) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
	);
}

// ---------------------------------------------------------------------------
// Editor: lookup (registro de otro recurso, en mini tabla; SB-21)
// ---------------------------------------------------------------------------

/**
 * Llave del nombre de un id en `labelCache`. Va por columna: dos columnas
 * lookup sobre recursos distintos pueden repetir ids.
 */
export function lookupKey(field: string, value: unknown): string {
	return `lookup␟${field}␟${String(value)}`;
}

function lookupLabel(value: CellValue, column: ColumnDef, ctx: { labelCache: Map<string, string> }): string {
	if (isBlank(value)) return '';
	return ctx.labelCache.get(lookupKey(column.field, value)) ?? String(value);
}

/**
 * Texto → valor, con lo que el cliente ya conoce: un id conocido tal cual, o
 * el único registro cuyo nombre coincide (sin acentos ni mayúsculas). Si hay
 * varios, se anota como ambiguo; si no hay ninguno, `null`.
 */
export function resolveLookupText(text: string, column: ColumnDef, labelCache: Map<string, string>): string | null {
	const s = text.trim();
	if (s === '') return null;
	if (labelCache.has(lookupKey(column.field, s))) return s;
	const prefix = lookupKey(column.field, '');
	const needle = normalizeForSearch(s);
	// Resuelto por el servidor por otro campo (una clave corta, `resolveBy`).
	const byKey = column.lookup?.resolved?.get(needle);
	if (byKey !== undefined) return byKey;
	const found = new Set<string>();
	for (const [key, label] of labelCache) {
		if (key.startsWith(prefix) && normalizeForSearch(label) === needle) found.add(key.slice(prefix.length));
	}
	if (found.size === 1) return [...found][0];
	if (found.size > 1) column.lookup?.ambiguous?.set(needle, found.size);
	return null;
}

/** Pinta el valor de una columna de la mini tabla con el formato de su tipo. */
function lookupCellHtml(value: unknown, def: LookupColumnDef, ctx: CellTypeContext): string {
	if (def.type === 'image') {
		if (isBlank(value) || !IMAGE_URL.test(String(value))) return '';
		const round = def.shape === 'round' ? ' is-round' : '';
		return `<img class="oc-lookup__img${round}" src="${escapeHtml(String(value))}" alt="" loading="lazy" />`;
	}
	const column = { ...def, field: '' } as ColumnDef;
	return escapeHtml(getCellType(def.type).format((value ?? null) as CellValue, column, ctx));
}

/**
 * Popover de una columna lookup: buscador y una mini tabla del recurso.
 *
 * Es una tabla HTML y no otra instancia de jspreadsheet: la librería guarda en
 * un estado global la hoja activa y el teclado, y una hoja dentro del editor
 * de otra se pelearía con ella. Lo demás —clic fuera, Esc, colocación,
 * respuestas viejas descartadas— sigue el mismo patrón que `buildPickerEditor`.
 *
 * Paginado desde el principio: pide `pageSize` filas y, al acercarse al fondo
 * (con el scroll o con ↓), el tramo siguiente.
 */
function buildLookupEditor(column: ColumnDef, ctx: CellTypeContext) {
	const lookup = column.lookup!;
	const pageSize = lookup.pageSize ?? 50;
	const minLength = lookup.minLength ?? 0;
	const fields = Object.keys(lookup.columns);
	const widths = fields.map((f) => lookup.columns[f]!.width ?? 160);
	const paint = (cell: HTMLTableCellElement, value: CellValue) => {
		const label = lookupLabel(value, column, ctx);
		// La foto o el ícono del registro elegido (SB-29, SB-39), de la caché.
		const media = column.avatar && !isBlank(value) ? cachedMedia(ctx.labelCache, column.field, value) : null;
		const avatar = media ? avatarNode(column.avatar!, label, media.image, media.icon) : null;
		renderPickerCell(cell, label, avatar);
	};
	/**
	 * La columna de la mini tabla que lleva la miniatura: la del nombre, o la
	 * primera. Si la mini tabla ya trae su columna de imagen, no se repite.
	 */
	const avatarAt = Object.values(lookup.columns).some((c) => c.type === 'image')
		? -1
		: Math.max(0, fields.indexOf(lookup.display));

	return {
		createCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return value;
		},
		openEditor(cell: HTMLTableCellElement, value: CellValue, _x: number, _y: number, instance: any) {
			disposeActiveEditor();

			// Ancho: el de sus columnas, con tope en la pantalla. Si no cabe, scroll horizontal.
			const natural = widths.reduce((a, b) => a + b, 0) + 18;
			const overlay = mountOverlay(cell, Math.min(Math.max(natural, 280), window.innerWidth - 32));
			overlay.classList.add('oc-lookup-editor');
			const header =
				fields.length > 1
					? `<thead><tr>${fields
							.map((f) => `<th>${escapeHtml(lookup.columns[f]!.label ?? '')}</th>`)
							.join('')}</tr></thead>`
					: '';
			overlay.innerHTML = `
				<input class="oc-cell-editor__input" type="text" placeholder="Escribe para buscar…" />
				<div class="oc-lookup__scroll">
					<table class="oc-lookup">
						<colgroup>${widths.map((w) => `<col style="width:${w}px" />`).join('')}</colgroup>
						${header}
						<tbody></tbody>
					</table>
				</div>
				<div class="oc-lookup__foot"></div>
			`;
			const input = overlay.querySelector('input') as HTMLInputElement;
			const scroller = overlay.querySelector('.oc-lookup__scroll') as HTMLDivElement;
			const body = overlay.querySelector('tbody') as HTMLTableSectionElement;
			const foot = overlay.querySelector('.oc-lookup__foot') as HTMLDivElement;
			placeOverlay(overlay, cell);

			let rows: Record<string, unknown>[] = [];
			let total = 0;
			let highlighted = -1;
			let query = '';
			let loading = false;
			let failed = false;
			let token = 0;
			let abort: AbortController | null = null;
			let debounce: ReturnType<typeof setTimeout>;
			const current = isBlank(value) ? null : String(value);

			const renderFoot = () => {
				if (query.length < minLength) foot.textContent = `Escribe al menos ${minLength} caracteres`;
				else if (failed) foot.textContent = 'Error al consultar la fuente';
				else if (loading && rows.length === 0) foot.textContent = 'Buscando…';
				else if (rows.length === 0) foot.textContent = 'Sin resultados';
				else foot.textContent = `${rows.length.toLocaleString('es-MX')} de ${total.toLocaleString('es-MX')}${loading ? ' · cargando…' : ''}`;
			};

			const renderRows = () => {
				body.innerHTML = rows
					.map(
						(row, i) =>
							`<tr class="${i === highlighted ? 'is-active' : ''}" data-index="${i}">${fields
								.map((f) => `<td>${lookupCellHtml(row[f], lookup.columns[f]!, ctx)}</td>`)
								.join('')}</tr>`
					)
					.join('');
				// La misma miniatura que tendrá la celda, para reconocer a quién se elige.
				if (column.avatar && avatarAt >= 0) {
					body.querySelectorAll<HTMLTableRowElement>('tr').forEach((tr, i) => {
						const row = rows[i]!;
						const text = String(row[lookup.display] ?? '');
						const { image, icon } = recordMedia(column.avatar!, row);
						const node = avatarNode(column.avatar!, text, image, icon);
						const td = tr.cells[avatarAt];
						if (node && td) {
							td.classList.add('oc-lookup__with-avatar');
							td.prepend(node);
						}
					});
				}
				renderFoot();
				placeOverlay(overlay, cell);
			};

			const reveal = () => {
				const tr = body.querySelector<HTMLElement>(`tr[data-index="${highlighted}"]`);
				tr?.scrollIntoView({ block: 'nearest' });
			};

			const hasMore = () => rows.length < total;

			/** `reset`: consulta nueva desde el principio; si no, el tramo siguiente. */
			const load = async (reset: boolean) => {
				if (!reset && (loading || !hasMore())) return;
				abort?.abort();
				const mine = ++token;
				const controller = (abort = new AbortController());
				if (reset) {
					rows = [];
					total = 0;
					highlighted = -1;
					scroller.scrollTop = 0;
				}
				failed = false;
				if (query.length < minLength) {
					loading = false;
					renderRows();
					return;
				}
				loading = true;
				renderFoot();
				try {
					const page = await lookup.search(query, { offset: rows.length, limit: pageSize }, controller.signal);
					if (mine !== token) return; // llegó una respuesta vieja
					rows = rows.concat(page.rows);
					total = page.total;
					if (highlighted < 0) {
						const at = current === null ? -1 : rows.findIndex((r) => String(r[lookup.value]) === current);
						highlighted = at >= 0 ? at : rows.length > 0 ? 0 : -1;
					}
					loading = false;
					renderRows();
					if (reset) reveal();
				} catch {
					if (mine !== token) return;
					loading = false;
					failed = true;
					renderFoot();
				}
			};

			const commit = (row: Record<string, unknown>) => {
				const id = String(row[lookup.value]);
				ctx.labelCache.set(lookupKey(column.field, id), String(row[lookup.display] ?? id));
				if (column.avatar) rememberMedia(ctx.labelCache, column.field, id, recordMedia(column.avatar, row));
				if (activeEditor) activeEditor.value = id;
				closeThroughInstance(instance, cell, true);
			};

			const move = (step: number) => {
				if (rows.length === 0) return;
				highlighted = Math.max(0, Math.min(rows.length - 1, highlighted + step));
				body.querySelectorAll('tr.is-active').forEach((tr) => tr.classList.remove('is-active'));
				body.querySelector(`tr[data-index="${highlighted}"]`)?.classList.add('is-active');
				reveal();
				if (highlighted >= rows.length - 5) load(false);
			};

			input.addEventListener('input', () => {
				clearTimeout(debounce);
				debounce = setTimeout(() => {
					query = input.value.trim();
					load(true);
				}, 220);
			});

			input.addEventListener('keydown', (e: KeyboardEvent) => {
				e.stopPropagation();
				if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					move(e.key === 'ArrowDown' ? 1 : -1);
				} else if (e.key === 'PageDown' || e.key === 'PageUp') {
					e.preventDefault();
					move(e.key === 'PageDown' ? 8 : -8);
				} else if (e.key === 'Enter') {
					e.preventDefault();
					const row = rows[highlighted];
					if (row) commit(row);
				} else if (e.key === 'Escape') {
					e.preventDefault();
					closeThroughInstance(instance, cell, false);
				}
			});

			// Lazy loading: el siguiente tramo al acercarse al fondo.
			scroller.addEventListener('scroll', () => {
				if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48) load(false);
			});

			body.addEventListener('mousedown', (e: MouseEvent) => {
				const tr = (e.target as HTMLElement).closest('tr');
				if (!tr) return;
				e.preventDefault();
				const row = rows[Number(tr.getAttribute('data-index'))];
				if (row) commit(row);
			});

			const onDocMouseDown = (e: MouseEvent) => {
				if (!overlay.contains(e.target as Node)) closeThroughInstance(instance, cell, false);
			};
			// Solo si el editor sigue abierto: un cierre rápido (Enter antes de este
			// turno) dejaría el listener vivo, y el siguiente clic en cualquier parte
			// «cerraría» un editor que ya no existe, dejando la celda en null.
			setTimeout(() => {
				if (activeEditor?.overlay === overlay) document.addEventListener('mousedown', onDocMouseDown);
			}, 0);

			activeEditor = {
				cell,
				overlay,
				value,
				original: value,
				dispose: () => {
					clearTimeout(debounce);
					abort?.abort();
					token++;
					document.removeEventListener('mousedown', onDocMouseDown);
				}
			};

			// Un texto que no es un id conocido (pegado ambiguo o sin coincidencia)
			// abre el buscador ya filtrado con él.
			if (current !== null && !ctx.labelCache.has(lookupKey(column.field, current))) {
				input.value = current;
				query = current;
			}
			input.focus();
			input.select();
			load(true);
		},
		closeEditor(cell: HTMLTableCellElement, save: boolean): CellValue {
			const result = save ? (activeEditor?.value ?? null) : (activeEditor?.original ?? null);
			disposeActiveEditor();
			paint(cell, result);
			return result;
		}
	};
}

// ---------------------------------------------------------------------------
// Editor: fecha y fecha-hora (calendario propio)
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
	'enero',
	'febrero',
	'marzo',
	'abril',
	'mayo',
	'junio',
	'julio',
	'agosto',
	'septiembre',
	'octubre',
	'noviembre',
	'diciembre'
];

/** La semana empieza en lunes, como se lee un calendario en México. */
const WEEKDAY_INITIALS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

interface DateParts {
	y: number;
	mo: number;
	d: number;
	hh: string;
	mi: string;
}

function splitCanonical(canonical: CellValue): DateParts | null {
	if (isBlank(canonical)) return null;
	const m = String(canonical).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
	if (!m) return null;
	return { y: +m[1], mo: +m[2], d: +m[3], hh: m[4] ?? '00', mi: m[5] ?? '00' };
}

function joinCanonical(p: DateParts, withTime: boolean): string {
	const date = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
	return withTime ? `${date} ${p.hh}:${p.mi}` : date;
}

function isoOf(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Celdas de la rejilla de un mes, con el relleno de los meses vecinos.
 *
 * Devuelve **siempre 42** (seis semanas). Un número variable haría que el panel
 * cambiara de alto al navegar entre meses y los botones saltaran bajo el cursor.
 */
function monthGrid(y: number, mo: number): { iso: string; day: number; outside: boolean }[] {
	const first = new Date(y, mo - 1, 1);
	// getDay() da 0 para domingo; la rejilla arranca en lunes.
	const lead = (first.getDay() + 6) % 7;
	const cells: { iso: string; day: number; outside: boolean }[] = [];
	for (let i = 0; i < 42; i++) {
		const cur = new Date(y, mo - 1, 1 - lead + i);
		cells.push({
			iso: isoOf(cur),
			day: cur.getDate(),
			outside: cur.getMonth() + 1 !== mo || cur.getFullYear() !== y
		});
	}
	return cells;
}

/**
 * Calendario propio, en lugar del de jSuites.
 *
 * Aporta lo que faltaba: navegación de mes visible, «hoy» señalado, rejilla de
 * alto fijo, campo para teclear la fecha directamente —que es como trabaja
 * quien captura muchas filas—, hora separada cuando el tipo la lleva, y
 * acciones explícitas de limpiar y aceptar.
 */
function buildDateEditor(withTime: boolean) {
	const toDisplay = withTime ? formatDateTimeDisplay : formatDateDisplay;
	const toCanonical = withTime ? toCanonicalDateTime : toCanonicalDate;

	const paint = (cell: HTMLTableCellElement, value: CellValue) => {
		cell.textContent = toDisplay(value);
	};

	return {
		createCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return value;
		},
		openEditor(
			cell: HTMLTableCellElement,
			value: CellValue,
			_x: number,
			_y: number,
			instance: any
		) {
			disposeActiveEditor();

			const overlay = mountOverlay(cell, 270);
			overlay.classList.add('oc-cal');
			overlay.innerHTML = `
				<input class="oc-cell-editor__input oc-cal__typed" type="text"
				       placeholder="${withTime ? 'DD/MM/AAAA HH:mm' : 'DD/MM/AAAA'}" />
				<div class="oc-cal__head">
					<button type="button" class="oc-cal__nav" data-step="-1" aria-label="Mes anterior">‹</button>
					<span class="oc-cal__title"></span>
					<button type="button" class="oc-cal__nav" data-step="1" aria-label="Mes siguiente">›</button>
				</div>
				<div class="oc-cal__dow">${WEEKDAY_INITIALS.map((d) => `<span>${d}</span>`).join('')}</div>
				<div class="oc-cal__grid"></div>
				${
					withTime
						? `<label class="oc-cal__time">Hora <input type="time" class="oc-cal__timeinput" /></label>`
						: ''
				}
				<div class="oc-cal__foot">
					<button type="button" data-action="today">Hoy</button>
					<button type="button" data-action="clear">Limpiar</button>
					<button type="button" data-action="accept" class="is-primary">Aceptar</button>
				</div>
			`;

			const typed = overlay.querySelector('.oc-cal__typed') as HTMLInputElement;
			const title = overlay.querySelector('.oc-cal__title') as HTMLSpanElement;
			const grid = overlay.querySelector('.oc-cal__grid') as HTMLDivElement;
			const timeInput = overlay.querySelector('.oc-cal__timeinput') as HTMLInputElement | null;

			const today = isoOf(new Date());
			let draft = toCanonical(value);
			const anchor = splitCanonical(draft) ?? splitCanonical(today)!;
			let viewY = anchor.y;
			let viewMo = anchor.mo;
			/** Día enfocado por teclado. Arranca en el valor actual o en hoy. */
			let cursor = draft ? String(draft).slice(0, 10) : today;

			/** `syncTyped` en false evita pisar lo que el usuario está escribiendo. */
			const render = (syncTyped = true) => {
				title.textContent = `${MONTH_NAMES[viewMo - 1]} ${viewY}`;
				const selected = draft ? String(draft).slice(0, 10) : null;

				grid.innerHTML = monthGrid(viewY, viewMo)
					.map((c) => {
						const cls = ['oc-cal__day'];
						if (c.outside) cls.push('is-outside');
						if (c.iso === today) cls.push('is-today');
						if (c.iso === selected) cls.push('is-selected');
						if (c.iso === cursor) cls.push('is-cursor');
						return `<button type="button" class="${cls.join(' ')}" data-date="${c.iso}">${c.day}</button>`;
					})
					.join('');

				if (syncTyped) typed.value = draft ? toDisplay(draft) : '';
				if (timeInput) {
					const p = splitCanonical(draft);
					timeInput.value = `${p?.hh ?? '00'}:${p?.mi ?? '00'}`;
				}
			};

			const setDate = (iso: string, syncTyped = true) => {
				const p = splitCanonical(iso);
				if (!p) return;
				// La hora elegida se conserva al cambiar de día.
				const prev = splitCanonical(draft);
				draft = joinCanonical(
					{ ...p, hh: prev?.hh ?? '00', mi: prev?.mi ?? '00' },
					withTime
				);
				cursor = iso;
				viewY = p.y;
				viewMo = p.mo;
				render(syncTyped);
			};

			const commit = () => {
				if (activeEditor) activeEditor.value = draft;
				closeThroughInstance(instance, cell, true);
			};

			const shiftCursor = (days: number) => {
				const p = splitCanonical(cursor);
				if (!p) return;
				setDate(isoOf(new Date(p.y, p.mo - 1, p.d + days)));
			};

			const shiftMonth = (months: number) => {
				const d = new Date(viewY, viewMo - 1 + months, 1);
				viewY = d.getFullYear();
				viewMo = d.getMonth() + 1;
				render();
			};

			render();

			// Un clic en un día cierra si solo se pide fecha. Con hora el panel se
			// queda abierto: falta la mitad del dato por elegir.
			overlay.addEventListener('mousedown', (e: MouseEvent) => {
				const el = (e.target as HTMLElement).closest('button');
				if (!el) return;
				e.preventDefault();

				const iso = el.getAttribute('data-date');
				if (iso) {
					setDate(iso);
					if (!withTime) commit();
					return;
				}

				const step = el.getAttribute('data-step');
				if (step) {
					shiftMonth(Number(step));
					return;
				}

				switch (el.getAttribute('data-action')) {
					case 'today':
						setDate(today);
						if (!withTime) commit();
						break;
					case 'clear':
						draft = null;
						commit();
						break;
					case 'accept':
						commit();
						break;
				}
			});

			timeInput?.addEventListener('input', () => {
				const m = timeInput.value.match(/^(\d{2}):(\d{2})$/);
				if (!m) return;
				const base = splitCanonical(draft) ?? splitCanonical(cursor)!;
				draft = joinCanonical({ ...base, hh: m[1], mi: m[2] }, true);
				render();
			});

			// Teclear la fecha es la vía rápida de captura, así que manda sobre la
			// rejilla: si el texto es interpretable, el calendario se mueve con él.
			typed.addEventListener('input', () => {
				const parsed = toCanonical(typed.value);
				if (parsed) setDate(String(parsed).slice(0, 10), false);
			});

			overlay.addEventListener('keydown', (e: KeyboardEvent) => {
				// Sin esto jspreadsheet se queda las flechas y mueve la selección.
				e.stopPropagation();

				const inText = e.target === typed;
				switch (e.key) {
					case 'Enter':
						e.preventDefault();
						commit();
						break;
					case 'Escape':
						e.preventDefault();
						closeThroughInstance(instance, cell, false);
						break;
					case 'ArrowUp':
						e.preventDefault();
						shiftCursor(-7);
						break;
					case 'ArrowDown':
						e.preventDefault();
						shiftCursor(7);
						break;
					case 'PageUp':
						e.preventDefault();
						shiftMonth(-1);
						break;
					case 'PageDown':
						e.preventDefault();
						shiftMonth(1);
						break;
					// Izquierda y derecha solo navegan fuera del campo de texto, donde
					// se necesitan para mover el cursor de edición.
					case 'ArrowLeft':
						if (!inText) {
							e.preventDefault();
							shiftCursor(-1);
						}
						break;
					case 'ArrowRight':
						if (!inText) {
							e.preventDefault();
							shiftCursor(1);
						}
						break;
				}
			});

			const onDocMouseDown = (e: MouseEvent) => {
				if (!overlay.contains(e.target as Node)) closeThroughInstance(instance, cell, false);
			};
			// Solo si el editor sigue abierto: un cierre rápido (Enter antes de este
			// turno) dejaría el listener vivo, y el siguiente clic en cualquier parte
			// «cerraría» un editor que ya no existe, dejando la celda en null.
			setTimeout(() => {
				if (activeEditor?.overlay === overlay) document.addEventListener('mousedown', onDocMouseDown);
			}, 0);

			activeEditor = {
				cell,
				overlay,
				value: draft,
				original: value,
				read: () => draft,
				dispose: () => document.removeEventListener('mousedown', onDocMouseDown)
			};

			placeOverlay(overlay, cell);
			typed.focus();
			typed.select();
		},
		closeEditor(cell: HTMLTableCellElement, save: boolean): CellValue {
			const result = save ? committedValue() : (activeEditor?.original ?? null);
			disposeActiveEditor();
			paint(cell, result);
			return result;
		}
	};
}

// ---------------------------------------------------------------------------
// Renderizador: texto recortado a N líneas (solo lectura)
// ---------------------------------------------------------------------------

/**
 * Celda de solo lectura que ajusta el texto hasta `lines` líneas y recorta el
 * resto con puntos suspensivos.
 *
 * El recorte (`line-clamp`) no puede aplicarse al `<td>`: exige mostrar el
 * elemento como caja flexible, y eso rompería la tabla. Por eso el texto va en
 * un `<div class="oc-clamp">` dentro de la celda; el CSS está en
 * `datagrid.css`. Si el texto no cabe, `attachClampPopover` lo muestra entero
 * al pasar el mouse.
 *
 * Solo lectura a propósito: un tipo propio sustituye el manejo de texto nativo
 * de jspreadsheet, y en una columna editable habría que conectar además el
 * editor (abrir, confirmar, cancelar).
 */
export function clampedTextCell(lines = 2) {
	const paint = (cell: HTMLTableCellElement, value: CellValue) => {
		const text = isBlank(value) ? '' : String(value);
		let box = cell.querySelector<HTMLDivElement>(':scope > .oc-clamp');
		if (!box) {
			cell.innerHTML = '';
			box = document.createElement('div');
			box.className = 'oc-clamp';
			box.style.setProperty('--dg-clamp-lines', String(lines));
			cell.appendChild(box);
		}
		box.textContent = text;
	};

	return {
		createCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return value;
		}
	};
}

// ---------------------------------------------------------------------------
// Editor: imagen y archivo (URL, o subir; SB-30)
// ---------------------------------------------------------------------------

/** Un valor solo se pinta como imagen si de verdad parece una URL. */
const IMAGE_URL = /^(https?:\/\/|data:image\/|\/)/;
/** Un archivo es una URL `http(s)` o una ruta; nunca `javascript:` ni `data:`. */
const FILE_URL = /^(https?:\/\/|\/)/;

/** Ícono de un archivo por su extensión (de su nombre o de su URL). */
function fileIcon(url: string): string {
	const ext = fileNameOf(url).toLowerCase().split('.').pop() ?? '';
	if (['md', 'markdown'].includes(ext)) return 'file-text';
	if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'file-image';
	if (['xml', 'json'].includes(ext)) return 'file-code';
	if (['csv', 'xlsx', 'xls'].includes(ext)) return 'file-spreadsheet';
	if (['zip'].includes(ext)) return 'file-archive';
	if (['pdf', 'txt', 'doc', 'docx'].includes(ext)) return 'file-text';
	return 'file';
}

/** `2097152` → `2 MB`. */
function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 2) return `${Math.round((bytes / 1024 ** 2) * 10) / 10} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/**
 * Un archivo en la celda: ícono por tipo, nombre, tamaño (si se conoce) y ↗
 * para abrirlo (o descargarlo: el servidor decide por el tipo, SB-30).
 */
function fileNode(ref: FileRef): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'oc-file';
	const icon = document.createElement('span');
	icon.className = 'oc-file__icon';
	icon.innerHTML = iconSvg(fileIcon(ref.name || ref.url));
	const name = document.createElement('span');
	name.className = 'oc-file__name';
	name.textContent = ref.name || fileNameOf(ref.url);
	wrap.append(icon, name);
	if (ref.size > 0) {
		const size = document.createElement('span');
		size.className = 'oc-file__size';
		size.textContent = formatBytes(ref.size);
		wrap.append(size);
	}
	const open = document.createElement('a');
	open.className = 'oc-file__open';
	open.href = ref.url;
	open.target = '_blank';
	open.rel = 'noopener noreferrer';
	open.title = 'Abrir';
	open.setAttribute('aria-label', `Abrir ${name.textContent}`);
	open.innerHTML = iconSvg('external-link');
	wrap.append(open);
	return wrap;
}

/** `application/pdf` → `PDF`, `image/jpeg` → `JPEG`. */

const typeLabel = (t: string) => (t.split('/')[1] ?? t).replace(/^vnd\..*\./, '').toUpperCase();

/**
 * La celda de una imagen o un archivo, y su editor.
 *
 * - **Imagen:** la miniatura; un enlace roto muestra ⚠︎.
 * - **Archivo:** ícono y nombre (el último tramo de la URL); ↗ lo abre en otra
 *   pestaña.
 *
 * El editor acepta pegar una URL y, si la columna tiene `upload`, **Subir**,
 * arrastrar un archivo al panel o pegarlo. Al subir, la URL que regresa queda
 * en la celda (editada, se guarda con el lote) y el panel se cierra.
 */
function buildMediaEditor(column: ColumnDef, kind: 'image' | 'file') {
	const pattern = kind === 'image' ? IMAGE_URL : FILE_URL;

	const paint = (cell: HTMLTableCellElement, value: CellValue) => {
		cell.innerHTML = '';
		cell.classList.add(kind === 'image' ? 'oc-image-cell' : 'oc-file-cell');
		if (kind === 'image') cell.classList.toggle('is-round', column.shape === 'round');

		// Un archivo puede venir como `{ url, name, type, size }` (SB-38; también la forma obsoleta) o como su URL (SB-30).
		const ref = kind === 'file' ? toFileRef(value) : null;
		const raw = ref ? ref.url : value;
		// Sin esta guarda, cualquier texto suelto en la celda acabaría en `src`
		// o en `href`, y el navegador lo pediría o lo abriría.
		if (isBlank(raw) || !pattern.test(String(raw))) {
			const placeholder = document.createElement('span');
			placeholder.className = 'oc-image-empty';
			placeholder.textContent = isBlank(raw) ? '—' : '⚠︎';
			cell.appendChild(placeholder);
			return;
		}
		const url = String(raw);

		if (kind === 'image') {
			const img = document.createElement('img');
			img.src = url;
			img.alt = 'Imagen';
			img.className = 'oc-image-thumb';
			img.onerror = () => {
				cell.innerHTML = '<span class="oc-image-empty">⚠︎</span>';
			};
			cell.appendChild(img);
			return;
		}

		cell.appendChild(fileNode(ref ?? { url, name: fileNameOf(url), type: '', size: 0 }));
	};

	return {
		createCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return value;
		},
		openEditor(
			cell: HTMLTableCellElement,
			value: CellValue,
			_x: number,
			_y: number,
			instance: any
		) {
			disposeActiveEditor();
			const upload = column.upload;
			const overlay = mountOverlay(cell, 340);
			overlay.classList.add('oc-media-editor');
			overlay.innerHTML = `
				<input class="oc-cell-editor__input" type="text" placeholder="${upload ? 'Pega una URL o sube un archivo' : 'https://…'}" />
				<div class="oc-cell-editor__preview"></div>
				<div class="oc-cell-editor__status" role="status"></div>
				<div class="oc-cell-editor__actions">
					${upload ? '<button type="button" data-action="upload" class="oc-cell-editor__upload">Subir</button>' : ''}
					<span class="oc-cell-editor__spacer"></span>
					<button type="button" data-action="clear">Quitar</button>
					<button type="button" data-action="save" class="is-primary">Aceptar</button>
				</div>
				${upload ? `<input type="file" class="oc-cell-editor__file" hidden ${upload.accept?.length ? `accept="${escapeHtml(upload.accept.join(','))}"` : ''} />` : ''}
			`;
			const input = overlay.querySelector('input.oc-cell-editor__input') as HTMLInputElement;
			const preview = overlay.querySelector('.oc-cell-editor__preview') as HTMLDivElement;
			const status = overlay.querySelector('.oc-cell-editor__status') as HTMLDivElement;
			const picker = overlay.querySelector<HTMLInputElement>('input.oc-cell-editor__file');
			input.value = value == null ? '' : kind === 'file' ? (toFileRef(value)?.url ?? '') : String(value);
			let busy = false;

			const refreshPreview = () => {
				const url = input.value.trim();
				preview.innerHTML = '';
				preview.hidden = !url;
				if (url && pattern.test(url)) {
					if (kind === 'image') {
						const img = document.createElement('img');
						img.src = url;
						img.alt = 'Vista previa';
						preview.appendChild(img);
					} else {
						const link = document.createElement('a');
						link.href = url;
						link.target = '_blank';
						link.rel = 'noopener noreferrer';
						link.className = 'oc-file oc-file--preview';
						link.innerHTML = `<span class="oc-file__icon">${iconSvg(fileIcon(url))}</span>`;
						const name = document.createElement('span');
						name.className = 'oc-file__name';
						name.textContent = fileNameOf(url);
						link.appendChild(name);
						preview.appendChild(link);
					}
				}
				// La vista previa aparece y desaparece, así que el panel cambia de alto.
				placeOverlay(overlay, cell);
			};
			refreshPreview();

			const setStatus = (text: string, error = false) => {
				status.textContent = text;
				status.classList.toggle('is-error', error);
				placeOverlay(overlay, cell);
			};

			const commit = (url: CellValue) => {
				if (activeEditor) activeEditor.value = url;
				closeThroughInstance(instance, cell, true);
			};

			/** Sube el archivo; con éxito, la URL queda en la celda y el panel se cierra. */
			const send = async (file: File) => {
				if (!upload || busy) return;
				if (upload.maxSize && file.size > upload.maxSize) {
					setStatus(`El archivo pasa del máximo (${formatBytes(upload.maxSize)})`, true);
					return;
				}
				if (upload.accept?.length && file.type && !upload.accept.includes(file.type)) {
					setStatus(`Tipo no permitido. Se aceptan: ${upload.accept.map(typeLabel).join(', ')}`, true);
					return;
				}
				busy = true;
				overlay.classList.add('is-busy');
				setStatus(`Subiendo ${file.name}…`);
				try {
					const result = await upload.send(file);
					if (activeEditor?.overlay !== overlay) return;
					// Un archivo queda con su nombre, tipo y tamaño (SB-38); una imagen, con su URL.
					commit(kind === 'file' ? { url: result.url, name: result.name || fileNameOf(result.url), type: result.type, size: result.size } : result.url);
				} catch (err) {
					if (activeEditor?.overlay !== overlay) return;
					setStatus(err instanceof Error ? err.message : 'No se pudo subir el archivo', true);
				} finally {
					busy = false;
					overlay.classList.remove('is-busy');
				}
			};

			picker?.addEventListener('change', () => {
				const file = picker.files?.[0];
				if (file) void send(file);
				picker.value = '';
			});
			if (upload) {
				overlay.addEventListener('dragover', (e) => {
					e.preventDefault();
					overlay.classList.add('is-dropping');
				});
				overlay.addEventListener('dragleave', () => overlay.classList.remove('is-dropping'));
				overlay.addEventListener('drop', (e) => {
					e.preventDefault();
					overlay.classList.remove('is-dropping');
					const file = e.dataTransfer?.files?.[0];
					if (file) void send(file);
				});
				// Pegar una imagen copiada (una captura, por ejemplo) la sube.
				input.addEventListener('paste', (e) => {
					const file = e.clipboardData?.files?.[0];
					if (!file) return;
					e.preventDefault();
					void send(file);
				});
			}

			input.addEventListener('input', () => {
				setStatus('');
				refreshPreview();
			});
			input.addEventListener('keydown', (e: KeyboardEvent) => {
				e.stopPropagation();
				if (e.key === 'Enter') commit(input.value.trim() || null);
				else if (e.key === 'Escape') closeThroughInstance(instance, cell, false);
			});

			overlay.addEventListener('mousedown', (e: MouseEvent) => {
				const action = (e.target as HTMLElement).closest('[data-action]')?.getAttribute('data-action');
				if (!action) return;
				e.preventDefault();
				if (busy) return;
				if (action === 'upload') picker?.click();
				else commit(action === 'clear' ? null : input.value.trim() || null);
			});

			const onDocMouseDown = (e: MouseEvent) => {
				if (!busy && !overlay.contains(e.target as Node)) closeThroughInstance(instance, cell, false);
			};
			// Solo si el editor sigue abierto: un cierre rápido (Enter antes de este
			// turno) dejaría el listener vivo, y el siguiente clic en cualquier parte
			// «cerraría» un editor que ya no existe, dejando la celda en null.
			setTimeout(() => {
				if (activeEditor?.overlay === overlay) document.addEventListener('mousedown', onDocMouseDown);
			}, 0);

			activeEditor = {
				cell,
				overlay,
				value,
				original: value,
				dispose: () => document.removeEventListener('mousedown', onDocMouseDown)
			};
			input.focus();
			input.select();
		},
		closeEditor(cell: HTMLTableCellElement, save: boolean): CellValue {
			const result = save ? (activeEditor?.value ?? null) : (activeEditor?.original ?? null);
			disposeActiveEditor();
			paint(cell, result);
			return result;
		}
	};
}

// ---------------------------------------------------------------------------
// Editor: password (enmascarado)
// ---------------------------------------------------------------------------

/**
 * La celda de una contraseña: la marca del servidor (`pwd:…`, «hay una
 * guardada») se ve como ocho puntos; una contraseña nueva, con un punto por
 * carácter. El valor real nunca se pinta.
 */
function passwordDots(value: CellValue): string {
	if (isBlank(value)) return '';
	return isPasswordMark(value) ? '••••••••' : '•'.repeat(Math.min(String(value).length, 12));
}

function buildPasswordEditor() {
	const paint = (cell: HTMLTableCellElement, value: CellValue) => {
		cell.textContent = passwordDots(value);
	};

	return {
		createCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return value;
		},
		openEditor(
			cell: HTMLTableCellElement,
			value: CellValue,
			_x: number,
			_y: number,
			instance: any
		) {
			disposeActiveEditor();
			const overlay = mountOverlay(cell, 240);
			// Con una guardada, el campo empieza vacío: la marca no es la contraseña, y
			// dejarlo vacío es «no cambiarla» (SB-22).
			const saved = isPasswordMark(value);
			overlay.innerHTML = `
				<input class="oc-cell-editor__input" type="password" autocomplete="new-password"
				       placeholder="${saved ? 'Nueva contraseña' : 'Contraseña'}" />
				<label class="oc-cell-editor__toggle"><input type="checkbox" /> Mostrar</label>
				${saved ? '<div class="oc-cell-editor__hint">Déjala vacía para no cambiarla</div>' : ''}
			`;
			const input = overlay.querySelector('input[type="password"]') as HTMLInputElement;
			const toggle = overlay.querySelector('input[type="checkbox"]') as HTMLInputElement;
			input.value = value == null || saved ? '' : String(value);
			placeOverlay(overlay, cell);
			/** Vacío conserva lo que había; nunca borra una contraseña guardada por accidente. */
			const typed = (): CellValue => (input.value === '' ? value : input.value);

			toggle.addEventListener('change', () => {
				input.type = toggle.checked ? 'text' : 'password';
				input.focus();
			});

			input.addEventListener('keydown', (e: KeyboardEvent) => {
				e.stopPropagation();
				if (e.key === 'Enter') {
					if (activeEditor) activeEditor.value = typed();
					closeThroughInstance(instance, cell, true);
				} else if (e.key === 'Escape') {
					closeThroughInstance(instance, cell, false);
				}
			});

			const onDocMouseDown = (e: MouseEvent) => {
				if (!overlay.contains(e.target as Node)) {
					if (activeEditor) activeEditor.value = typed();
					closeThroughInstance(instance, cell, true);
				}
			};
			// Solo si el editor sigue abierto: un cierre rápido (Enter antes de este
			// turno) dejaría el listener vivo, y el siguiente clic en cualquier parte
			// «cerraría» un editor que ya no existe, dejando la celda en null.
			setTimeout(() => {
				if (activeEditor?.overlay === overlay) document.addEventListener('mousedown', onDocMouseDown);
			}, 0);

			activeEditor = {
				cell,
				overlay,
				value,
				original: value,
				read: typed,
				dispose: () => document.removeEventListener('mousedown', onDocMouseDown)
			};
			input.focus();
			input.select();
		},
		closeEditor(cell: HTMLTableCellElement, save: boolean): CellValue {
			const result = save ? committedValue() : (activeEditor?.original ?? null);
			disposeActiveEditor();
			paint(cell, result);
			return result;
		}
	};
}

// ---------------------------------------------------------------------------
// Editor: texto libre en panel (tipos que en la hoja usan el editor nativo)
// ---------------------------------------------------------------------------

function buildTextEditor(paint: (cell: HTMLTableCellElement, value: CellValue) => void) {
	return {
		createCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return value;
		},
		openEditor(
			cell: HTMLTableCellElement,
			value: CellValue,
			_x: number,
			_y: number,
			instance: any
		) {
			disposeActiveEditor();
			const overlay = mountOverlay(cell, 220);
			overlay.innerHTML = `<input class="oc-cell-editor__input" type="text" />`;
			const input = overlay.querySelector('input') as HTMLInputElement;
			input.value = value == null ? '' : String(value);
			placeOverlay(overlay, cell);

			const commit = () => {
				if (activeEditor) activeEditor.value = input.value === '' ? null : input.value;
				closeThroughInstance(instance, cell, true);
			};

			input.addEventListener('keydown', (e: KeyboardEvent) => {
				e.stopPropagation();
				if (e.key === 'Enter') commit();
				else if (e.key === 'Escape') closeThroughInstance(instance, cell, false);
			});

			const onDocMouseDown = (e: MouseEvent) => {
				if (!overlay.contains(e.target as Node)) commit();
			};
			// Solo si el editor sigue abierto: un cierre rápido (Enter antes de este
			// turno) dejaría el listener vivo, y el siguiente clic en cualquier parte
			// «cerraría» un editor que ya no existe, dejando la celda en null.
			setTimeout(() => {
				if (activeEditor?.overlay === overlay) document.addEventListener('mousedown', onDocMouseDown);
			}, 0);

			activeEditor = {
				cell,
				overlay,
				value,
				original: value,
				read: () => (input.value === '' ? null : input.value),
				dispose: () => document.removeEventListener('mousedown', onDocMouseDown)
			};
			input.focus();
			input.select();
		},
		closeEditor(cell: HTMLTableCellElement, save: boolean): CellValue {
			const result = save ? committedValue() : (activeEditor?.original ?? null);
			disposeActiveEditor();
			paint(cell, result);
			return result;
		}
	};
}

/**
 * Texto con miniatura (SB-29): la foto (`avatar.image`) y el ícono
 * (`avatar.iconField`, SB-39) salen de la misma fila (`ctx.rowAt`); sin ellos,
 * las iniciales o el ícono fijo.
 *
 * Se edita **dentro de la celda**, como el texto nativo: el editor de
 * jspreadsheet no deja pintar la celda, así que este lo imita (un `input` en
 * `td.editor` del tamaño de la celda; Enter confirma, Esc descarta, salir
 * confirma).
 */
function buildAvatarTextEditor(column: ColumnDef, ctx: CellTypeContext) {
	const spec = column.avatar!;
	const paint = (cell: HTMLTableCellElement, value: CellValue, y: number) => {
		cell.innerHTML = '';
		const text = isBlank(value) ? '' : String(value);
		// jspreadsheet puede pasar la fila como texto («3»): se lee como número.
		const at = Number(y);
		const { image, icon } = recordMedia(spec, Number.isFinite(at) ? ctx.rowAt?.(at) : undefined);
		const avatar = avatarNode(spec, text, image, icon);
		if (!avatar) return;
		const wrap = document.createElement('div');
		wrap.className = 'oc-avatar-cell';
		const label = document.createElement('span');
		label.className = 'oc-avatar-cell__text';
		label.textContent = text;
		wrap.append(avatar, label);
		cell.appendChild(wrap);
	};

	return {
		createCell(cell: HTMLTableCellElement, value: CellValue, _x?: number, y?: number) {
			paint(cell, value, y ?? Number(cell.dataset.y));
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue, _x?: number, y?: number) {
			paint(cell, value, y ?? Number(cell.dataset.y));
			return value;
		},
		openEditor(cell: HTMLTableCellElement, value: CellValue, _x: number, _y: number, instance: any) {
			disposeActiveEditor();
			const rect = cell.getBoundingClientRect();
			const holder = document.createElement('div');
			holder.className = 'oc-avatar-cell__editor';
			const input = document.createElement('input');
			input.type = 'text';
			input.style.width = `${rect.width}px`;
			input.style.height = `${rect.height - 2}px`;
			input.style.minHeight = `${rect.height - 2}px`;
			input.value = value == null ? '' : String(value);
			holder.appendChild(input);
			cell.classList.add('editor');
			cell.innerHTML = '';
			cell.appendChild(holder);

			let closed = false;
			const close = (save: boolean) => {
				// Quitar el `input` al cerrar dispara su `blur`: no debe confirmar un Esc.
				if (closed || activeEditor?.overlay !== holder) return;
				closed = true;
				if (save) activeEditor.value = input.value === '' ? null : input.value;
				closeThroughInstance(instance, cell, save);
			};
			input.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter') {
					e.stopPropagation();
					e.preventDefault();
					close(true);
				} else if (e.key === 'Escape') {
					e.stopPropagation();
					close(false);
				}
			});
			input.addEventListener('blur', () => close(true));

			activeEditor = {
				cell,
				overlay: holder,
				value,
				original: value,
				read: () => (input.value === '' ? null : input.value),
				dispose: () => (closed = true)
			};
			input.focus();
			// Lo tecleado sobre la celda la reemplaza, como en el editor nativo.
			input.select();
		},
		closeEditor(cell: HTMLTableCellElement, save: boolean): CellValue {
			const result = save ? committedValue() : (activeEditor?.original ?? null);
			disposeActiveEditor();
			cell.classList.remove('editor');
			paint(cell, result, Number(cell.dataset.y));
			return result;
		}
	};
}

// ---------------------------------------------------------------------------
// Editor con tipo por fila
// ---------------------------------------------------------------------------

type JssEditor = ReturnType<typeof buildTextEditor>;

/**
 * Columna cuyo tipo cambia de una fila a otra.
 *
 * jspreadsheet CE solo admite tipo por columna, y en la subtabla del panel de
 * cambios cada fila es un campo distinto: la columna «Nuevo» puede tener una
 * fecha en la fila 1 y un selector en la 2. Este editor resuelve, en cada
 * llamada, qué columna del grid corresponde a la fila y delega en su editor
 * real. Así el valor se edita con **el mismo** editor que en la hoja.
 *
 * Los tipos que en la hoja usan el editor nativo de texto (`type: 'text'`)
 * no tienen un objeto al que delegar; para ellos se usa un campo en panel.
 */
export function buildRowTypedEditor(
	resolve: (y: number) => ColumnDef | null,
	ctx: CellTypeContext
): JssEditor {
	const editors = new Map<string, JssEditor>();

	const editorFor = (y: number): JssEditor | null => {
		const column = resolve(y);
		if (!column) return null;
		let editor = editors.get(column.field);
		if (!editor) {
			const type = getCellType(column.type);
			const spec = type.toColumn(column, ctx);
			if (spec.type && typeof spec.type === 'object') {
				editor = spec.type as JssEditor;
			} else {
				const render = spec.render as
					| ((cell: HTMLTableCellElement, value: CellValue) => void)
					| undefined;
				editor = buildTextEditor((cell, value) => {
					if (render) render(cell, value);
					else cell.textContent = type.format(value, column, ctx);
				});
			}
			editors.set(column.field, editor);
		}
		return editor;
	};

	return {
		createCell(cell, value, ...rest: unknown[]) {
			const y = rest[1] as number;
			const editor = editorFor(y);
			if (editor) return (editor.createCell as any)(cell, value, ...rest);
			cell.textContent = value == null ? '' : String(value);
			return cell;
		},
		updateCell(cell, value, ...rest: unknown[]) {
			const editor = editorFor(rest[1] as number);
			if (editor) return (editor.updateCell as any)(cell, value, ...rest);
			cell.textContent = value == null ? '' : String(value);
			return value;
		},
		openEditor(cell, value, x, y, instance, ...rest: unknown[]) {
			(editorFor(y)?.openEditor as any)?.(cell, value, x, y, instance, ...rest);
		},
		closeEditor(cell, save, ...rest: unknown[]) {
			const editor = editorFor(rest[1] as number);
			return editor ? (editor.closeEditor as any)(cell, save, ...rest) : null;
		}
	} as JssEditor;
}

// ---------------------------------------------------------------------------
// Definición de los tipos base
// ---------------------------------------------------------------------------

const textType: CellTypeDef = {
	name: 'text',
	align: 'left',
	parse: (raw) => (isBlank(raw) ? null : String(raw)),
	format: (value) => (isBlank(value) ? '' : String(value)),
	equals: looseEquals,
	validate: (value, column) => {
		const req = requiredError(value, column);
		if (req) return req;
		if (isBlank(value)) return null;
		const s = String(value);
		if (column.maxLength && s.length > column.maxLength) {
			return `Máximo ${column.maxLength} caracteres`;
		}
		if (column.pattern && !column.pattern.test(s)) {
			return column.patternMessage ?? 'Formato inválido';
		}
		return null;
	},
	toColumn: (column, ctx) =>
		column.avatar
			? { type: buildAvatarTextEditor(column, ctx), align: column.align ?? 'left' }
			: { type: 'text', align: column.align ?? 'left' }
};

const numberType: CellTypeDef = {
	name: 'number',
	align: 'right',
	normalizeInSheet: true,
	parse: (raw) => toCanonicalNumber(raw),
	format: (value, column) => formatNumberDisplay(value, column),
	// Sin prefijo ni separadores: así Excel lo recibe como número, no como texto.
	toClipboard: (value) => (isBlank(value) ? '' : String(value)),
	equals: (a, b) => {
		if (isBlank(a) && isBlank(b)) return true;
		return Number(a) === Number(b);
	},
	validate: (value, column) => {
		const req = requiredError(value, column);
		if (req) return req;
		if (isBlank(value)) return null;
		const n = Number(value);
		if (isNaN(n)) return 'Debe ser un número';
		if (column.min != null && n < column.min) return `Mínimo ${column.min}`;
		if (column.max != null && n > column.max) return `Máximo ${column.max}`;
		return null;
	},
	toColumn: (column) => ({
		type: 'text',
		align: column.align ?? 'right',
		render: (cell: HTMLTableCellElement, value: CellValue) => {
			cell.textContent = formatNumberDisplay(value, column);
		}
	})
};

const dateType: CellTypeDef = {
	name: 'date',
	align: 'center',
	parse: (raw) => toCanonicalDate(raw),
	format: (value) => formatDateDisplay(value),
	equals: looseEquals,
	validate: (value, column) => {
		const req = requiredError(value, column);
		if (req) return req;
		if (isBlank(value)) return null;
		return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? null : 'Fecha inválida';
	},
	toColumn: (column) => ({
		type: buildDateEditor(false),
		align: column.align ?? 'center'
	})
};

const dateTimeType: CellTypeDef = {
	name: 'datetime',
	align: 'center',
	parse: (raw) => toCanonicalDateTime(raw),
	format: (value) => formatDateTimeDisplay(value),
	equals: looseEquals,
	validate: (value, column) => {
		const req = requiredError(value, column);
		if (req) return req;
		if (isBlank(value)) return null;
		return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(value)) ? null : 'Fecha y hora inválidas';
	},
	toColumn: (column) => ({
		type: buildDateEditor(true),
		align: column.align ?? 'center'
	})
};

/** Valor canónico → etiqueta. Sin coincidencia devuelve el valor tal cual, para
 *  que un dato fuera de catálogo se vea en lugar de desaparecer. */
function selectLabel(value: CellValue, column: ColumnDef): string {
	if (isBlank(value)) return '';
	return column.options?.find((o) => o.value === value)?.label ?? String(value);
}

/** Filtro local por etiqueta o por valor, sin distinguir acentos ni mayúsculas. */
function filterOptions(options: Option[], query: string): Option[] {
	const needle = normalizeForSearch(query);
	if (needle === '') return options;
	return options.filter(
		(o) =>
			normalizeForSearch(o.label).includes(needle) || normalizeForSearch(o.value).includes(needle)
	);
}

const selectType: CellTypeDef = {
	name: 'select',
	align: 'left',
	parse: (raw) => (isBlank(raw) ? null : String(raw)),
	format: (value, column) => selectLabel(value, column),
	equals: looseEquals,
	/**
	 * Al copiar se obtiene la etiqueta visible, no el id. Para que el ciclo
	 * cierre, aquí se resuelve la etiqueta de vuelta a su identificador.
	 * Si no hay coincidencia se deja el texto crudo a propósito: el validador
	 * lo marcará como fuera de catálogo en lugar de descartarlo en silencio.
	 */
	fromClipboard: (raw, column) => {
		const s = raw.trim();
		if (!s) return null;
		const needle = s.toLowerCase();
		const options = column.options ?? [];
		const match =
			options.find((o) => o.label.toLowerCase() === needle) ??
			options.find((o) => o.value.toLowerCase() === needle);
		return match ? match.value : s;
	},
	validate: (value, column) => {
		const req = requiredError(value, column);
		if (req) return req;
		if (isBlank(value)) return null;
		const exists = column.options?.some((o) => o.value === value);
		return exists ? null : 'Valor fuera del catálogo';
	},
	/*
		Editor propio y no el `dropdown` nativo de la librería.

		El nativo resolvía el valor contra su `source` y devolvía cadena vacía si no
		lo encontraba, así que un valor fuera de catálogo quedaba invisible aunque
		estuviera guardado y marcado como error. Su `createCell` tampoco era
		sustituible: la librería solo lo honra cuando `type` es un objeto, no cuando
		es la cadena `'dropdown'`. Con editor propio el render es nuestro, y de paso
		lista fija y fuente externa se comportan y se ven igual.
	*/
	toColumn: (column) => ({
		type: buildPickerEditor({
			search: (query) => filterOptions(column.options ?? [], query),
			label: (value) => selectLabel(value, column),
			icon: (value) => (isBlank(value) ? undefined : column.options?.find((o) => o.value === value)?.icon)
		}),
		align: column.align ?? 'left'
	})
};

const remoteSelectType: CellTypeDef = {
	name: 'remote-select',
	align: 'left',
	parse: (raw) => (isBlank(raw) ? null : String(raw)),
	format: (value, _column, ctx) => remoteLabel(value, ctx),
	equals: looseEquals,
	/** Busca la etiqueta pegada entre las ya conocidas; si no, la deja tal cual. */
	fromClipboard: (raw, _column, ctx) => {
		const s = raw.trim();
		if (!s) return null;
		const needle = s.toLowerCase();
		for (const [value, label] of ctx.labelCache) {
			if (label.toLowerCase() === needle) return value;
		}
		return s;
	},
	/**
	 * Paridad con `select`: un valor que el usuario introdujo debe resolverse
	 * contra la fuente. Aquí "la fuente" es lo que el cliente ha visto (el
	 * `labelCache`), que se alimenta de `preloadLabels` y de cada selección
	 * hecha en el buscador.
	 *
	 * Los valores que vinieron del servidor se dan por buenos: marcarlos por
	 * no tener su etiqueta en memoria sería un falso positivo.
	 */
	validate: (value, column, _row, ctx) => {
		const req = requiredError(value, column);
		if (req) return req;
		if (isBlank(value)) return null;
		if (ctx.fromServer) return null;
		return ctx.labelCache.has(String(value))
			? null
			: 'No corresponde a ningún registro de la fuente';
	},
	/* Mismo editor que `select`; solo cambia de dónde salen las opciones. */
	toColumn: (column, ctx) => ({
		type: buildPickerEditor({
			search: (query) => column.search?.(query) ?? [],
			label: (value) => remoteLabel(value, ctx),
			minLength: column.minSearchLength ?? 0,
			// La consulta viaja por red: sin espera se dispara una por pulsación.
			debounceMs: 220,
			remember: (opt) => ctx.labelCache.set(opt.value, opt.label),
			placeholder: 'Escribe para buscar…'
		}),
		align: column.align ?? 'left'
	})
};

/**
 * Registro de otro recurso (SB-21): guarda el id y muestra su nombre.
 *
 * Como `remote-select`, los valores que llegaron del servidor se dan por
 * buenos —el servidor los valida al guardar con `byIds`—, y lo que introduce
 * el usuario tiene que corresponder a un registro conocido.
 */
const lookupType: CellTypeDef = {
	name: 'lookup',
	align: 'left',
	parse: (raw) => (isBlank(raw) ? null : String(raw).trim()),
	format: (value, column, ctx) => lookupLabel(value, column, ctx),
	equals: looseEquals,
	/**
	 * Resuelve con lo conocido; si no, deja el texto tal cual y el validador lo
	 * marca. El pegado consulta antes al servidor por los textos que falten
	 * (`resolveLookupText` + `lookup.resolve`), así que aquí ya están en la caché.
	 */
	fromClipboard: (raw, column, ctx) => {
		const s = raw.trim();
		if (!s) return null;
		return resolveLookupText(s, column, ctx.labelCache) ?? s;
	},
	validate: (value, column, _row, ctx) => {
		const req = requiredError(value, column);
		if (req) return req;
		if (isBlank(value)) return null;
		if (ctx.labelCache.has(lookupKey(column.field, value))) return null;
		const ambiguous = column.lookup?.ambiguous?.get(normalizeForSearch(String(value)));
		if (ambiguous) return `Ambiguo: ${ambiguous} coincidencias, elige una`;
		if (ctx.fromServer) return null;
		return 'No corresponde a ningún registro';
	},
	toColumn: (column, ctx) => ({
		type: buildLookupEditor(column, ctx),
		align: column.align ?? 'left'
	})
};

const imageType: CellTypeDef = {
	name: 'image',
	align: 'center',
	parse: (raw) => (isBlank(raw) ? null : String(raw)),
	format: (value) => (isBlank(value) ? '' : String(value)),
	equals: looseEquals,
	validate: (value, column) => {
		const req = requiredError(value, column);
		if (req) return req;
		if (isBlank(value)) return null;
		return /^(https?:\/\/|data:image\/|\/)/.test(String(value)) ? null : 'URL de imagen inválida';
	},
	toColumn: (column) => ({
		type: buildMediaEditor(column, 'image'),
		align: 'center'
	})
};

/**
 * Archivo (SB-30): el valor es su URL; la celda muestra ícono y nombre. Se
 * copia la URL (pegarla en otra fila da el mismo archivo), no el nombre.
 */
const fileType: CellTypeDef = {
	name: 'file',
	align: 'left',
	parse: (raw) => parseFileValue(raw),
	format: (value) => (isBlank(value) ? '' : (toFileRef(value)?.name ?? String(value))),
	toClipboard: (value) => (isBlank(value) ? '' : (toFileRef(value)?.url ?? '')),
	fromClipboard: (raw) => (raw.trim() === '' ? null : raw.trim()),
	equals: (a, b) => fileEquals(a, b),
	validate: (value, column) => {
		const req = requiredError(value, column);
		if (req) return req;
		if (isBlank(value)) return null;
		const ref = toFileRef(value);
		return ref && FILE_URL.test(ref.url) ? null : 'URL de archivo inválida';
	},
	toColumn: (column) => ({ type: buildMediaEditor(column, 'file'), align: 'left' })
};

/** Un valor de archivo como llega (objeto, URL o el JSON de un objeto, al pegar): `FileRef`, URL o `null`. */
function parseFileValue(raw: unknown): CellValue {
	if (isBlank(raw)) return null;
	// Siempre en la forma actual: lo pegado en la forma obsoleta se reescribe.
	if (isFileRef(raw)) return normalizeFileRef(raw);
	const text = String(raw).trim();
	if (text.startsWith('{')) {
		try {
			return parseFileValue(JSON.parse(text));
		} catch {
			// No es JSON: se queda como texto (y la validación lo marca si no es una URL).
		}
	}
	return text;
}

function fileEquals(a: CellValue, b: CellValue): boolean {
	return isBlank(a) || isBlank(b) ? isBlank(a) && isBlank(b) : canonicalJson(normalizeFileValue(a)) === canonicalJson(normalizeFileValue(b));
}

/**
 * Carpeta (SB-38): varios archivos, `FileRef[]`. La celda muestra el conteo y
 * los nombres; el panel los lista (cada uno se abre o descarga), quita y
 * suma con «Subir» (varios a la vez). Se copia una URL por línea.
 */
const folderType: CellTypeDef = {
	name: 'folder',
	align: 'left',
	parse: (raw) => {
		if (isBlank(raw)) return null;
		let value: unknown = raw;
		if (typeof raw === 'string') {
			const text = raw.trim();
			if (text.startsWith('[') || text.startsWith('{')) {
				try {
					value = JSON.parse(text);
				} catch {
					value = text;
				}
			} else value = text.split(/\r?\n/).filter((l) => l.trim());
		}
		const refs = fileRefsOf(value).map((r) => parseFileValue(r) as FileRef);
		return refs.length ? refs : null;
	},
	format: (value) => {
		const n = fileRefsOf(value).length;
		return n ? `${n} ${n === 1 ? 'archivo' : 'archivos'}` : '';
	},
	toClipboard: (value) => fileRefsOf(value).map((r) => r.url).join('\n'),
	fromClipboard: (raw) => (raw.trim() === '' ? null : raw.trim()),
	equals: (a, b) => fileEquals(a, b),
	validate: (value, column) => {
		const req = requiredError(value, column);
		if (req) return req;
		if (isBlank(value)) return null;
		if (!Array.isArray(value)) return 'Debe ser una lista de archivos';
		return value.every((r) => isFileRef(r) && FILE_URL.test(r.url)) ? null : 'URL de archivo inválida';
	},
	toColumn: (column) => ({ type: buildFolderEditor(column), align: 'left' })
};

/**
 * La miniatura del **principal** de una carpeta (el primero de la lista): su
 * imagen si es una; si no, o si no carga, el ícono de su tipo.
 */
function folderLead(ref: FileRef): HTMLElement {
	const icon = () => {
		const node = document.createElement('span');
		node.className = 'oc-file__icon';
		node.innerHTML = iconSvg(fileIcon(ref.name || ref.url));
		return node;
	};
	if (!isImageFile(ref) || !IMAGE_URL.test(ref.url)) return icon();
	const thumb = document.createElement('span');
	thumb.className = 'oc-folder__thumb';
	const img = document.createElement('img');
	img.alt = '';
	img.loading = 'lazy';
	img.onerror = () => thumb.replaceWith(icon());
	img.src = ref.url;
	thumb.appendChild(img);
	return thumb;
}

/**
 * La celda de una carpeta y su panel. Celda: el principal (miniatura si es
 * imagen, ícono de su tipo si no), «3 archivos» y los nombres (todos al pasar
 * el cursor). Panel: cada archivo con ↗ (abrir o descargar), «Hacer principal»
 * (lo pasa al primer lugar) y ✕ (quitar); con `upload`, «Subir» agrega uno o
 * varios; «Aceptar» deja la lista en la celda.
 */
function buildFolderEditor(column: ColumnDef) {
	const paint = (cell: HTMLTableCellElement, value: CellValue) => {
		cell.innerHTML = '';
		cell.classList.add('oc-file-cell', 'oc-folder-cell');
		const refs = fileRefsOf(value);
		if (!refs.length) {
			const empty = document.createElement('span');
			empty.className = 'oc-image-empty';
			empty.textContent = '—';
			cell.appendChild(empty);
			return;
		}
		const wrap = document.createElement('div');
		wrap.className = 'oc-file oc-folder';
		wrap.title = refs.map((r) => r.name).join('\n');
		const icon = folderLead(refs[0]!);
		const count = document.createElement('span');
		count.className = 'oc-folder__count';
		count.textContent = `${refs.length} ${refs.length === 1 ? 'archivo' : 'archivos'}`;
		const names = document.createElement('span');
		names.className = 'oc-file__name oc-folder__names';
		names.textContent = refs.map((r) => r.name).join(', ');
		wrap.append(icon, count, names);
		cell.appendChild(wrap);
	};

	return {
		createCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return value;
		},
		openEditor(cell: HTMLTableCellElement, value: CellValue, _x: number, _y: number, instance: any) {
			disposeActiveEditor();
			const upload = column.upload;
			const overlay = mountOverlay(cell, 360);
			overlay.classList.add('oc-media-editor', 'oc-folder-editor');
			overlay.innerHTML = `
				<div class="oc-folder-editor__title"></div>
				<ul class="oc-folder-editor__list" role="list"></ul>
				<div class="oc-cell-editor__status" role="status"></div>
				<div class="oc-cell-editor__actions">
					${upload ? '<button type="button" data-action="upload" class="oc-cell-editor__upload">Subir</button>' : ''}
					<span class="oc-cell-editor__spacer"></span>
					<button type="button" data-action="clear">Vaciar</button>
					<button type="button" data-action="save" class="is-primary">Aceptar</button>
				</div>
				${upload ? `<input type="file" class="oc-cell-editor__file" multiple hidden ${upload.accept?.length ? `accept="${escapeHtml(upload.accept.join(','))}"` : ''} />` : ''}
			`;
			const title = overlay.querySelector('.oc-folder-editor__title') as HTMLDivElement;
			const list = overlay.querySelector('.oc-folder-editor__list') as HTMLUListElement;
			const status = overlay.querySelector('.oc-cell-editor__status') as HTMLDivElement;
			const picker = overlay.querySelector<HTMLInputElement>('input.oc-cell-editor__file');
			let refs = fileRefsOf(value);
			let busy = false;

			const render = () => {
				title.textContent = refs.length ? `${refs.length} ${refs.length === 1 ? 'archivo' : 'archivos'}` : 'Carpeta vacía';
				list.innerHTML = '';
				refs.forEach((ref, i) => {
					const li = document.createElement('li');
					li.className = 'oc-folder-editor__item';
					li.appendChild(fileNode(ref));
					if (i === 0) {
						li.classList.add('is-primary');
						const badge = document.createElement('span');
						badge.className = 'oc-folder-editor__badge';
						badge.textContent = 'Principal';
						li.appendChild(badge);
					} else {
						const primary = document.createElement('button');
						primary.type = 'button';
						primary.className = 'oc-folder-editor__primary';
						primary.dataset.primary = String(i);
						primary.title = 'Hacer principal';
						primary.setAttribute('aria-label', `Hacer principal ${ref.name}`);
						primary.innerHTML = iconSvg('star');
						li.appendChild(primary);
					}
					const remove = document.createElement('button');
					remove.type = 'button';
					remove.className = 'oc-folder-editor__remove';
					remove.dataset.remove = String(i);
					remove.title = 'Quitar';
					remove.setAttribute('aria-label', `Quitar ${ref.name}`);
					remove.innerHTML = iconSvg('x');
					li.appendChild(remove);
					list.appendChild(li);
				});
				placeOverlay(overlay, cell);
			};
			render();

			const setStatus = (text: string, error = false) => {
				status.textContent = text;
				status.classList.toggle('is-error', error);
				placeOverlay(overlay, cell);
			};
			const commit = (next: CellValue) => {
				if (activeEditor) activeEditor.value = next;
				closeThroughInstance(instance, cell, true);
			};

			/** Sube los archivos de uno en uno; los que fallan lo dicen y no entran. */
			const send = async (files: File[]) => {
				if (!upload || busy || !files.length) return;
				busy = true;
				overlay.classList.add('is-busy');
				const errors: string[] = [];
				for (const file of files) {
					if (upload.maxSize && file.size > upload.maxSize) {
						errors.push(`${file.name}: pasa del máximo (${formatBytes(upload.maxSize)})`);
						continue;
					}
					if (upload.accept?.length && file.type && !upload.accept.includes(file.type)) {
						errors.push(`${file.name}: tipo no permitido`);
						continue;
					}
					setStatus(`Subiendo ${file.name}…`);
					try {
						const result = await upload.send(file);
						if (activeEditor?.overlay !== overlay) return;
						const ref: FileRef = { url: result.url, name: result.name || file.name, type: result.type, size: result.size };
						refs = [...refs.filter((r) => r.name !== ref.name), ref];
						render();
					} catch (err) {
						errors.push(`${file.name}: ${err instanceof Error ? err.message : 'no se pudo subir'}`);
					}
				}
				busy = false;
				overlay.classList.remove('is-busy');
				setStatus(errors.join(' · '), errors.length > 0);
			};

			picker?.addEventListener('change', () => {
				void send([...(picker.files ?? [])]);
				picker.value = '';
			});
			if (upload) {
				overlay.addEventListener('dragover', (e) => {
					e.preventDefault();
					overlay.classList.add('is-dropping');
				});
				overlay.addEventListener('dragleave', () => overlay.classList.remove('is-dropping'));
				overlay.addEventListener('drop', (e) => {
					e.preventDefault();
					overlay.classList.remove('is-dropping');
					void send([...(e.dataTransfer?.files ?? [])]);
				});
			}
			overlay.addEventListener('mousedown', (e: MouseEvent) => {
				const target = e.target as HTMLElement;
				// Los enlaces (abrir o descargar) siguen su curso.
				if (target.closest('a')) return;
				// «Hacer principal»: el archivo pasa al primer lugar; el resto conserva su orden.
				const primaryAt = target.closest<HTMLElement>('[data-primary]')?.dataset.primary;
				if (primaryAt !== undefined) {
					e.preventDefault();
					const at = Number(primaryAt);
					refs = [refs[at]!, ...refs.filter((_, i) => i !== at)];
					render();
					return;
				}
				const removeAt = target.closest<HTMLElement>('[data-remove]')?.dataset.remove;
				if (removeAt !== undefined) {
					e.preventDefault();
					refs = refs.filter((_, i) => i !== Number(removeAt));
					render();
					return;
				}
				const action = target.closest('[data-action]')?.getAttribute('data-action');
				if (!action) return;
				e.preventDefault();
				if (busy) return;
				if (action === 'upload') picker?.click();
				else commit(action === 'clear' || !refs.length ? null : refs);
			});
			overlay.addEventListener('keydown', (e: KeyboardEvent) => {
				e.stopPropagation();
				if (e.key === 'Escape') closeThroughInstance(instance, cell, false);
				else if (e.key === 'Enter' && !(e.target as HTMLElement).closest('a')) commit(refs.length ? refs : null);
			});
			const onDocMouseDown = (e: MouseEvent) => {
				if (!busy && !overlay.contains(e.target as Node)) closeThroughInstance(instance, cell, false);
			};
			setTimeout(() => {
				if (activeEditor?.overlay === overlay) document.addEventListener('mousedown', onDocMouseDown);
			}, 0);
			activeEditor = { cell, overlay, value, original: value, dispose: () => document.removeEventListener('mousedown', onDocMouseDown) };
			(overlay.querySelector('[data-action="save"]') as HTMLButtonElement).focus();
		},
		closeEditor(cell: HTMLTableCellElement, save: boolean): CellValue {
			const result = save ? (activeEditor?.value ?? null) : (activeEditor?.original ?? null);
			disposeActiveEditor();
			paint(cell, result);
			return result;
		}
	};
}

/**
 * Texto largo (SB-38): una ficha en markdown, un JSON. La columna `text` del
 * servidor con `multiline: true`. La celda muestra la primera línea con su
 * tipo (MD, JSON); el panel es un visor amplio que se edita, con «Formatear»
 * para un JSON válido. Ctrl/⌘+Enter acepta; Escape descarta.
 */
const longTextType: CellTypeDef = {
	name: 'longtext',
	align: 'left',
	parse: (raw) => (isBlank(raw) ? null : String(raw)),
	format: (value) => (isBlank(value) ? '' : String(value)),
	equals: looseEquals,
	validate: (value, column) => {
		const req = requiredError(value, column);
		if (req) return req;
		if (isBlank(value)) return null;
		if (column.maxLength !== undefined && String(value).length > column.maxLength) return `Máximo ${column.maxLength} caracteres`;
		return null;
	},
	toColumn: () => ({ type: buildLongTextEditor(), align: 'left' })
};

/** ¿Qué es el texto? JSON si se puede leer como tal; markdown si trae encabezados, listas o tablas. */
function longTextKind(text: string): 'JSON' | 'MD' | null {
	const t = text.trim();
	if (/^[[{]/.test(t)) {
		try {
			JSON.parse(t);
			return 'JSON';
		} catch {
			// No es JSON.
		}
	}
	return /^(#{1,6} |[-*] |\d+\. |\|)/m.test(t) ? 'MD' : null;
}

function buildLongTextEditor() {
	const paint = (cell: HTMLTableCellElement, value: CellValue) => {
		cell.innerHTML = '';
		cell.classList.add('oc-longtext-cell');
		if (isBlank(value)) return;
		const text = String(value);
		const kind = longTextKind(text);
		if (kind) {
			const badge = document.createElement('span');
			badge.className = 'oc-longtext__kind';
			badge.textContent = kind;
			cell.appendChild(badge);
		}
		const first = document.createElement('span');
		first.className = 'oc-longtext__first';
		first.textContent = (text.split(/\r?\n/).find((l) => l.trim()) ?? '').replace(/^#+\s*/, '');
		cell.appendChild(first);
		cell.title = text.length > 400 ? `${text.slice(0, 400)}…` : text;
	};
	return {
		createCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return value;
		},
		openEditor(cell: HTMLTableCellElement, value: CellValue, _x: number, _y: number, instance: any) {
			disposeActiveEditor();
			const overlay = mountOverlay(cell, 560);
			overlay.classList.add('oc-longtext-editor');
			overlay.innerHTML = `
				<textarea class="oc-longtext-editor__text" spellcheck="false" aria-label="Texto"></textarea>
				<div class="oc-cell-editor__status" role="status"></div>
				<div class="oc-cell-editor__actions">
					<button type="button" data-action="format" hidden>Formatear JSON</button>
					<span class="oc-cell-editor__spacer"></span>
					<button type="button" data-action="cancel">Cancelar</button>
					<button type="button" data-action="save" class="is-primary">Aceptar</button>
				</div>
			`;
			const area = overlay.querySelector('textarea') as HTMLTextAreaElement;
			const status = overlay.querySelector('.oc-cell-editor__status') as HTMLDivElement;
			const format = overlay.querySelector('[data-action="format"]') as HTMLButtonElement;
			area.value = isBlank(value) ? '' : String(value);
			const refresh = () => {
				const kind = longTextKind(area.value);
				format.hidden = kind !== 'JSON';
				status.textContent = `${kind ? `${kind} · ` : ''}${area.value.length} caracteres`;
			};
			refresh();
			placeOverlay(overlay, cell);
			const commit = () => {
				if (activeEditor) activeEditor.value = area.value === '' ? null : area.value;
				closeThroughInstance(instance, cell, true);
			};
			area.addEventListener('input', refresh);
			area.addEventListener('keydown', (e: KeyboardEvent) => {
				e.stopPropagation();
				if (e.key === 'Escape') closeThroughInstance(instance, cell, false);
				else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
			});
			overlay.addEventListener('mousedown', (e: MouseEvent) => {
				const action = (e.target as HTMLElement).closest('[data-action]')?.getAttribute('data-action');
				if (!action) return;
				e.preventDefault();
				if (action === 'format') {
					area.value = JSON.stringify(JSON.parse(area.value), null, 2);
					refresh();
				} else if (action === 'cancel') closeThroughInstance(instance, cell, false);
				else commit();
			});
			const onDocMouseDown = (e: MouseEvent) => {
				if (!overlay.contains(e.target as Node)) closeThroughInstance(instance, cell, false);
			};
			setTimeout(() => {
				if (activeEditor?.overlay === overlay) document.addEventListener('mousedown', onDocMouseDown);
			}, 0);
			activeEditor = { cell, overlay, value, original: value, dispose: () => document.removeEventListener('mousedown', onDocMouseDown) };
			area.focus();
		},
		closeEditor(cell: HTMLTableCellElement, save: boolean): CellValue {
			const result = save ? (activeEditor?.value ?? null) : (activeEditor?.original ?? null);
			disposeActiveEditor();
			paint(cell, result);
			return result;
		}
	};
}


/**
 * Marcado SVG de un icono de `@lucide/svelte`, calculado una sola vez.
 *
 * Las celdas las crea jspreadsheet con DOM directo, no con Svelte, así que no
 * se puede renderizar un componente en cada una. Se monta el icono una vez en
 * un nodo suelto, se guarda su HTML y se reutiliza en todas las filas.
 */
const iconHtmlCache = new WeakMap<Component, string>();

function iconHtml(icon: Component | undefined): string {
	if (!icon || typeof document === 'undefined') return '';
	const cached = iconHtmlCache.get(icon);
	if (cached !== undefined) return cached;
	const host = document.createElement('div');
	const instance = mount(icon, { target: host, props: { size: 14, 'aria-hidden': 'true' } });
	flushSync();
	const html = host.innerHTML;
	unmount(instance);
	iconHtmlCache.set(icon, html);
	return html;
}

/**
 * Columna de acción: un botón por fila (p. ej. «Abrir» el detalle).
 *
 * No guarda datos: nunca queda sucia, no se valida y no viaja al portapapeles.
 * El clic no se atiende aquí sino en `SpreadsheetGrid`, por delegación sobre
 * la hoja, que conoce la fila y llama a `column.action.onclick`. Aquí solo se
 * pinta el botón.
 */
const actionType: CellTypeDef = {
	name: 'action',
	align: 'center',
	parse: () => null,
	format: () => '',
	equals: () => true,
	toClipboard: () => '',
	fromClipboard: () => null,
	validate: () => null,
	toColumn: (column, ctx) => {
		const action = column.action;
		const html = iconHtml(action?.icon);
		const showLabel = action?.showLabel !== false;
		// Texto fijo, o sacado de la fila (`label: (row) => …`, SB-39).
		const labelOf = (y: number): string => {
			if (typeof action?.label !== 'function') return action?.label ?? '';
			const row = Number.isFinite(y) ? ctx.rowAt?.(y) : undefined;
			return row ? action.label(row) : '';
		};
		const paint = (cell: HTMLTableCellElement, y: number) => {
			const label = labelOf(Number(y));
			const current = cell.querySelector<HTMLButtonElement>(':scope > .oc-action');
			// El botón ya está y su texto no cambió: nada que hacer.
			if (current && current.getAttribute('aria-label') === (label || 'Acción')) return;
			cell.innerHTML = '';
			if (!action) return;
			const button = document.createElement('button');
			button.type = 'button';
			button.className = action.variant === 'primary' ? 'oc-action is-primary' : 'oc-action';
			button.title = label || 'Acción';
			button.setAttribute('aria-label', label || 'Acción');
			// Un clic de acción no debe dejar el foco en el botón: el teclado
			// sigue en la hoja, igual que con la toolbar.
			button.addEventListener('mousedown', (e) => e.preventDefault());
			button.innerHTML = html;
			if (showLabel && label) {
				const text = document.createElement('span');
				text.textContent = label;
				button.appendChild(text);
			}
			cell.appendChild(button);
		};
		return {
			type: {
				createCell(cell: HTMLTableCellElement, _value: CellValue, _x?: number, y?: number) {
					paint(cell, y ?? Number(cell.dataset.y));
					return cell;
				},
				updateCell(cell: HTMLTableCellElement, value: CellValue, _x?: number, y?: number) {
					paint(cell, y ?? Number(cell.dataset.y));
					return value;
				}
			},
			readOnly: true,
			align: 'center'
		};
	}
};

/** Texto → booleano: lo que suele venir de Excel o de otra hoja. `null` si no se reconoce. */
function toBoolean(raw: unknown): boolean | null {
	if (typeof raw === 'boolean') return raw;
	if (isBlank(raw)) return null;
	const s = normalizeForSearch(String(raw).trim());
	if (['true', '1', 'si', 'yes', 'x', 'verdadero', 'activo'].includes(s)) return true;
	if (['false', '0', 'no', 'falso', 'inactivo'].includes(s)) return false;
	return null;
}

/**
 * Casilla. Un clic (o la barra espaciadora, o Enter) la alterna: no hay editor
 * que abrir para un sí o no. Se pinta con el `checkbox` de daisyUI, así toma
 * el tema de la app. Al copiar viaja «Sí» o «No».
 */
function buildBooleanEditor(column: ColumnDef) {
	const paint = (cell: HTMLTableCellElement, value: CellValue) => {
		cell.classList.add('oc-bool-cell');
		let box = cell.querySelector<HTMLInputElement>(':scope > .oc-bool-wrap > input.oc-bool');
		if (!box) {
			cell.innerHTML = '';
			// Envuelta a propósito: jspreadsheet estiliza `td > input` fuera de toda
			// capa de CSS (sin borde, 12 px) y le ganaría al `checkbox` de daisyUI.
			const wrap = document.createElement('span');
			wrap.className = 'oc-bool-wrap';
			box = document.createElement('input');
			box.type = 'checkbox';
			box.tabIndex = -1;
			box.className = 'oc-bool checkbox checkbox-sm';
			box.setAttribute('aria-label', column.label);
			wrap.appendChild(box);
			cell.appendChild(wrap);
		}
		box.checked = value === true;
		box.indeterminate = value === null || value === undefined;
		box.disabled = !!column.readOnly;
	};
	return {
		createCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return cell;
		},
		updateCell(cell: HTMLTableCellElement, value: CellValue) {
			paint(cell, value);
			return value;
		},
		// Abrir el editor (doble clic, Enter, teclear) alterna y confirma de inmediato.
		openEditor(cell: HTMLTableCellElement, value: CellValue, _x: number, _y: number, instance: any) {
			disposeActiveEditor();
			const overlay = document.createElement('div');
			activeEditor = { cell, overlay, value: value !== true, original: value, dispose: () => {} };
			// Se confirma en el siguiente turno: jspreadsheet termina de abrir la edición después de llamar aquí.
			setTimeout(() => closeThroughInstance(instance, cell, true), 0);
		},
		closeEditor(cell: HTMLTableCellElement, save: boolean): CellValue {
			const result = save ? (activeEditor?.value ?? null) : (activeEditor?.original ?? null);
			disposeActiveEditor();
			paint(cell, result);
			return result;
		}
	};
}

const booleanType: CellTypeDef = {
	name: 'boolean',
	align: 'center',
	parse: (raw) => toBoolean(raw),
	format: (value) => (value === true ? 'Sí' : value === false ? 'No' : ''),
	equals: (a, b) => (isBlank(a) && isBlank(b)) || a === b,
	fromClipboard: (raw) => toBoolean(raw),
	validate: (value, column) => requiredError(value, column),
	toColumn: (column) => ({ type: buildBooleanEditor(column), align: 'center' })
};

const passwordType: CellTypeDef = {
	name: 'password',
	align: 'left',
	parse: (raw) => (isBlank(raw) ? null : String(raw)),
	format: (value) => passwordDots(value),
	equals: looseEquals,
	// Nunca se exponen secretos al portapapeles del sistema.
	toClipboard: () => '',
	fromClipboard: (raw) => (raw.trim() === '' ? null : raw),
	validate: (value, column) => {
		const req = requiredError(value, column);
		if (req) return req;
		// La marca del servidor es «hay una guardada»: no hay nada que validar.
		if (isBlank(value) || isPasswordMark(value)) return null;
		const s = String(value);
		const min = column.minLength ?? column.min ?? 8;
		if (s.length < min) return `Mínimo ${min} caracteres`;
		if (column.maxLength && s.length > column.maxLength) return `Máximo ${column.maxLength} caracteres`;
		return null;
	},
	toColumn: () => ({ type: buildPasswordEditor(), align: 'left' })
};

// ---------------------------------------------------------------------------
// Registry público
// ---------------------------------------------------------------------------

const registry = new Map<string, CellTypeDef>();

export function registerCellType(def: CellTypeDef): void {
	registry.set(def.name, def);
}

export function getCellType(name: string): CellTypeDef {
	const found = registry.get(name);
	if (!found) {
		console.warn(`[DataGrid] Tipo de celda desconocido: "${name}". Se usa "text".`);
		return textType;
	}
	return found;
}

export function listCellTypes(): string[] {
	return [...registry.keys()];
}

[
	textType,
	numberType,
	dateType,
	dateTimeType,
	selectType,
	remoteSelectType,
	lookupType,
	booleanType,
	imageType,
	fileType,
	folderType,
	longTextType,
	passwordType,
	actionType
].forEach(registerCellType);

export { isBlank, looseEquals, toCanonicalDate, toCanonicalDateTime, toCanonicalNumber };
export type { CellTypeDef, CellTypeContext, ColumnDef, GridRow, Option };
