import { filterKind, type SchemaColumn, type SheetSchema } from '@spreadbase/core';
import { lookupKey } from './cellTypes';
import { avatarKey } from './avatar';
import { applyColumnOverrides, type ColumnOverride } from './columns';
import { GridController } from './GridController.svelte';
import { filterParams, remoteClient, type RemoteOptions } from './remote';
import type { CellValue, ColumnAction, ColumnDef, GridConfig, PageRequest, SortSpec } from './types';

type Remote = Pick<ReturnType<typeof remoteClient>, 'upload' | 'lookup' | 'resolve'>;

export interface SheetOptions extends RemoteOptions {
	/**
	 * Lo que solo existe en el cliente, por columna (SB-23): un parche que se
	 * mezcla sobre la columna del servidor (`{ width: 300 }`), o una función que
	 * la recibe y devuelve la final. Un campo que no está en el esquema es una
	 * columna solo del cliente (p. ej. `type: 'action'`), al principio o al
	 * final (`at`), siempre de solo lectura.
	 */
	columns?: Record<string, ColumnOverride>;
	/** Atajo: un botón por fila al principio de la hoja, por acción (columnas `action`). */
	actions?: ColumnAction[];
	/** Borrador local. Con servidor, cualquier valor distinto de `none` usa IndexedDB. Default: `local`. */
	persist?: GridConfig['persist'];
	debug?: boolean;
	frozenColumns?: number;
	height?: string;
	/** Filas por petición. Default 60. */
	pageSize?: number;
	/** Máximo de filas retenidas en la ventana. Default 180. */
	windowSize?: number;
	/** Orden inicial, en lugar del de la hoja en el servidor (SB-33): `{ field: 'due_date', dir: 'desc' }`. */
	sort?: SortSpec;
}

/**
 * Columnas del esquema del servidor → columnas del grid. Una columna `lookup`
 * busca y resuelve contra `/lookup/:field` de `remote` (SB-21). La usan la hoja
 * y el importador (SB-34), con el esquema de un formato.
 */
export function schemaColumns(columns: Record<string, SchemaColumn>, remote: Remote): ColumnDef[] {
	return Object.entries(columns).map(([field, spec]) => {
		const { pattern, searchable: _searchable, lookup, upload, ...rest } = spec;
		// Ordenar y filtrar desde el encabezado (SB-33): lo que el servidor sabe filtrar.
		const column: ColumnDef = { field, ...rest, filterable: filterKind(spec.type) !== null };
		if (upload) column.upload = { ...upload, send: (file) => remote.upload(field, file) };
		if (pattern) column.pattern = new RegExp(pattern);
		if (lookup) {
			column.lookup = {
				value: lookup.value,
				display: lookup.display,
				columns: lookup.columns,
				minLength: lookup.minLength,
				search: (q, page, signal) => remote.lookup(field, q, page, signal),
				resolve: lookup.resolvable ? (texts) => remote.resolve(field, texts) : undefined,
				ambiguous: new Map(),
				resolved: new Map()
			};
		}
		return column;
	});
}

/**
 * Una hoja del lado del cliente: el estado que el componente `<SpreadBase>`
 * dibuja —esquema, ventana de filas, cambios pendientes, historial, borrador,
 * conflictos, guardado—.
 *
 * - `new Sheet('/api/cases')`: contra un servidor de SpreadBase. El esquema se
 *   pide a `GET /api/cases/schema` al conectar (SB-12).
 * - `new Sheet({ id, columns, dataSource })`: sin servidor, con la definición
 *   escrita aquí (datos locales u otra fuente).
 *
 * Crearlo no hace peticiones: `<SpreadBase>` llama a `connect()` al montarse,
 * así que se puede crear en el `<script>` de una página con SSR. Quien quiera
 * esperarlo fuera del componente puede llamar a `connect()` también.
 */
export class Sheet {
	/** El controlador del grid, cuando ya se conoce el esquema. Léelo para escuchar cambios. */
	grid = $state<GridController | null>(null);
	schema = $state<SheetSchema | null>(null);
	/** Por qué no se pudo conectar, si falló. */
	error = $state<string | null>(null);
	readonly url: string | null;

	#options: SheetOptions;
	#connecting: Promise<GridController> | null = null;

	constructor(source: string | GridConfig, options: SheetOptions = {}) {
		this.#options = options;
		if (typeof source === 'string') {
			this.url = source.replace(/\/+$/, '');
		} else {
			this.url = null;
			this.grid = new GridController(source);
		}
	}

	/**
	 * El cliente HTTP de la hoja, con sus mismas cabeceras y `fetch`, y filtros
	 * propios si se dan. Para piezas fuera del grid que hablan el mismo
	 * protocolo (`RecordForm`, SB-32). Sin servidor, `null`.
	 */
	client(filters?: RemoteOptions['filters']) {
		return this.url ? remoteClient(this.url, { ...this.#options, filters }) : null;
	}

	connect(): Promise<GridController> {
		if (this.grid) return Promise.resolve(this.grid);
		this.error = null;
		this.#connecting ??= this.#open().catch((err) => {
			this.error = err instanceof Error ? err.message : String(err);
			this.#connecting = null;
			throw err;
		});
		return this.#connecting;
	}

	async #open(): Promise<GridController> {
		const options = this.#options;
		const remote = remoteClient(this.url!, options);
		const schema = await remote.schema();
		this.schema = schema;
		// Los nombres de los ids de cada tramo (columnas lookup) entran a la caché
		// antes de pintar: la celda nunca muestra un id pelón.
		const loadPage = async (request: PageRequest, signal: AbortSignal) => {
			const page = await remote.loadPage(request, signal);
			for (const [field, labels] of Object.entries(page.labels ?? {})) {
				for (const [id, label] of Object.entries(labels)) grid.labelCache.set(lookupKey(field, id), label);
			}
			// Y la foto de cada registro, si la columna lleva `avatar.image` (SB-29).
			for (const [field, images] of Object.entries(page.images ?? {})) {
				for (const [id, url] of Object.entries(images)) grid.labelCache.set(avatarKey(field, id), url);
			}
			return page;
		};
		// Con filtros fijos (SB-28), el borrador local es de esa parte: el estado de
		// cuenta de un cliente no se mezcla con el de otro.
		const scope = filterParams(options.filters).map(([k, v]) => `${k}=${v}`).join('&');
		const grid: GridController = new GridController({
			id: scope ? `${schema.id}?${scope}` : schema.id,
			idField: schema.idField,
			allowInsert: schema.allowInsert,
			allowDelete: schema.allowDelete,
			columns: applyColumnOverrides(schemaColumns(schema.columns, remote), options.columns, options.actions),
			dataSource: {
				loadPage,
				locate: remote.locate,
				saveBatch: remote.saveBatch,
				queryable: true,
				values: async (field, state, signal) => {
					const result = await remote.values(field, state, signal);
					for (const [id, label] of Object.entries(result.labels ?? {})) grid.labelCache.set(lookupKey(field, id), label);
					return result;
				},
				strategy: 'window',
				pageSize: options.pageSize,
				windowSize: options.windowSize
			},
			persist: options.persist ?? 'local',
			debug: options.debug,
			frozenColumns: options.frozenColumns,
			height: options.height,
			sort: options.sort,
			// Con filtros fijos, las altas nacen dentro de esa parte (un contacto nuevo es de ese cliente).
			fixedValues: fixedValues(options.filters)
		});
		this.grid = grid;
		return grid;
	}
}

/** Los filtros fijos de un solo valor, como valores de las filas nuevas (SB-28). */
function fixedValues(filters: SheetOptions['filters']): Record<string, CellValue> | undefined {
	const entries = Object.entries(filters ?? {}).filter(
		(e): e is [string, string | number | boolean] => e[1] !== null && e[1] !== undefined && !Array.isArray(e[1])
	);
	return entries.length ? Object.fromEntries(entries) : undefined;
}
