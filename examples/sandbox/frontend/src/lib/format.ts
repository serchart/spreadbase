/**
 * Formato de cifras, fechas y mora.
 *
 * Implementa las reglas del spec 07 §2.2. Centralizado a propósito: si cada
 * vista formatea a su manera, dos pantallas muestran el mismo saldo distinto y
 * el usuario deja de confiar en los números.
 *
 * Regla que atraviesa el archivo: **nunca `$0.00`**. Un saldo cero se pinta
 * como guion largo para bajar el ruido visual de una tabla densa.
 */

export type Maybe<T> = T | null | undefined;

/** Guion largo. Es el "no hay dato" canónico de toda la UI. */
export const DASH = '—';

/** Signo menos tipográfico (U+2212), no el guion de teclado. Alinea en tabular. */
const MINUS = '\u2212';

const mxn = new Intl.NumberFormat('es-MX', {
	style: 'currency',
	currency: 'MXN',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

const plain = new Intl.NumberFormat('es-MX', {
	minimumFractionDigits: 0,
	maximumFractionDigits: 0
});

const oneDecimal = new Intl.NumberFormat('es-MX', {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1
});

function isBlank(value: Maybe<number>): value is null | undefined {
	return value === null || value === undefined || Number.isNaN(value);
}

// ---------------------------------------------------------------------------
// Dinero
// ---------------------------------------------------------------------------

export interface MoneyOptions {
	/**
	 * Pintar el cero como guion. Por defecto `true`, que es la regla del spec.
	 * Se desactiva donde el cero sea informativo (ej. "abonado: $0.00" en un
	 * desglose de pagos, donde el guion se leería como "no aplica").
	 */
	dashOnZero?: boolean;
}

/**
 * Importe con dos decimales y separador de miles: `$35,000.00`.
 *
 * Siempre se acompaña de la utilidad `tabular` en el marcado; sin ella las
 * columnas de importes no alinean.
 */
export function formatMoney(value: Maybe<number>, options: MoneyOptions = {}): string {
	const { dashOnZero = true } = options;

	if (isBlank(value)) return DASH;
	if (value === 0 && dashOnZero) return DASH;

	// Intl ya inserta el signo, pero usa el guion de teclado. Se reemplaza por
	// el menos tipográfico para que un negativo no desalinee la columna.
	return mxn.format(value).replace('-', MINUS);
}

/**
 * Importe abreviado para tarjetas KPI: `$1.2M`, `$845.8K`.
 *
 * El valor exacto va siempre en el `title` del elemento — nunca se pierde la
 * cifra real, solo se abrevia su presentación.
 */
export function formatMoneyCompact(value: Maybe<number>): string {
	if (isBlank(value)) return DASH;
	if (value === 0) return DASH;

	const sign = value < 0 ? MINUS : '';
	const abs = Math.abs(value);

	if (abs >= 1_000_000) return `${sign}$${oneDecimal.format(abs / 1_000_000)}M`;
	if (abs >= 1_000) return `${sign}$${oneDecimal.format(abs / 1_000)}K`;

	return `${sign}$${plain.format(abs)}`;
}

/** Cantidad sin abreviar ni redondear, para el `title` de un KPI. */
export function formatMoneyExact(value: Maybe<number>): string {
	if (isBlank(value)) return DASH;
	return mxn.format(value).replace('-', MINUS);
}

/** Conteo de filas o documentos: `11,062`. */
export function formatCount(value: Maybe<number>): string {
	if (isBlank(value)) return DASH;
	return plain.format(value);
}

/**
 * Variación porcentual con signo explícito: `+2.4%`, `−34.0%`.
 *
 * Es la columna Δ de /imports, donde el signo es la información principal: un
 * corte con menos filas que el anterior es lo que dispara el guardarraíl.
 */
export function formatDelta(ratio: Maybe<number>): string {
	if (isBlank(ratio)) return DASH;
	if (ratio === 0) return '0.0%';

	const sign = ratio > 0 ? '+' : MINUS;
	return `${sign}${oneDecimal.format(Math.abs(ratio) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Fechas
//
// El dominio trabaja con fechas SIN hora: `due_date`, `fecha_corte` y
// `promise_date` son `date` en Postgres. Por eso no se usa `new Date(iso)`:
// esa llamada interpreta 'YYYY-MM-DD' como medianoche UTC y en UTC-06:00
// devuelve el día anterior. Un vencimiento corrido un día cambia el aging,
// la etapa del caso y lo que se le exige al cliente.
// ---------------------------------------------------------------------------

/** Fecha local de hoy, sin hora. */
export function today(): Date {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Convierte 'YYYY-MM-DD' o Date a una fecha local sin hora. */
export function parseDate(value: Maybe<string | Date>): Date | null {
	if (value === null || value === undefined) return null;

	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return null;
		return new Date(value.getFullYear(), value.getMonth(), value.getDate());
	}

	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	if (!match) return null;

	const [, year, month, day] = match;
	return new Date(Number(year), Number(month) - 1, Number(day));
}

/** Representación canónica interna: `2026-06-15`. */
export function toIsoDate(value: Maybe<string | Date>): string | null {
	const date = parseDate(value);
	if (!date) return null;

	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Fecha para mostrar: `15/06/2026`. */
export function formatDate(value: Maybe<string | Date>): string {
	const date = parseDate(value);
	if (!date) return DASH;

	const day = String(date.getDate()).padStart(2, '0');
	const month = String(date.getMonth() + 1).padStart(2, '0');
	return `${day}/${month}/${date.getFullYear()}`;
}

/** Fecha con hora, para bitácoras: `15/06/2026 14:32`. */
export function formatDateTime(value: Maybe<string | Date>): string {
	if (value === null || value === undefined) return DASH;

	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return DASH;

	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	return `${formatDate(date)} ${hours}:${minutes}`;
}

/** Días completos entre dos fechas, ignorando hora y husos. */
export function daysBetween(from: Maybe<string | Date>, to: Maybe<string | Date>): number | null {
	const a = parseDate(from);
	const b = parseDate(to);
	if (!a || !b) return null;

	const MS_PER_DAY = 86_400_000;
	return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Mora
// ---------------------------------------------------------------------------

/**
 * Días de atraso de un vencimiento. Positivo = ya venció.
 *
 * Es el insumo de la etapa del caso y del bucket de aging, así que se calcula
 * en un solo lugar.
 */
export function dpdFrom(dueDate: Maybe<string | Date>, reference: Date = today()): number | null {
	return daysBetween(dueDate, reference);
}

/**
 * Días de atraso con signo: `+45 d`, `−7 d`, `hoy`.
 *
 * El signo es la información, no un adorno: comunica si el cargo ya venció o
 * está por vencer. Por eso se escribe siempre, incluso en positivo.
 */
export function formatDpd(days: Maybe<number>): string {
	if (isBlank(days)) return DASH;
	if (days === 0) return 'hoy';

	return days > 0 ? `+${days} d` : `${MINUS}${Math.abs(days)} d`;
}

/**
 * Antigüedad en lenguaje corto, para la columna "último contacto":
 * `hoy`, `ayer`, `5 d`, `3 sem`, y fecha completa a partir de ~3 meses.
 */
export function formatAge(value: Maybe<string | Date>, reference: Date = today()): string {
	const days = daysBetween(value, reference);
	if (days === null) return DASH;

	if (days < 0) return formatDate(value);
	if (days === 0) return 'hoy';
	if (days === 1) return 'ayer';
	if (days < 7) return `${days} d`;
	if (days < 90) return `${Math.floor(days / 7)} sem`;

	return formatDate(value);
}
