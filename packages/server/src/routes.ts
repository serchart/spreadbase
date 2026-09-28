/**
 * Rutas HTTP del motor: `spreadBase(engine)` devuelve un Router de Express.
 *
 *   GET  /catalogs           esquema, opciones y política
 *   GET  /?offset&limit&sort&search&<campo>=a,b
 *   GET  /:id/position       posición global dentro de la consulta
 *   GET  /:id                una fila
 *   POST /batch              lote de guardado (acepta Idempotency-Key)
 *
 * Express 5 propaga los errores de los manejadores, también los asíncronos.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SheetEngine } from './engine.ts';
import { idempotent } from './idempotency.ts';
import { ValidationError } from './errors.ts';

function parseListQuery(req: Request) {
	const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
	const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 0) || 60));

	const rawSort = typeof req.query.sort === 'string' ? req.query.sort : null;
	const sort = rawSort
		? (() => {
				const [field, dir] = rawSort.split(':');
				if (!field || (dir !== 'asc' && dir !== 'desc')) {
					throw new ValidationError('sort debe ser «campo:asc» o «campo:desc»');
				}
				return { field, dir } as const;
			})()
		: null;

	const reserved = new Set(['offset', 'limit', 'sort', 'search']);
	const filters: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(req.query)) {
		if (reserved.has(key) || typeof value !== 'string' || value === '') continue;
		filters[key] = value.split(',');
	}

	return { offset, limit, sort, search: typeof req.query.search === 'string' ? req.query.search : '', filters };
}

function parseBatch(body: unknown): Parameters<SheetEngine['batch']>[0] {
	if (typeof body !== 'object' || body === null) throw badRequest();
	const list = (name: string) => {
		const v = (body as Record<string, unknown>)[name];
		if (v === undefined) return [];
		if (!Array.isArray(v)) throw badRequest(`'${name}' debe ser una lista`);
		return v;
	};
	const badRequest400 = (m: string): never => {
		throw new ValidationError(m);
	};
	const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

	const updates = list('updates').map((u, i) => {
		if (!isRecord(u) || u.id === undefined || typeof u.rowVersion !== 'number' || !isRecord(u.changes)) {
			throw badRequest400(`updates[${i}] debe ser { id, rowVersion, changes }`);
		}
		for (const [field, change] of Object.entries(u.changes)) {
			if (!isRecord(change) || !('from' in change) || !('to' in change)) {
				throw badRequest400(`updates[${i}].changes.${field} debe ser { from, to }`);
			}
		}
		return { id: u.id, rowVersion: u.rowVersion, changes: u.changes };
	});
	const deletes = list('deletes').map((d, i) => {
		if (!isRecord(d) || d.id === undefined || typeof d.rowVersion !== 'number') {
			throw badRequest400(`deletes[${i}] debe ser { id, rowVersion }`);
		}
		return { id: d.id, rowVersion: d.rowVersion };
	});
	const creates = list('creates').map((c, i) => {
		if (!isRecord(c) || typeof c.key !== 'string' || !isRecord(c.values)) {
			throw badRequest400(`creates[${i}] debe ser { key, values }`);
		}
		return { key: c.key, values: c.values };
	});
	return { creates: creates as any, updates: updates as any, deletes: deletes as any };
}

function badRequest(message = 'El lote debe ser un objeto'): never {
	throw new ValidationError(message);
}

export function spreadBase(engine: SheetEngine): Router {
	const router = Router();

	router.get('/catalogs', (_req, res) => res.json(engine.catalogs()));

	router.get('/', (req, res) => res.json(engine.list(parseListQuery(req))));

	router.get('/:id/position', (req, res) => res.json(engine.position(req.params.id, parseListQuery(req))));

	router.get('/:id', (req, res) => res.json(engine.byIdOrThrow(req.params.id)));

	router.post('/batch', idempotent(), (req: Request, res: Response) => {
		res.json(engine.batch(parseBatch(req.body)));
	});

	return router;
}
