/**
 * Autenticación de mentira para el ejemplo: el usuario sale de la cabecera
 * `x-user` (o «demo»). En una app real, aquí va la de verdad; lo que importa es
 * que `req.user` llega a los handlers de la hoja por el contexto.
 */
export function demoAuth(req, _res, next) {
	req.user = { id: req.get('x-user') || 'demo' };
	next();
}
