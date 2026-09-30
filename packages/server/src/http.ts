import express, { Router } from 'express';
import type { Request } from 'express';
import { parseWhere } from '@spreadbase/core';
import type { BatchInput, ListQuery, LookupQuery } from '@spreadbase/core';
import { SpreadBaseError, ValidationError } from './errors.ts';
import { MAX_RESOLVE_TEXTS } from './SpreadBase.ts';
import type { BatchContext, SpreadBase } from './SpreadBase.ts';

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const LOOKUP_MAX_LIMIT = 100;
const LOOKUP_DEFAULT_LIMIT = 50;
const RESERVED = new Set(['offset', 'limit', 'sort', 'search', 'where']);

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
 * `?offset=0&limit=100&sort=dpd:desc&stage_code=early,late&search=grúas&where=[…]`
 *
 * Todo parámetro que no sea de paginación, orden, búsqueda o `where` es un
 * filtro fijo por columna con valores separados por coma (SB-28). `where` son
 * los filtros de la persona, en JSON (SB-33).
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
	let where: ListQuery['where'] = [];
	if (typeof query.where === 'string' && query.where !== '') {
		try {
			where = parseWhere(query.where);
		} catch (err) {
			throw new ValidationError((err as Error).message);
		}
	}
	return {
		offset: intParam(query.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
		limit: intParam(query.limit, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT),
		sort,
		filters,
		search: typeof query.search === 'string' ? query.search : '',
		where
	};
}

/** `?q=ana&offset=0&limit=50` de `GET /lookup/:field` (SB-21). */
export function parseLookupQuery(query: Request['query']): LookupQuery {
	return {
		q: typeof query.q === 'string' ? query.q.trim() : '',
		offset: intParam(query.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
		limit: intParam(query.limit, 'limit', LOOKUP_DEFAULT_LIMIT, 1, LOOKUP_MAX_LIMIT)
	};
}

/** `{ texts: [...] }` de `POST /lookup/:field/resolve`. */
export function parseResolve(body: unknown): string[] {
	const texts = isRecord(body) ? body.texts : undefined;
	if (!Array.isArray(texts) || !texts.every((t) => typeof t === 'string')) {
		throw new ValidationError('El cuerpo debe ser { texts: string[] }');
	}
	if (texts.length > MAX_RESOLVE_TEXTS) throw new ValidationError(`Hasta ${MAX_RESOLVE_TEXTS} textos por petición`);
	return texts;
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
	/**
	 * El contexto de la petición: el usuario, por ejemplo. Lo reciben los
	 * handlers de cada lote y las funciones de las columnas `lookup`.
	 */
	context?: (req: Request) => BatchContext;
}

/**
 * Las rutas del protocolo, ya conectadas a una hoja. Es el controlador y las
 * rutas que escribiría la app, ya escritos; garantiza que coinciden con lo que
 * pide `new Sheet(url)` en el cliente.
 *
 *   GET  /schema
 *   GET  /?offset&limit&sort&search&where&<campo>=a,b
 *   GET  /values/:field?search&where&<campo>=a,b   (valores distintos, SB-33)
 *   GET  /lookup/:field?q&offset&limit    (columnas lookup, SB-21)
 *   POST /upload/:field                   (columnas image y file con upload, SB-30)
 *   POST /lookup/:field/resolve           (columnas lookup, SB-21)
 *   GET  /:id/position
 *   GET  /:id
 *   POST /batch          (acepta Idempotency-Key)
 */
export function sheetRouter(sheet: SpreadBase, options: SheetRouterOptions = {}): Router {
	const router = Router();
	const context = (req: Request) => options.context?.(req) ?? {};
	router.get('/schema', (_req, res) => {
		res.json(sheet.schema());
	});
	router.get('/', async (req, res) => {
		res.json(await sheet.list(parseListQuery(req.query), context(req)));
	});
	router.get('/values/:field', async (req, res) => {
		res.json(await sheet.values(String(req.params.field), parseListQuery(req.query), context(req)));
	});
	router.get('/lookup/:field', async (req, res) => {
		res.json(await sheet.lookup(String(req.params.field), parseLookupQuery(req.query), context(req)));
	});
	router.post('/lookup/:field/resolve', async (req, res) => {
		res.json(await sheet.resolve(String(req.params.field), parseResolve(req.body), context(req)));
	});
	router.use(sheetUpload(sheet, options));
	router.get('/:id/position', async (req, res) => {
		res.json(await sheet.position(String(req.params.id), parseListQuery(req.query)));
	});
	router.get('/:id', async (req, res) => {
		res.json(await sheet.get(String(req.params.id)));
	});
	router.post('/batch', async (req, res) => {
		const { result, replayed } = await sheet.batch(parseBatch(req.body), {
			idempotencyKey: req.get('Idempotency-Key'),
			context: context(req)
		});
		if (replayed) res.set('Idempotent-Replayed', 'true');
		res.json(result);
	});
	return router;
}

/**
 * `POST /upload/:field` de una hoja (SB-30), para montarlo junto a rutas
 * escritas a mano (`router.use(sheetUpload(sheet))`); `sheetRouter` ya lo trae.
 *
 * El cuerpo son los bytes tal cual (sin multipart) y el nombre va en
 * `X-File-Name`. El límite de tamaño es el de la columna: lo que lo pasa se
 * corta sin leerlo entero. Devuelve `201 { url, name, type, size }`.
 */
export function sheetUpload(sheet: SpreadBase, options: SheetRouterOptions = {}): Router {
	// Desde aquí el esquema anuncia las columnas con `upload` (sin la ruta, el cliente no ofrece «Subir»).
	sheet.markUploadsMounted();
	const router = Router();
	router.post(
		'/upload/:field',
		(req, res, next) => {
			const max = sheet.uploadMaxSize(String(req.params.field));
			// Sin `upload`, el motor responde el error; no se lee el cuerpo.
			if (max === null) return next();
			express.raw({ type: () => true, limit: max })(req, res, (err?: unknown) => {
				if ((err as { type?: string } | undefined)?.type === 'entity.too.large') {
					return next(new SpreadBaseError(413, 'file_too_large', 'El archivo pasa del máximo permitido'));
				}
				next(err);
			});
		},
		async (req, res) => {
			const bytes = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
			const header = req.get('X-File-Name') ?? '';
			let name = header;
			try {
				name = decodeURIComponent(header);
			} catch {
				// Un nombre mal codificado no impide subir: se limpia igual.
			}
			res.status(201).json(await sheet.upload(String(req.params.field), { bytes, name }, options.context?.(req) ?? {}));
		}
	);
	return router;
}
