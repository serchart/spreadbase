import type { ErrorRequestHandler, RequestHandler } from 'express';
import { SpreadBaseError } from '@spreadbase/server';

/**
 * Error con estado HTTP y código estable.
 *
 * El `code` es el contrato con el frontend: el mensaje puede cambiar de
 * redacción, el código no. La UI decide qué mostrar a partir del código.
 */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: unknown
	) {
		super(message);
	}
}

export class ValidationError extends HttpError {
	constructor(message: string, details?: unknown) {
		super(400, 'validation_error', message, details);
	}
}

export class NotFoundError extends HttpError {
	constructor(message: string) {
		super(404, 'not_found', message);
	}
}

/** Forma única de toda respuesta de error: `{ error: { code, message, details? } }`. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
	// Los errores de SpreadBase tienen la misma forma: basta con reconocerlos.
	if (err instanceof HttpError || err instanceof SpreadBaseError) {
		res.status(err.status).json({
			error: { code: err.code, message: err.message, details: err.details }
		});
		return;
	}
	// JSON mal formado en el cuerpo: lo detecta `express.json()`.
	if (err?.type === 'entity.parse.failed') {
		res.status(400).json({ error: { code: 'invalid_json', message: 'El cuerpo no es JSON válido' } });
		return;
	}
	console.error(err);
	res.status(500).json({ error: { code: 'internal_error', message: 'Error interno' } });
};

export const notFoundHandler: RequestHandler = (req, res) => {
	res.status(404).json({
		error: { code: 'route_not_found', message: `No existe ${req.method} ${req.path}` }
	});
};
