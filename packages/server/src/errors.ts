import type { ErrorRequestHandler, RequestHandler } from 'express';

/**
 * Error con estado HTTP y código estable. El `code` es el contrato con el
 * cliente: el mensaje puede cambiar de redacción, el código no.
 *
 * La forma de la respuesta es `{ error: { code, message, details? } }`. Una
 * app con su propio manejador de errores solo tiene que reconocer esta clase.
 */
export class SpreadBaseError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown
	) {
		super(message);
	}
}

export class ValidationError extends SpreadBaseError {
	constructor(message: string, details?: unknown) {
		super(400, 'validation_error', message, details);
	}
}

export class NotFoundError extends SpreadBaseError {
	constructor(message: string) {
		super(404, 'not_found', message);
	}
}

/** Manejador listo para apps que no tienen el suyo (quickstart). */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
	if (err instanceof SpreadBaseError) {
		res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
		return;
	}
	if (err?.type === 'entity.parse.failed') {
		res.status(400).json({ error: { code: 'invalid_json', message: 'El cuerpo no es JSON válido' } });
		return;
	}
	console.error(err);
	res.status(500).json({ error: { code: 'internal_error', message: 'Error interno' } });
};

export const notFoundHandler: RequestHandler = (req, res) => {
	res.status(404).json({ error: { code: 'route_not_found', message: `No existe ${req.method} ${req.path}` } });
};
