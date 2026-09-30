import type { Request, Response } from 'express';
import { parseBatch, parseListQuery } from '@spreadbase/server';
import { ValidationError } from '../../common/errors.ts';
import { logBatch, logMutate } from './cases.log.ts';
import { MUTABLE_FIELDS, type CasesService, type MutableField } from './cases.service.ts';

const MAX_MUTATE = 5_000;

/**
 * Traduce HTTP ↔ servicio. Los helpers de SpreadBase leen la forma de la
 * petición; lo demás (logs, usuario, formato) es de la app.
 */
export class CasesController {
	constructor(private readonly service: CasesService) {}

	schema = (_req: Request, res: Response) => {
		res.json(this.service.portfolio.schema());
	};

	list = async (req: Request, res: Response) => {
		res.json(await this.service.portfolio.list(parseListQuery(req.query)));
	};

	values = async (req: Request, res: Response) => {
		res.json(await this.service.portfolio.values(String(req.params.field), parseListQuery(req.query)));
	};

	position = async (req: Request, res: Response) => {
		res.json(await this.service.portfolio.position(String(req.params.id), parseListQuery(req.query)));
	};

	get = async (req: Request, res: Response) => {
		res.json(await this.service.portfolio.get(String(req.params.id)));
	};

	batch = async (req: Request, res: Response) => {
		const input = parseBatch(req.body);
		const key = req.get('Idempotency-Key');
		// La idempotencia la lleva el motor (SB-18). En OpenCollect, `context` llevaría el usuario.
		const { result, replayed } = await this.service.portfolio.batch(input, { idempotencyKey: key, context: {} });
		logBatch(input, result, key, replayed);
		if (replayed) res.set('Idempotent-Replayed', 'true');
		res.json(result);
	};

	// -- solo pruebas ---------------------------------------------------------

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
