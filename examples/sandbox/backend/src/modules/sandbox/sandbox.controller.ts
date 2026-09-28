import type { Request, Response } from 'express';
import { ValidationError } from '../../common/errors.ts';
import { FIELDS } from './sandbox.seed.ts';
import { logBatch, logMutate } from './sandbox.log.ts';
import { MUTABLE_FIELDS, type MutableField, type SandboxService } from './sandbox.service.ts';
import type { BatchInput, FieldName, ListQuery } from './sandbox.types.ts';

const MAX_LIMIT = 500;
const MAX_MUTATE = 5_000;

/**
 * Traduce HTTP ↔ servicio. Valida la **forma** de la petición —tipos, rangos,
 * campos conocidos—; las reglas sobre los valores son del servicio.
 */
export class SandboxController {
	constructor(private readonly service: SandboxService) {}

	list = (req: Request, res: Response) => {
		res.json(this.service.list(parseListQuery(req.query)));
	};

	get = (req: Request, res: Response) => {
		res.json(this.service.get(String(req.params.id)));
	};

	position = (req: Request, res: Response) => {
		res.json(this.service.position(String(req.params.id), parseListQuery(req.query)));
	};

	catalogs = (_req: Request, res: Response) => {
		res.json(this.service.catalogs());
	};

	batch = (req: Request, res: Response) => {
		const input = parseBatch(req.body);
		const result = this.service.batch(input);
		logBatch(input, result, req.header('idempotency-key'));
		res.json(result);
	};

	mutate = (req: Request, res: Response) => {
		const body = (req.body ?? {}) as { count?: unknown; ids?: unknown; fields?: unknown };
		const count = body.count === undefined ? 10 : Number(body.count);
		if (!Number.isInteger(count) || count < 1 || count > MAX_MUTATE) {
			throw new ValidationError(`count debe ser un entero entre 1 y ${MAX_MUTATE}`);
		}
		if (body.ids !== undefined && !(Array.isArray(body.ids) && body.ids.every((i) => typeof i === 'string'))) {
			throw new ValidationError('ids debe ser una lista de ids');
		}
		const allowed: readonly string[] = MUTABLE_FIELDS;
		if (
			body.fields !== undefined &&
			!(Array.isArray(body.fields) && body.fields.length > 0 && body.fields.every((f) => allowed.includes(f)))
		) {
			throw new ValidationError(`fields debe ser una lista con: ${allowed.join(', ')}`);
		}
		const result = this.service.mutate(count, body.ids as string[] | undefined, body.fields as MutableField[] | undefined);
		logMutate(result.mutated);
		res.json(result);
	};

	reset = (_req: Request, res: Response) => {
		res.json(this.service.reset());
	};
}

function intParam(value: unknown, name: string, fallback: number, min: number, max: number): number {
	if (value === undefined || value === '') return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new ValidationError(`${name} debe ser un entero entre ${min} y ${max}`);
	}
	return n;
}

const csv = (value: unknown): string[] =>
	typeof value === 'string' && value !== '' ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];

/** `?offset=0&limit=100&sort=dpd:desc&stage=early,late&handler=agt_1&search=grúas` */
function parseListQuery(query: Request['query']): ListQuery {
	let sort: ListQuery['sort'] = null;
	if (typeof query.sort === 'string' && query.sort !== '') {
		const [field, dir = 'asc'] = query.sort.split(':');
		if (!field || !(field in FIELDS)) throw new ValidationError(`No se puede ordenar por "${field}"`);
		if (dir !== 'asc' && dir !== 'desc') throw new ValidationError('El sentido debe ser asc o desc');
		sort = { field: field as FieldName, dir };
	}
	return {
		offset: intParam(query.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
		limit: intParam(query.limit, 'limit', 100, 1, MAX_LIMIT),
		sort,
		stage: csv(query.stage),
		handler: csv(query.handler),
		search: typeof query.search === 'string' ? query.search : ''
	};
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;

function parseBatch(body: unknown): BatchInput {
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
			throw new ValidationError(`updates[${i}] debe ser { id, rowVersion, changes }`);
		}
		for (const [field, change] of Object.entries(u.changes)) {
			if (!isRecord(change) || !('from' in change) || !('to' in change)) {
				throw new ValidationError(`updates[${i}].changes.${field} debe ser { from, to }`);
			}
		}
		return { id: u.id, rowVersion: u.rowVersion, changes: u.changes };
	});
	const deletes = list('deletes').map((d, i) => {
		if (!isRecord(d) || typeof d.id !== 'string' || !isVersion(d.rowVersion)) {
			throw new ValidationError(`deletes[${i}] debe ser { id, rowVersion }`);
		}
		return { id: d.id, rowVersion: d.rowVersion };
	});

	return { creates, updates, deletes } as BatchInput;
}
