/**
 * El staging de un destino como `ImportChangeSet` (§8.3 y §8.3.1): las filas que proponen los archivos
 * de la corrida, más los cambios que dejó el cerebro (emparejar una foto o una ficha con su fila),
 * comparados **por llave** contra la tabla actual.
 *
 * | Fila                              | replace          | upsert           |
 * |-----------------------------------|------------------|------------------|
 * | existe y viene con cambios        | update (celdas)  | update (celdas)  |
 * | existe y viene idéntica           | sin cambio       | sin cambio       |
 * | llave nueva                       | insert           | insert           |
 * | existe y no viene                 | delete           | sin cambio       |
 *
 * Es puro: sirve al cerebro (para ver y explicar el staging) y a las rutas de staging, que pueden usarlo
 * para unir las filas de los archivos (§8.3, «mientras tanto, el servidor convierte…»).
 */
import type { CellValue, ImportChange, ImportChangeSet, ImportIssue, ImportOrigin, ImportSchema } from '@spreadbase/core';

export interface StagingPropuesta {
	/** Id del archivo de la corrida. */
	archivo: string;
	filas: Record<string, CellValue>[];
	/** Los problemas del `review` de ese archivo (`row` = posición en `filas`). */
	issues?: ImportIssue[];
}

/** Un cambio del cerebro, por llave: lo que una foto, una ficha o la persona agregan a una fila. */
export type StagingExtra =
	| { op: 'update'; key: string; campos: Record<string, { despues: unknown; origen: ImportOrigin[] }> }
	| { op: 'insert'; key: string; valores: Record<string, unknown>; origen: ImportOrigin[] }
	| { op: 'delete'; key: string; motivo: string };

export interface StagingInput {
	destino: string;
	modo: 'upsert' | 'replace';
	schema: ImportSchema;
	/** La llave de una fila (la del formato o la identidad que diga la app). */
	llave: (fila: Record<string, unknown>) => string;
	/** La tabla destino hoy. `null`: la app no la expone (todo es insert; no hay delete). */
	actuales: Record<string, unknown>[] | null;
	propuestas: StagingPropuesta[];
	extra?: StagingExtra[];
	sinEmparejar?: { archivo: string; motivo: string }[];
	version?: unknown;
}

/** La llave por omisión de un formato: su `key`, o las columnas de texto obligatorias. */
export function llavePorOmision(schema: ImportSchema): (fila: Record<string, unknown>) => string {
	if (schema.key) return (fila) => texto(fila[schema.key!]);
	const campos = Object.entries(schema.columns)
		.filter(([, c]) => c.required && c.from !== 'form' && c.type !== 'number' && c.type !== 'boolean')
		.map(([f]) => f);
	return (fila) => campos.map((f) => texto(fila[f])).join(' | ');
}

const texto = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

/** Igualdad de celdas tolerante: vacío = null, números como números, textos sin espacios de más. */
export function mismoValor(a: unknown, b: unknown): boolean {
	const vacio = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && !v.trim());
	if (vacio(a) || vacio(b)) return vacio(a) && vacio(b);
	if (typeof a === 'number' || typeof b === 'number') {
		const na = Number(a);
		const nb = Number(b);
		if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 1e-9;
	}
	if (typeof a === 'boolean' || typeof b === 'boolean') return String(a).toLowerCase() === String(b).toLowerCase();
	if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
	return String(a).trim() === String(b).trim();
}

export function calcularStaging(input: StagingInput): ImportChangeSet {
	const campos = Object.entries(input.schema.columns)
		.filter(([, c]) => c.from !== 'form')
		.map(([f]) => f);
	const base = new Map<string, Record<string, unknown>>();
	for (const fila of input.actuales ?? []) base.set(input.llave(fila), fila);

	// Lo que proponen los archivos, por llave (el último archivo gana; se avisa).
	const propuesta = new Map<string, { valores: Record<string, unknown>; origen: ImportOrigin[] }>();
	const problemas: ImportChangeSet['problemas'] = [];
	for (const p of input.propuestas) {
		p.filas.forEach((fila, i) => {
			const key = input.llave(fila);
			const origen: ImportOrigin = { archivo: p.archivo, fila: i };
			const previa = propuesta.get(key);
			if (previa && !campos.every((f) => mismoValor(previa.valores[f], fila[f]))) {
				problemas.push({ key, nivel: 'aviso', mensaje: `La fila viene en dos archivos con valores distintos; se toma la del archivo ${p.archivo}` });
			}
			propuesta.set(key, { valores: { ...(previa?.valores ?? {}), ...fila }, origen: [...(previa?.origen ?? []), origen] });
		});
		for (const issue of p.issues ?? []) {
			if (issue.level === 'info') continue;
			const fila = issue.row === null ? null : p.filas[issue.row];
			problemas.push({
				key: fila ? input.llave(fila) : '',
				...(issue.field ? { campo: issue.field } : {}),
				nivel: issue.level === 'error' ? 'error' : 'aviso',
				mensaje: issue.message
			});
		}
	}

	const inserts = new Map<string, Extract<ImportChange, { op: 'insert' }>>();
	const updates = new Map<string, Extract<ImportChange, { op: 'update' }>>();
	const deletes = new Map<string, Extract<ImportChange, { op: 'delete' }>>();
	for (const [key, p] of propuesta) {
		const actual = base.get(key);
		if (!actual) {
			inserts.set(key, { op: 'insert', key, valores: Object.fromEntries(campos.map((f) => [f, p.valores[f] ?? null])), origen: p.origen });
			continue;
		}
		const cambiados = campos.filter((f) => f in p.valores && !mismoValor(actual[f], p.valores[f]));
		if (cambiados.length) {
			updates.set(key, {
				op: 'update',
				key,
				campos: Object.fromEntries(cambiados.map((f) => [f, { antes: actual[f] ?? null, despues: p.valores[f] ?? null, origen: p.origen }]))
			});
		}
	}
	if (input.modo === 'replace' && input.actuales && propuesta.size) {
		for (const key of base.keys()) if (!propuesta.has(key)) deletes.set(key, { op: 'delete', key, motivo: 'No viene en los archivos (reemplazar)' });
	}

	// Lo que agregó el cerebro (emparejar fotos y fichas, o lo que pidió la persona).
	for (const e of input.extra ?? []) {
		if (e.op === 'delete') {
			if (base.has(e.key)) deletes.set(e.key, e);
			inserts.delete(e.key);
			updates.delete(e.key);
			continue;
		}
		if (e.op === 'insert') {
			if (base.has(e.key) || inserts.has(e.key)) {
				problemas.push({ key: e.key, nivel: 'error', mensaje: 'Se pidió crear una fila que ya existe' });
				continue;
			}
			inserts.set(e.key, { op: 'insert', key: e.key, valores: e.valores, origen: e.origen });
			continue;
		}
		const nueva = inserts.get(e.key);
		if (nueva) {
			for (const [f, c] of Object.entries(e.campos)) nueva.valores[f] = c.despues;
			nueva.origen = [...nueva.origen, ...Object.values(e.campos).flatMap((c) => c.origen)];
			continue;
		}
		const actual = base.get(e.key);
		if (!actual) {
			problemas.push({ key: e.key, nivel: 'error', mensaje: 'No hay una fila con esa llave en la tabla ni en los archivos' });
			continue;
		}
		deletes.delete(e.key);
		const u = updates.get(e.key) ?? { op: 'update' as const, key: e.key, campos: {} };
		for (const [f, c] of Object.entries(e.campos)) {
			if (mismoValor(actual[f], c.despues)) continue;
			u.campos[f] = { antes: actual[f] ?? null, despues: c.despues, origen: c.origen };
		}
		if (Object.keys(u.campos).length) updates.set(e.key, u);
	}

	const cambios: ImportChange[] = [...updates.values(), ...inserts.values(), ...deletes.values()];
	const errores = new Set(problemas.filter((p) => p.nivel === 'error').map((p) => p.key)).size;
	return {
		destino: input.destino,
		modo: input.modo,
		base: { ...(input.version !== undefined ? { version: input.version } : {}), filas: input.actuales?.length ?? 0 },
		cambios,
		problemas,
		sinEmparejar: input.sinEmparejar ?? [],
		resumen: {
			insert: inserts.size,
			update: updates.size,
			delete: deletes.size,
			errores,
			avisos: problemas.filter((p) => p.nivel === 'aviso').length
		}
	};
}

/** Lo que se sabe de un staging además del `ImportChangeSet`: su tabla, quién lo alimenta y si ya se importó. */
export interface StagingDescripcion {
	/** El nombre de la tabla («Planes GMF»). */
	label: string;
	/** Los archivos que lo alimentan: «planes.pdf (264 filas)», «frente.png (columna imagen)». */
	archivos?: string[];
	/** Las etiquetas de las columnas (`precioFinal` → «Precio Final»). */
	columnas?: Record<string, { label?: string }>;
	/** Ya se guardó en la hoja (§10): cuándo y qué. */
	publicado?: { fecha: string; resumen: { insert: number; update: number; delete: number } } | null;
	/** Todos sus archivos ya se importaron (aunque no por la hoja, p. ej. con `apply`). */
	importado?: boolean;
	/** Cuántos problemas de ejemplo se nombran. Default: 3. */
	ejemplos?: number;
}

/**
 * Un staging en palabras, para el contexto del agente (§10): su tabla, modo, conteos, errores y avisos
 * con ejemplos, lo que no emparejó, qué archivos lo alimentan y si ya se importó.
 *
 * «Planes GMF» (planes, reemplazar; la tabla hoy tiene 3 filas): 2 nuevas, 1 cambiada, 1 se elimina; 0 errores, 1 aviso → lista para importar.
 */
export function describirStaging(set: ImportChangeSet, o: StagingDescripcion): string {
	const n = (k: number, uno: string, varios: string) => `${k} ${k === 1 ? uno : varios}`;
	const r = set.resumen;
	const modo = set.modo === 'replace' ? 'reemplazar' : 'actualizar o agregar';
	const estado = o.publicado
		? `ya importada (${o.publicado.fecha.slice(0, 16).replace('T', ' ')}: ${n(o.publicado.resumen.insert, 'nueva', 'nuevas')}, ${n(o.publicado.resumen.update, 'actualizada', 'actualizadas')}, ${n(o.publicado.resumen.delete, 'eliminada', 'eliminadas')})`
		: o.importado
			? 'ya importada'
			: r.errores
				? 'con errores: no se importa hasta corregirlos'
				: r.insert + r.update + r.delete
					? 'lista para importar'
					: 'sin cambios que importar';
	const lineas = [
		`«${o.label}» (${set.destino}, ${modo}; la tabla hoy tiene ${n(set.base.filas, 'fila', 'filas')}): ${n(r.insert, 'nueva', 'nuevas')}, ${n(r.update, 'cambiada', 'cambiadas')}, ${r.delete} ${r.delete === 1 ? 'se elimina' : 'se eliminan'}; ${n(r.errores, 'error', 'errores')}, ${n(r.avisos, 'aviso', 'avisos')} → ${estado}.`
	];
	const max = o.ejemplos ?? 3;
	const ejemplo = (nivel: 'error' | 'aviso') =>
		set.problemas
			.filter((p) => p.nivel === nivel)
			.slice(0, max)
			.map((p) => `${[p.key, p.campo ? (o.columnas?.[p.campo]?.label ?? p.campo) : null].filter(Boolean).join(' · ') || 'general'}: ${p.mensaje}`);
	const errores = ejemplo('error');
	const avisos = ejemplo('aviso');
	if (errores.length) lineas.push(`  Errores (ej.): ${errores.join(' | ')}`);
	if (avisos.length) lineas.push(`  Avisos (ej.): ${avisos.join(' | ')}`);
	if (set.sinEmparejar.length) lineas.push(`  Sin emparejar: ${set.sinEmparejar.map((s) => s.motivo).join(' | ')}`);
	if (o.archivos?.length) lineas.push(`  Lo alimentan: ${o.archivos.join(', ')}`);
	return lineas.join('\n');
}
