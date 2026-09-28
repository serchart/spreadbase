import { Router } from 'express';
import type { Request } from 'express';
import type { BatchInput, ListQuery } from '@spreadbase/core';
import { ValidationError } from './errors.ts';
import type { BatchContext, SpreadBase } from './SpreadBase.ts';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const RESERVED = new Set(['offset', 'limit', 'sort', 'search']);

function intParam(value: unknown, name: string, fallback: number, min: number, max: number): number {
	if (value === undefined || value === '') return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new ValidationError(`${name} debe ser un entero entre ${min} y ${max}`);
	}
	return n;
}

const csv = (value: string): string[] => value.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * `?offset=0&limit=100&sort=dpd:desc&stage_code=early,late&search=grúas`
 *
 * Todo parámetro que no sea de paginación, orden o búsqueda es un filtro por
 * columna con valores separados por coma.
 */
export function parseListQuery(query: Request['query']): ListQuery {
	let sort: ListQuery['sort'] = null;
	if (typeof query.sort === 'string' && query.sort !== '') {
		const [field, dir = 'asc'] = query.sort.split(':');
		if (!field) throw new ValidationError('sort debe ser «campo:asc» o «campo:desc»');
		if (dir !== 'asc' && dir !== 'desc') throw new ValidationError('El sentido debe ser asc o desc');
		sort = { field, dir };
	}
	const filters: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(query)) {
		if (RESERVED.has(key) || typeof value !== 'string') continue;
		const values = csv(value);
		if (values.length > 0) filters[key] = values;
	}
	return {
		offset: intParam(query.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
		limit: intParam(query.limit, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT),
		sort,
		filters,
		search: typeof query.search === 'string' ? query.search : ''
	};
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** El testigo de versión es opaco: un número o un texto no vacío. */
const isVersion = (v: unknown): v is string | number =>
	(typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v !== '');

/** Valida la **forma** del lote. Las reglas sobre los valores son del motor. */
export function parseBatch(body: unknown): BatchInput {
	if (!isRecord(body)) throw new ValidationError('El cuerpo debe ser un objeto');
	const list = (name: string) => {
		const value = body[name] ?? [];
		if (!Array.isArray(value)) throw new ValidationError(`${name} debe ser una lista`);
		return value as unknown[];
	};

	const creates = list('creates').map((c, i) => {
		if (!isRecord(c) || typeof c.key !== 'string' || !isRecord(c.values)) {
			throw new ValidationError(`creates[${i}] debe ser { key, values }`);
		}
		return { key: c.key, values: c.values };
	});
	const updates = list('updates').map((u, i) => {
		if (!isRecord(u) || typeof u.id !== 'string' || !isVersion(u.rowVersion) || !isRecord(u.changes)) {
			throw new ValidationError(`updates[${i}] debe ser { id, rowVersion, changes, base? }`);
		}
		if (u.base !== undefined && !isRecord(u.base)) {
			throw new ValidationError(`updates[${i}].base debe ser un objeto`);
		}
		for (const [field, change] of Object.entries(u.changes)) {
			if (!isRecord(change) || !('from' in change) || !('to' in change)) {
				throw new ValidationError(`updates[${i}].changes.${field} debe ser { from, to }`);
			}
		}
		return { id: u.id, rowVersion: u.rowVersion, changes: u.changes, base: u.base };
	});
	const deletes = list('deletes').map((d, i) => {
		if (!isRecord(d) || typeof d.id !== 'string' || !isVersion(d.rowVersion)) {
			throw new ValidationError(`deletes[${i}] debe ser { id, rowVersion }`);
		}
		return { id: d.id, rowVersion: d.rowVersion };
	});

	return { creates, updates, deletes } as BatchInput;
}

export interface SheetRouterOptions {
	/** Lo que reciben los handlers de dominio en cada lote: el usuario, por ejemplo. */
	context?: (req: Request) => BatchContext;
}

/**
 * Las cinco rutas del protocolo, ya conectadas a una hoja. Es el controlador
 * y las rutas que escribiría la app, ya escritos; garantiza que coinciden con
 * lo que pide `new Sheet(url)` en el cliente.
 *
 *   GET  /schema
 *   GET  /?offset&limit&sort&search&<campo>=a,b
 *   GET  /:id/position
 *   GET  /:id
 *   POST /batch          (acepta Idempotency-Key)
 */
export function sheetRouter(sheet: SpreadBase, options: SheetRouterOptions = {}): Router {
	const router = Router();
	router.get('/schema', (_req, res) => {
		res.json(sheet.schema());
	});
	router.get('/', async (req, res) => {
		res.json(await sheet.list(parseListQuery(req.query)));
	});
	router.get('/:id/position', async (req, res) => {
		res.json(await sheet.position(String(req.params.id), parseListQuery(req.query)));
	});
	router.get('/:id', async (req, res) => {
		res.json(await sheet.get(String(req.params.id)));
	});
	router.post('/batch', async (req, res) => {
		const { result, replayed } = await sheet.batch(parseBatch(req.body), {
			idempotencyKey: req.get('Idempotency-Key'),
			context: options.context?.(req)
		});
		if (replayed) res.set('Idempotent-Replayed', 'true');
		res.json(result);
	});
	return router;
}
