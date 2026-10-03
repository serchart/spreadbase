import express, { Router } from 'express';
import type { Request } from 'express';
import { fold, isBlank, toSchema, validateValue } from '@spreadbase/core';
import type {
	CellValue,
	ImportColumnSpec,
	ImportIssue,
	ImportPayload,
	ImportResult,
	ImportSchema,
	ImportSchemaColumn,
	LookupQuery,
	LookupResult,
	LookupSpec,
	ResolveResult
} from '@spreadbase/core';
import { NotFoundError, SpreadBaseError, ValidationError } from './errors.ts';
import { parseLookupQuery, parseResolve } from './http.ts';

type MaybePromise<T> = T | Promise<T>;
export type ImportRow = Record<string, CellValue>;

/** Lo que reciben `review` y `apply`: los datos del formulario y el contexto de la petición. */
export interface ImportContext {
	fields: Record<string, CellValue>;
	fileName: string | null;
	/** Una persona pidió aplicar pese a lo que `review` frenó (y se podía forzar). */
	force: boolean;
	context: Record<string, unknown>;
}

/** Lo que devuelven `review` y `apply` de la app: todo opcional. */
export interface ImportOutcome {
	summary?: Record<string, unknown>;
	issues?: ImportIssue[];
	blocked?: ImportResult['blocked'];
	/** Solo `apply`: `false` si no se aplicó (lo frenó algo). Default: `true`. */
	applied?: boolean;
}

export interface ImportFormatDefinition {
	id: string;
	label: string;
	description?: string;
	key?: string;
	columns: Record<string, ImportColumnSpec>;
	header?: ImportSchema['header'];
	footer?: ImportSchema['footer'];
	/** Qué haría, sin escribir nada. Recibe filas ya válidas. */
	review?: (rows: ImportRow[], ctx: ImportContext) => MaybePromise<ImportOutcome>;
	/** Hacerlo. Recibe filas ya válidas; la transacción es de la app. */
	apply: (rows: ImportRow[], ctx: ImportContext) => MaybePromise<ImportOutcome>;
}

const cents = (n: number) => Math.round(n * 100);

/**
 * Un formato de importación (SB-34): columnas como las de una hoja, sin tabla
 * detrás. Antes de entregar las filas a la app, valida lo que valida una hoja
 * —tipo, obligatorio, patrón, catálogo, que el registro de un `lookup` exista—,
 * la llave sin repetir y la suma de control del archivo. Los datos `either` sin
 * valor en la fila toman el del formulario.
 */
export class ImportFormat {
	constructor(private readonly def: ImportFormatDefinition) {
		for (const [field, spec] of Object.entries(def.columns)) {
			if (spec.type === 'lookup') {
				const l = spec.lookup;
				if (!l?.value || !l.display || typeof l.search !== 'function' || typeof l.byIds !== 'function') {
					throw new Error(`Importación ${def.id}: la columna "${field}" (lookup) necesita lookup.value, lookup.display, lookup.search y lookup.byIds`);
				}
			}
			if (spec.type === 'password' || spec.upload) throw new Error(`Importación ${def.id}: la columna "${field}" no se puede importar`);
		}
		if (def.key && !(def.key in def.columns)) throw new Error(`Importación ${def.id}: la llave "${def.key}" no es una columna`);
	}

	get id(): string {
		return this.def.id;
	}

	get label(): string {
		return this.def.label;
	}

	schema(): ImportSchema {
		const base = toSchema({ id: this.def.id, columns: this.def.columns });
		const columns: Record<string, ImportSchemaColumn> = {};
		for (const [field, spec] of Object.entries(this.def.columns)) {
			const { aliases, from } = spec;
			// `toSchema` hace de «id» la columna `id`: aquí no hay id, se respeta lo declarado.
			const column = { ...base.columns[field]!, readOnly: spec.readOnly } as ImportSchemaColumn;
			delete (column as { aliases?: unknown }).aliases;
			columns[field] = { ...column, from: from ?? 'file', ...(aliases?.length ? { aliases } : {}) };
		}
		return {
			id: this.def.id,
			label: this.def.label,
			...(this.def.description ? { description: this.def.description } : {}),
			...(this.def.key ? { key: this.def.key } : {}),
			columns,
			...(this.def.header ? { header: this.def.header } : {}),
			...(this.def.footer ? { footer: this.def.footer } : {})
		};
	}

	// -- lookups de la vista previa (SB-21) ------------------------------------------------

	private lookupOf(field: string): LookupSpec {
		const spec = this.def.columns[field];
		if (!spec || spec.type !== 'lookup' || !spec.lookup) throw new NotFoundError(`"${field}" no es una columna lookup`);
		return spec.lookup;
	}

	async lookup(field: string, query: LookupQuery, context: Record<string, unknown> = {}): Promise<LookupResult> {
		const { rows, total } = await this.lookupOf(field).search(query.q, { offset: query.offset, limit: query.limit }, context);
		return { rows, total: Number(total), offset: query.offset, limit: query.limit };
	}

	/** Texto pegado → registros: por `value` exacto, o por `display` (y `resolveBy`) sin acentos ni mayúsculas. */
	async resolve(field: string, texts: string[], context: Record<string, unknown> = {}): Promise<ResolveResult> {
		const lookup = this.lookupOf(field);
		if (!lookup.resolve) throw new SpreadBaseError(400, 'lookup_not_resolvable', `La columna "${field}" no resuelve texto pegado`);
		const wanted = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
		const matches: ResolveResult['matches'] = Object.fromEntries(wanted.map((t) => [t, []]));
		if (!wanted.length) return { matches };
		const candidates = await lookup.resolve(wanted, context);
		for (const text of wanted) {
			const byValue = candidates.filter((row) => String(row[lookup.value]) === text);
			const fields = [lookup.display, ...(lookup.resolveBy ?? [])];
			matches[text] = byValue.length ? byValue : candidates.filter((row) => fields.some((f) => fold(String(row[f] ?? '')) === fold(text)));
		}
		return { matches };
	}

	// -- validar, revisar, aplicar ----------------------------------------------------------

	/** Las filas listas para la app (con los `either` completados) y lo que está mal. */
	async check(payload: ImportPayload, context: Record<string, unknown> = {}): Promise<{ rows: ImportRow[]; issues: ImportIssue[] }> {
		const issues: ImportIssue[] = [];
		const columns = Object.entries(this.def.columns);
		const fields: Record<string, CellValue> = {};
		// El formulario: los `form`, y los `either` que vinieron ahí.
		for (const [field, spec] of columns) {
			if (spec.from === 'file' || spec.from === undefined) continue;
			const value = payload.fields[field] ?? null;
			fields[field] = value;
			const provided = spec.from === 'either' && payload.rows.some((r) => !isBlank(r[field]));
			if (spec.from === 'form' || (!provided && !isBlank(value))) {
				const message = validateValue({ ...spec, required: spec.required && (spec.from === 'form' || !provided) }, isBlank(value) ? null : value);
				if (message) issues.push({ row: null, field, level: 'error', message: `${spec.label}: ${message}` });
			} else if (spec.from === 'either' && !provided && spec.required) {
				issues.push({ row: null, field, level: 'error', message: `${spec.label}: falta (ni en el archivo ni en el formulario)` });
			}
		}
		if (payload.rows.length === 0) issues.push({ row: null, level: 'error', message: 'No hay filas que importar' });

		const rows: ImportRow[] = payload.rows.map((raw, i) => {
			const row: ImportRow = {};
			for (const [field, spec] of columns) {
				if (spec.from === 'form') continue;
				let value = raw[field] ?? null;
				if (typeof value === 'string' && value.trim() === '') value = null;
				if (value === null && spec.from === 'either') value = fields[field] ?? null;
				row[field] = value;
				// Un `either` que falta en todas las filas y en el formulario ya se reportó una vez.
				if (value === null && spec.from === 'either' && !payload.rows.some((r) => !isBlank(r[field]))) continue;
				const message = validateValue(spec, value) ?? (value !== null ? (spec.validate?.(value, raw) ?? null) : null);
				if (message) issues.push({ row: i, field, level: 'error', message });
			}
			return row;
		});

		// Que los registros de cada lookup existan.
		for (const [field, spec] of columns) {
			if (spec.type !== 'lookup' || !spec.lookup) continue;
			const values = spec.from === 'form' ? [fields[field]] : rows.map((r) => r[field]);
			const ids = [...new Set(values.filter((v) => !isBlank(v)).map(String))];
			if (!ids.length) continue;
			const found = new Set((await spec.lookup.byIds(ids, context)).map((r) => String(r[spec.lookup!.value])));
			if (spec.from === 'form') {
				if (!isBlank(fields[field]) && !found.has(String(fields[field]))) issues.push({ row: null, field, level: 'error', message: `${spec.label}: no existe` });
				continue;
			}
			rows.forEach((r, i) => {
				if (!isBlank(r[field]) && !found.has(String(r[field]))) issues.push({ row: i, field, level: 'error', message: 'No corresponde a ningún registro' });
			});
		}

		// La llave no se repite en el archivo.
		const key = this.def.key;
		if (key) {
			const seen = new Map<string, number>();
			rows.forEach((r, i) => {
				if (isBlank(r[key])) return;
				const k = fold(String(r[key]));
				if (seen.has(k)) issues.push({ row: i, field: key, level: 'error', message: `Repetido: igual que la fila ${seen.get(k)! + 1}` });
				else seen.set(k, i);
			});
		}

		// La suma de control del pie: lo que viaja suma lo que decía el archivo.
		for (const field of this.def.footer?.checksum ?? []) {
			const expected = payload.checksum?.[field];
			if (expected === undefined || expected === null) continue;
			const actual = rows.reduce((a, r) => a + (typeof r[field] === 'number' ? cents(r[field] as number) : 0), 0);
			if (actual !== cents(expected)) {
				const label = this.def.columns[field]?.label ?? field;
				issues.push({ row: null, field, level: 'error', message: `La suma de «${label}» (${(actual / 100).toFixed(2)}) no cuadra con el total del archivo (${expected.toFixed(2)})` });
			}
		}
		return { rows, issues };
	}

	async review(payload: ImportPayload, context: Record<string, unknown> = {}): Promise<ImportResult> {
		const { rows, issues } = await this.check(payload, context);
		if (issues.some((i) => i.level === 'error')) return { ok: false, applied: false, summary: { rows: rows.length }, issues };
		const outcome = (await this.def.review?.(rows, this.ctx(payload, context))) ?? {};
		const all = [...issues, ...(outcome.issues ?? [])];
		return {
			ok: !all.some((i) => i.level === 'error') && !outcome.blocked,
			applied: false,
			summary: { rows: rows.length, ...outcome.summary },
			issues: all,
			blocked: outcome.blocked ?? null
		};
	}

	/** Vuelve a validar (lo que llega puede no ser lo revisado) y aplica. */
	async apply(payload: ImportPayload, context: Record<string, unknown> = {}): Promise<ImportResult> {
		const { rows, issues } = await this.check(payload, context);
		if (issues.some((i) => i.level === 'error')) return { ok: false, applied: false, summary: { rows: rows.length }, issues };
		const outcome = await this.def.apply(rows, this.ctx(payload, context));
		const all = [...issues, ...(outcome.issues ?? [])];
		const applied = outcome.applied ?? true;
		return {
			ok: applied && !all.some((i) => i.level === 'error'),
			applied,
			summary: { rows: rows.length, ...outcome.summary },
			issues: all,
			blocked: outcome.blocked ?? null
		};
	}

	private ctx(payload: ImportPayload, context: Record<string, unknown>): ImportContext {
		const fields: Record<string, CellValue> = {};
		for (const [field, spec] of Object.entries(this.def.columns)) if (spec.from === 'form' || spec.from === 'either') fields[field] = payload.fields[field] ?? null;
		return { fields, fileName: payload.fileName ?? null, force: payload.force === true, context };
	}
}

export const importFormat = (def: ImportFormatDefinition) => new ImportFormat(def);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCell = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** `{ rows, fields, fileName?, checksum?, force? }` de `review` y `apply`: la forma; los valores los valida el formato. */
export function parseImportPayload(body: unknown): ImportPayload {
	if (!isRecord(body)) throw new ValidationError('El cuerpo debe ser un objeto');
	const { rows = [], fields = {}, fileName = null, checksum = null, force = false } = body;
	if (!Array.isArray(rows) || !rows.every((r) => isRecord(r) && Object.values(r).every(isCell))) {
		throw new ValidationError('rows debe ser una lista de objetos con valores simples');
	}
	if (!isRecord(fields) || !Object.values(fields).every(isCell)) throw new ValidationError('fields debe ser un objeto con valores simples');
	if (fileName !== null && typeof fileName !== 'string') throw new ValidationError('fileName debe ser texto');
	if (checksum !== null && (!isRecord(checksum) || !Object.values(checksum).every((v) => typeof v === 'number'))) {
		throw new ValidationError('checksum debe ser un objeto de números');
	}
	return {
		rows: rows as ImportPayload['rows'],
		fields: fields as ImportPayload['fields'],
		fileName: fileName as string | null,
		checksum: checksum as Record<string, number> | null,
		force: force === true
	};
}

export interface ImportRoutesOptions {
	/** El contexto de la petición (el usuario): lo reciben `review`, `apply` y los lookups. */
	context?: (req: Request) => Record<string, unknown>;
	/** Tope del cuerpo de `review` y `apply`. Default: `20mb`. */
	limit?: string;
}

/**
 * Las rutas de los formatos de importación, ya conectadas:
 *
 *   GET  /                                la lista (id, label, description)
 *   GET  /:format/schema                  columnas, campos, llave, encabezado y pie
 *   GET  /:format/lookup/:field           el popover de una columna lookup
 *   POST /:format/lookup/:field/resolve   texto pegado → registros
 *   POST /:format/review                  { rows, fields, … } → qué haría
 *   POST /:format/apply                   { rows, fields, … } → hacerlo
 *
 * Móntalas antes de un `express.json()` global con límite chico, o súbelo: un
 * archivo de miles de filas pasa de los 100 kB por defecto.
 */
export function importRoutes(formats: ImportFormat[], options: ImportRoutesOptions = {}): Router {
	const router = Router();
	const byId = new Map(formats.map((f) => [f.id, f]));
	const context = (req: Request) => options.context?.(req) ?? {};
	const format = (req: Request) => {
		const f = byId.get(String(req.params.format));
		if (!f) throw new NotFoundError(`No existe el formato «${String(req.params.format)}»`);
		return f;
	};
	const json = express.json({ limit: options.limit ?? '20mb' });
	router.get('/', (_req, res) => {
		res.json(formats.map((f) => {
			const { id, label, description } = f.schema();
			return { id, label, description: description ?? null };
		}));
	});
	router.get('/:format/schema', (req, res) => {
		res.json(format(req).schema());
	});
	router.get('/:format/lookup/:field', async (req, res) => {
		res.json(await format(req).lookup(String(req.params.field), parseLookupQuery(req.query), context(req)));
	});
	router.post('/:format/lookup/:field/resolve', json, async (req, res) => {
		res.json(await format(req).resolve(String(req.params.field), parseResolve(req.body), context(req)));
	});
	router.post('/:format/review', json, async (req, res) => {
		res.json(await format(req).review(parseImportPayload(req.body), context(req)));
	});
	router.post('/:format/apply', json, async (req, res) => {
		res.json(await format(req).apply(parseImportPayload(req.body), context(req)));
	});
	return router;
}
