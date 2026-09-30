import { filterValueOf, fold, matchesFilter } from '@spreadbase/core';
import type { CellValue, DistinctValue, ListQuery, Page, Row, SheetDefinition } from '@spreadbase/core';
import type { SheetSource } from './source.ts';

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

export interface MemorySourceOptions {
	/** Filas iniciales. Sin `rowVersion`, empiezan en 1. */
	rows: Record<string, unknown>[];
	/** Id de una fila nueva. Recibe un contador que empieza tras las filas iniciales. Default: `String(n)`. */
	createId?: (n: number) => string;
}

/** En memoria todo es síncrono: quien la usa directamente no tiene que esperar. */
export interface MemorySource extends SheetSource {
	list(query: ListQuery): Page;
	values(field: string, query: ListQuery, limit: number): DistinctValue[];
	position(id: string, query: ListQuery): { position: number | null; total: number };
	get(id: string): Row | undefined;
	insert(values: Record<string, CellValue>): Row;
	update(id: string, values: Record<string, CellValue>): Row;
	remove(id: string): void;
	/** Sustituye todas las filas (p. ej. volver a la semilla en pruebas). */
	reset(rows: Record<string, unknown>[]): void;
	readonly size: number;
	/** Todas las filas, en orden de inserción. Solo lectura: para escribir usa `update`. */
	all(): readonly Row[];
}

/**
 * Fuente en memoria: para demos, pruebas y los ejemplos.
 *
 * **Vistas cacheadas.** Filtrar y ordenar decenas de miles de filas cuesta
 * decenas de ms, y el scroll pide una página tras otra con la misma consulta.
 * Cada combinación de orden, filtros y búsqueda se calcula una vez y se
 * reutiliza hasta que cambian los datos (`version`). Es lo que haría un índice
 * en Postgres.
 */
export function memorySource(options: MemorySourceOptions): MemorySource {
	let definition: SheetDefinition | null = null;
	let idField = 'id';
	let rows: Row[] = [];
	let byId = new Map<string, Row>();
	let counter = 0;
	/** Sube con cada escritura. Invalida las vistas y viaja en cada página. */
	let version = 0;
	const views = new Map<string, { version: number; rows: Row[]; position?: Map<string, number> }>();
	const createId = options.createId ?? ((n: number) => String(n));

	const idOf = (row: Record<string, unknown>) => String(row[idField]);

	/** Bajas pendientes de sacar del arreglo: se compactan de una vez, no una por una. */
	const removed = new Set<string>();
	function compact() {
		if (removed.size === 0) return;
		rows = rows.filter((r) => !removed.has(idOf(r)));
		removed.clear();
	}

	function load(initial: Record<string, unknown>[]) {
		removed.clear();
		rows = initial.map((r) => ({ ...r, rowVersion: typeof r.rowVersion === 'number' ? r.rowVersion : 1 }));
		byId = new Map(rows.map((r) => [idOf(r), r]));
		counter = rows.length;
		version++;
		views.clear();
	}

	function searchFields(): string[] {
		const columns = Object.entries(definition?.columns ?? {});
		const marked = columns.filter(([, c]) => c.searchable).map(([f]) => f);
		return marked.length > 0 ? marked : columns.filter(([, c]) => c.type === 'text').map(([f]) => f);
	}

	function view(query: ListQuery): { rows: Row[]; key: string } {
		compact();
		const key = JSON.stringify([query.sort, query.filters, query.search, query.where ?? []]);
		const cached = views.get(key);
		if (cached?.version === version) return { rows: cached.rows, key };

		const filters = Object.entries(query.filters).map(([field, values]) => [field, new Set(values)] as const);
		const needle = fold(query.search.trim());
		const searchable = searchFields();
		const where = (query.where ?? []).map((f) => [f, definition?.columns[f.field]?.type ?? 'text'] as const);
		let result = rows.filter(
			(r) =>
				filters.every(([field, values]) => values.has(String(r[field] ?? ''))) &&
				where.every(([f, type]) => matchesFilter(r[f.field], f, type)) &&
				(needle === '' ||
					idOf(r).includes(needle) ||
					searchable.some((f) => typeof r[f] === 'string' && fold(r[f] as string).includes(needle)))
		);

		/*
			El orden **siempre** termina en el id. Sin desempate, dos filas con el
			mismo valor pueden intercambiarse entre dos consultas y una fila
			aparecer en dos páginas —o en ninguna— al paginar.
		*/
		const sort = query.sort;
		if (sort) {
			const dir = sort.dir === 'asc' ? 1 : -1;
			const numeric = definition?.columns[sort.field]?.type === 'number';
			result = result.sort((a, b) => {
				const va = a[sort.field] ?? null;
				const vb = b[sort.field] ?? null;
				// Los vacíos van al final en ambos sentidos.
				if (va === null && vb !== null) return 1;
				if (vb === null && va !== null) return -1;
				if (va !== null && vb !== null && va !== vb) {
					const cmp = numeric ? Number(va) - Number(vb) : collator.compare(String(va), String(vb));
					if (cmp !== 0) return cmp * dir;
				}
				const ia = idOf(a);
				const ib = idOf(b);
				return ia < ib ? -1 : ia > ib ? 1 : 0;
			});
		}
		// Sin orden explícito se conserva el de inserción.

		views.set(key, { version, rows: result });
		return { rows: result, key };
	}

	/** En memoria el testigo es un contador: la fuente ve todas las escrituras. */
	function write(row: Row, values: Record<string, CellValue>) {
		row.rowVersion = Number(row.rowVersion) + 1;
		for (const [field, value] of Object.entries(values)) row[field] = value;
		version++;
	}

	load(options.rows);

	return {
		attach(def) {
			definition = def;
			idField = def.idField ?? 'id';
			load(rows);
		},

		reset(initial) {
			load(initial);
		},

		get size() {
			return byId.size;
		},

		all() {
			compact();
			return rows;
		},

		list(query: ListQuery): Page {
			const { rows: result } = view(query);
			return {
				rows: result.slice(query.offset, query.offset + query.limit),
				total: result.length,
				offset: query.offset,
				limit: query.limit,
				version
			};
		},

		values(field, query, limit) {
			const { rows: result } = view({ ...query, sort: null });
			const type = definition?.columns[field]?.type ?? 'text';
			const counts = new Map<string, DistinctValue>();
			for (const r of result) {
				const value = filterValueOf(r[field], type);
				const key = value === null ? '\u0000' : String(value);
				const hit = counts.get(key);
				if (hit) hit.count++;
				else counts.set(key, { value, count: 1 });
			}
			// Las vacías primero; luego en el orden de la columna.
			return [...counts.values()]
				.sort((a, b) =>
					a.value === null ? -1 : b.value === null ? 1 : type === 'number' ? Number(a.value) - Number(b.value) : collator.compare(String(a.value), String(b.value))
				)
				.slice(0, limit);
		},

		position(id, query) {
			const { rows: result, key } = view(query);
			const cached = views.get(key)!;
			cached.position ??= new Map(result.map((r, i) => [idOf(r), i]));
			return { position: cached.position.get(id) ?? null, total: result.length };
		},

		get(id) {
			return byId.get(id);
		},

		insert(values) {
			const defaults: Record<string, unknown> = {};
			for (const [field, spec] of Object.entries(definition?.columns ?? {})) defaults[field] = spec.defaultValue ?? null;
			const row: Row = { ...defaults, ...values, [idField]: createId(++counter), rowVersion: 1 };
			rows.push(row);
			byId.set(idOf(row), row);
			version++;
			return row;
		},

		update(id, values) {
			const row = byId.get(id);
			if (!row) throw new Error(`memorySource: no existe la fila ${id}`);
			write(row, values);
			return row;
		},

		remove(id) {
			if (!byId.delete(id)) return;
			removed.add(id);
			version++;
		}
	};
}
