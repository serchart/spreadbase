/**
 * Columnas del cliente sobre el esquema del servidor (SB-23).
 *
 * El servidor define la hoja (SB-12); el cliente puede **ajustar** cualquier
 * columna de ese esquema o **agregar** columnas que solo existen en pantalla
 * (un botón por fila, un renderizador propio). Todo pasa por aquí:
 *
 * - `columns[field]` es un **parche** que se mezcla sobre la columna del
 *   servidor, o una **función** que la recibe y devuelve la final.
 * - Si `field` no está en el esquema, es una columna **solo del cliente**: va
 *   al principio o al final (`at`) y siempre es de solo lectura, porque no hay
 *   dónde guardarla.
 * - `actions` es un atajo: cada acción es una columna `action` al principio.
 * - `hidden: true` saca una columna de la vista: la que ya dice el contexto (el
 *   cliente, en la Ficha de ese cliente). En las filas nuevas, su valor lo
 *   ponen los filtros fijos de la hoja (`fixedValues`).
 */
import type { ColumnAction, ColumnDef } from './types';

/** Dónde va una columna que solo existe en el cliente. Default: `end`. */
export type ColumnPlacement = 'start' | 'end';

type Placed = { at?: ColumnPlacement };

/**
 * Ajuste del cliente a una columna: un parche (`{ width: 300 }`) o una
 * función que recibe la columna del servidor —`undefined` si no existe— y
 * devuelve la final.
 */
export type ColumnOverride =
	| (Partial<ColumnDef> & Placed)
	| ((column: ColumnDef | undefined) => Partial<ColumnDef> & Placed);

/** Los campos de las columnas creadas por `actions`: `__action_0`, `__action_1`… */
export const actionField = (index: number) => `__action_${index}`;

/** `actions` → columnas `action` al principio. Es solo azúcar: después se ajustan como cualquier otra. */
export function actionColumns(actions: ColumnAction[]): ColumnDef[] {
	return actions.map((action, i) => ({
		field: actionField(i),
		type: 'action',
		label: '',
		width: action.showLabel === false ? 50 : 100,
		readOnly: true,
		action
	}));
}

export function applyColumnOverrides(
	server: ColumnDef[],
	overrides: Record<string, ColumnOverride> = {},
	actions: ColumnAction[] = []
): ColumnDef[] {
	const resolve = (override: ColumnOverride, column: ColumnDef | undefined) =>
		typeof override === 'function' ? override(column) : { ...column, ...override };

	// Ajuste de una columna que ya existe (del servidor o del atajo). El campo no
	// se renombra: es la llave con la que la fila viaja al servidor.
	const adjust = (column: ColumnDef): ColumnDef => {
		const override = overrides[column.field];
		if (!override) return column;
		const { at: _, ...rest } = resolve(override, column);
		return { ...rest, field: column.field } as ColumnDef;
	};

	const fromActions = actionColumns(actions).map((c) => ({ ...adjust(c), readOnly: true }));
	const fromServer = server.map(adjust);
	const known = new Set([...fromActions, ...fromServer].map((c) => c.field));

	// Columnas solo del cliente: no hay dónde guardarlas, así que son de solo lectura.
	const start: ColumnDef[] = [];
	const end: ColumnDef[] = [];
	for (const [field, override] of Object.entries(overrides)) {
		if (known.has(field)) continue;
		const { at = 'end', ...rest } = resolve(override, undefined);
		if (!rest.type) {
			throw new Error(`SpreadBase: la columna «${field}» no está en el esquema del servidor y no declara \`type\``);
		}
		const column = { label: '', ...rest, field, readOnly: true } as ColumnDef;
		(at === 'start' ? start : end).push(column);
	}

	// Las acciones del atajo primero; luego las del principio, el esquema y las del final.
	// `hidden` saca la columna de la vista (su valor en altas lo ponen los filtros fijos).
	return [...fromActions, ...start, ...fromServer, ...end].filter((c) => !c.hidden);
}
