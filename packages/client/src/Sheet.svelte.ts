import type { SheetSchema } from '@spreadbase/core';
import { lookupKey } from './cellTypes';
import { GridController } from './GridController.svelte';
import { remoteClient, type RemoteOptions } from './remote';
import type { ColumnDef, GridConfig, PageRequest } from './types';

type Remote = ReturnType<typeof remoteClient>;

export interface SheetOptions extends RemoteOptions {
	/**
	 * Lo que solo existe en el cliente, por columna: ancho, el buscador de un
	 * `remote-select`, un editor propio, una validación al teclear. Se mezcla
	 * sobre lo que llega del servidor.
	 */
	columns?: Record<string, Partial<ColumnDef>>;
	/** Borrador local. Con servidor, cualquier valor distinto de `none` usa IndexedDB. Default: `local`. */
	persist?: GridConfig['persist'];
	debug?: boolean;
	frozenColumns?: number;
	height?: string;
	/** Filas por petición. Default 60. */
	pageSize?: number;
	/** Máximo de filas retenidas en la ventana. Default 180. */
	windowSize?: number;
}

/**
 * Esquema del servidor → columnas del grid, con lo propio del cliente encima.
 * Una columna `lookup` busca y resuelve contra `/lookup/:field` (SB-21).
 */
function toColumns(schema: SheetSchema, overrides: Record<string, Partial<ColumnDef>>, remote: Remote): ColumnDef[] {
	return Object.entries(schema.columns).map(([field, spec]) => {
		const { pattern, searchable: _searchable, lookup, ...rest } = spec;
		const column: ColumnDef = { field, ...rest };
		if (pattern) column.pattern = new RegExp(pattern);
		if (lookup) {
			column.lookup = {
				value: lookup.value,
				display: lookup.display,
				columns: lookup.columns,
				minLength: lookup.minLength,
				search: (q, page, signal) => remote.lookup(field, q, page, signal),
				resolve: lookup.resolvable ? (texts) => remote.resolve(field, texts) : undefined,
				ambiguous: new Map()
			};
		}
		return { ...column, ...overrides[field] };
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
			return page;
		};
		const grid: GridController = new GridController({
			id: schema.id,
			idField: schema.idField,
			allowInsert: schema.allowInsert,
			allowDelete: schema.allowDelete,
			columns: toColumns(schema, options.columns ?? {}, remote),
			dataSource: {
				loadPage,
				locate: remote.locate,
				saveBatch: remote.saveBatch,
				strategy: 'window',
				pageSize: options.pageSize,
				windowSize: options.windowSize
			},
			persist: options.persist ?? 'local',
			debug: options.debug,
			frozenColumns: options.frozenColumns,
			height: options.height
		});
		this.grid = grid;
		return grid;
	}
}
