/**
 * El staging de una corrida (S, `05-asistente-importacion.md` §8.1, §8.3 y §8.3.1): la tabla destino
 * con los cambios de **todos** los archivos de la corrida, comparados por llave contra las filas
 * actuales. Lo usan `GET /runs/:run/staging` y `PUT /runs/:run/staging`.
 *
 * - Si el cerebro (fase B) arma su propio staging, manda el suyo.
 * - Si no, se unen las filas propuestas de cada archivo con destino `filas` a ese formato
 *   (`calcularStaging` de `brain/staging.ts`, puro) y se suman los archivos que van a una
 *   **columna** de ese formato (`IMAGE`, `FILE`, `FOLDER` o texto, SB-38): la fila que empareja por
 *   nombre recibe el archivo como `update`; lo que no empareja va a `sinEmparejar`.
 * - `update` y `delete` llevan el `id` de la fila en la hoja destino, para aplicarlos en ella.
 * - Las ediciones de la persona (`PUT`) se guardan en la corrida y valen mientras los archivos no
 *   cambien (`firma`), y se le avisan al cerebro (`staging_editado`, agrupadas: §10).
 */
import { createHash } from 'node:crypto';
import { fold } from '@spreadbase/core';
import type { FileRef, ImportChange, ImportChangeSet, ImportRun, ImportRunFile, ImportStagingEdit } from '@spreadbase/core';
import { NotFoundError, ValidationError } from '../errors.ts';
import { SpreadBase } from '../SpreadBase.ts';
import type { ImportAgent } from './agent.ts';
import { calcularStaging, describirStaging, llavePorOmision } from './brain/staging.ts';
import type { StagingExtra } from './brain/staging.ts';
import type { ImportAgentDestination } from './types.ts';
import type { Extraccion } from '../extraction/types.ts';

type FilasDef = Extract<ImportAgentDestination, { tipo: 'filas' }>;
type AdjuntoDef = Extract<ImportAgentDestination, { tipo: 'adjuntar' }>;

const now = () => new Date().toISOString();

/** Texto comparable: sin acentos ni mayúsculas, solo letras y números separados por un espacio. */
const plano = (v: unknown) =>
	fold(String(v ?? ''))
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

function destinoDe(agent: ImportAgent, destino: string): FilasDef {
	const def = agent.destinos.find((d): d is FilasDef => d.tipo === 'filas' && d.formato.id === destino);
	if (!def) throw new NotFoundError(`No existe el destino «${destino}»`);
	return def;
}

/** La llave de una fila en el staging: los campos de `llave` del destino, o la del formato. */
function llaveDe(def: FilasDef): (fila: Record<string, unknown>) => string {
	if (!def.llave?.length) return llavePorOmision(def.formato.schema());
	const campos = def.llave;
	return (fila) => campos.map((f) => plano(fila[f])).join(' | ');
}

/** Los archivos de la corrida que van a una columna de este formato (SB-38). */
function adjuntosDe(agent: ImportAgent, run: ImportRun, destino: string): { archivo: ImportRunFile; def: AdjuntoDef & { columna: NonNullable<AdjuntoDef['columna']> } }[] {
	const defs = new Map(
		agent.destinos
			.filter((d): d is AdjuntoDef & { columna: NonNullable<AdjuntoDef['columna']> } => d.tipo === 'adjuntar' && d.columna?.formato === destino)
			.map((d) => [d.id, d])
	);
	return run.archivos.flatMap((archivo) => {
		const d = archivo.destino;
		const def = d?.tipo === 'adjuntar' ? defs.get(d.adjunto) : undefined;
		return def ? [{ archivo, def }] : [];
	});
}

export interface StagingCalculado {
	set: ImportChangeSet;
	/** Huella de lo que proponen los archivos: si cambia, las ediciones guardadas ya no valen. */
	firma: string;
}

/** El staging de un destino, calculado (o el del cerebro), con las ediciones de la persona si siguen valiendo. */
/** `ctx = null`: lectura interna (el cerebro), sin revisar el dueño de la corrida. */
export async function stagingDeCorrida(agent: ImportAgent, id: string, destino: string, ctx: Record<string, unknown> | null = {}, modoPedido?: 'upsert' | 'replace'): Promise<StagingCalculado> {
	const run = await agent.obtener(id, ctx);
	const def = destinoDe(agent, destino);
	const schema = def.formato.schema();
	const llave = llaveDe(def);
	const host = agent.host(id);
	const actuales = await host.filasActuales(destino);
	const sheet = def.actuales instanceof SpreadBase ? def.actuales : null;
	const idField = sheet?.idField ?? 'id';

	const archivos = run.archivos.filter((f) => f.destino?.tipo === 'filas' && f.destino.formato === destino && f.filas.length);
	const modos = archivos.map((f) => (f.destino as Extract<ImportRunFile['destino'], { tipo: 'filas' }>).modo);
	const modo = modoPedido ?? (modos.includes('replace') ? 'replace' : (modos[0] ?? def.modo ?? (def.modos ?? ['upsert'])[0]!));
	const propuestas = archivos.map((f) => ({ archivo: f.id, filas: f.filas.map((fila) => ({ ...f.campos, ...fila })), issues: f.issues }));

	// Los archivos que van a una columna: emparejar cada uno con su fila (determinista, por nombre).
	const adjuntos = adjuntosDe(agent, run, destino);
	const filasPorLlave = new Map<string, Record<string, unknown>>();
	for (const fila of actuales ?? []) filasPorLlave.set(llave(fila), fila);
	for (const p of propuestas) for (const fila of p.filas) filasPorLlave.set(llave(fila), { ...filasPorLlave.get(llave(fila)), ...fila });
	const tipos = sheet ? Object.fromEntries(Object.entries(sheet.definition.columns).map(([f, c]) => [f, c.type as string])) : {};
	const propios = await emparejar(adjuntos, filasPorLlave, def, tipos, (f) => host.extraerP(f));
	// Lo que suma el cerebro (fase B, §9.8): emparejamientos por contenido y `proponerCambios`. Lo que él
	// emparejó deja de estar «sin emparejar»; lo que él no pudo, se suma con su razón.
	const delCerebroExtra = await agent.cambiosDelCerebro(id, destino, ctx).catch(() => null);
	const extra = [...propios.extra, ...(delCerebroExtra?.extra ?? [])];
	const emparejadosPorCerebro = new Set(
		(delCerebroExtra?.extra ?? []).flatMap((e) => (e.op === 'update' ? Object.values(e.campos).flatMap((c) => c.origen.map((o) => o.archivo)) : e.op === 'insert' ? e.origen.map((o) => o.archivo) : []))
	);
	const sinEmparejar = [
		...propios.sinEmparejar.filter((x) => !emparejadosPorCerebro.has(x.archivo)),
		...(delCerebroExtra?.sinEmparejar ?? []).filter((x) => !propios.sinEmparejar.some((p) => p.archivo === x.archivo) || !emparejadosPorCerebro.has(x.archivo))
	].filter((x, i, all) => all.findIndex((y) => y.archivo === x.archivo) === i);

	const firma = createHash('sha1')
		.update(JSON.stringify([modo, propuestas.map((p) => [p.archivo, p.filas]), adjuntos.map((a) => [a.archivo.id, a.archivo.destino, a.archivo.derivados.length])]))
		.digest('hex');

	const delCerebro = await agent.stagingDelCerebro(id, destino, ctx).catch(() => null);
	const set: ImportChangeSet =
		delCerebro ??
		calcularStaging({ destino, modo, schema, llave, actuales, propuestas, extra, sinEmparejar });

	// El id de cada fila de la tabla, para aplicar `update` y `delete` en la hoja.
	const idDe = new Map<string, string>();
	for (const fila of actuales ?? []) if (fila[idField] !== null && fila[idField] !== undefined) idDe.set(llave(fila), String(fila[idField]));
	const conId = (c: ImportChange): ImportChange => (c.op === 'insert' || c.id || !idDe.has(c.key) ? c : { ...c, id: idDe.get(c.key)! });
	set.cambios = set.cambios.map(conId);

	// Lo que dejó la persona, mientras los archivos sigan diciendo lo mismo.
	const guardado = run.staging?.[destino];
	if (guardado?.cambios && guardado.firma === firma && !guardado.publicado) set.cambios = guardado.cambios.map(conId);
	set.resumen = {
		...set.resumen,
		insert: set.cambios.filter((c) => c.op === 'insert').length,
		update: set.cambios.filter((c) => c.op === 'update').length,
		delete: set.cambios.filter((c) => c.op === 'delete').length
	};
	return { set, firma };
}

/**
 * La persona editó el staging (se guardan sus cambios en la corrida) o no se pudo guardar la hoja
 * (el agente lo dice en el chat, con los motivos por fila y campo).
 */
export async function guardarStagingCorrida(agent: ImportAgent, id: string, edit: ImportStagingEdit, ctx: Record<string, unknown> = {}): Promise<ImportChangeSet> {
	const def = destinoDe(agent, edit.destino);
	const { firma, set: antes } = await stagingDeCorrida(agent, id, edit.destino, ctx);
	if (edit.cambios) {
		const cambios = edit.cambios;
		await agent.cambiarCorrida(id, (r) => {
			r.staging ??= {};
			const prev = r.staging[edit.destino];
			r.staging[edit.destino] = { cambios, firma, editado: now(), publicado: prev?.publicado ?? null };
		});
	}
	if (edit.error) {
		const label = def.formato.schema().label;
		const columnas = def.formato.schema().columns;
		const lineas = (edit.error.problemas ?? []).slice(0, 8).map((p) => `• ${[p.key, p.campo ? (columnas[p.campo]?.label ?? p.campo) : null].filter(Boolean).join(' · ')}: ${p.mensaje}`);
		const mas = (edit.error.problemas?.length ?? 0) > 8 ? [`• … y ${edit.error.problemas!.length - 8} más`] : [];
		const texto = [`No se pudo guardar ${label}: ${edit.error.mensaje}. Corrige las celdas marcadas y vuelve a importar.`, ...lineas, ...mas].join('\n');
		await agent.host(id).decir(texto);
		agent.avisarCerebro(id, { tipo: 'staging_editado', destino: edit.destino, resumen: `Al importar, la hoja de «${label}» no se pudo guardar; el sistema ya lo dijo en el chat:\n${texto}` });
	}
	if (edit.cambios) avisarEdicion(agent, id, edit.destino, antes.cambios);
	return (await stagingDeCorrida(agent, id, edit.destino, ctx)).set;
}

/** Ediciones del staging que esperan para avisarle al cerebro: por agente, corrida y destino. */
const enEspera = new WeakMap<ImportAgent, Map<string, { antes: ImportChange[]; timer: ReturnType<typeof setTimeout> }>>();

/**
 * Le avisa al cerebro que la persona editó el staging (`staging_editado`), con qué cambió. Las
 * ediciones seguidas (el cliente manda una cada 600 ms mientras se escribe) se agrupan en un solo
 * aviso tras `esperaEdicionMs` sin cambios: el cerebro no gasta un turno por tecla.
 */
function avisarEdicion(agent: ImportAgent, id: string, destino: string, antes: ImportChange[]): void {
	if (!agent.conCerebro) return;
	let porCorrida = enEspera.get(agent);
	if (!porCorrida) enEspera.set(agent, (porCorrida = new Map()));
	const key = `${id}\u241f${destino}`;
	const previo = porCorrida.get(key);
	if (previo) clearTimeout(previo.timer);
	const base = previo?.antes ?? antes;
	const timer = setTimeout(() => {
		porCorrida.delete(key);
		void (async () => {
			const def = destinoDe(agent, destino);
			const schema = def.formato.schema();
			const run = await agent.obtener(id, null);
			const { set } = await stagingDeCorrida(agent, id, destino, null);
			const cambio = describirEdicion(base, set.cambios, schema.columns);
			if (!cambio) return;
			const ahora = describirStaging(set, { label: schema.label, columnas: schema.columns, publicado: run.staging?.[destino]?.publicado ?? null, ejemplos: 2 });
			agent.avisarCerebro(id, { tipo: 'staging_editado', destino, resumen: `La persona editó el staging de «${schema.label}»: ${cambio}\nAhora: ${ahora}` });
		})().catch(() => undefined);
	}, agent.esperaEdicionMs);
	(timer as { unref?: () => void }).unref?.();
	porCorrida.set(key, { antes: base, timer });
}

/** Qué cambió entre dos versiones de los cambios de un staging, en palabras (máx. 8 cosas). */
export function describirEdicion(antes: ImportChange[], despues: ImportChange[], columnas: Record<string, { label?: string }> = {}): string {
	const corto = (v: unknown) => {
		if (v === null || v === undefined || v === '') return 'vacío';
		const t = typeof v === 'object' ? JSON.stringify(v) : String(v);
		return `«${t.length > 40 ? `${t.slice(0, 39)}…` : t}»`;
	};
	const col = (f: string) => columnas[f]?.label ?? f;
	const valores = (c: ImportChange | undefined): Record<string, unknown> =>
		!c ? {} : c.op === 'insert' ? c.valores : c.op === 'update' ? Object.fromEntries(Object.entries(c.campos).map(([f, x]) => [f, x.despues])) : {};
	const previos = new Map(antes.map((c) => [`${c.op}:${c.key}`, c]));
	const nuevos = new Map(despues.map((c) => [`${c.op}:${c.key}`, c]));
	const cosas: string[] = [];
	for (const [k, c] of nuevos) {
		const p = previos.get(k);
		if (c.op === 'delete') {
			if (!p) cosas.push(`marcó para eliminar ${c.key}`);
			continue;
		}
		const va = valores(p);
		const vd = valores(c);
		const campos = Object.keys(vd).filter((f) => JSON.stringify(va[f] ?? null) !== JSON.stringify(vd[f] ?? null));
		if (!p && c.op === 'insert') cosas.push(`agregó la fila ${c.key}`);
		else if (campos.length) cosas.push(`${c.key} · ${campos.slice(0, 4).map((f) => `${col(f)}: ${corto(va[f] ?? (c.op === 'update' ? c.campos[f]?.antes : null))} → ${corto(vd[f])}`).join(', ')}`);
	}
	for (const [k, p] of previos) {
		if (nuevos.has(k)) continue;
		cosas.push(p.op === 'insert' ? `quitó la fila nueva ${p.key}` : p.op === 'update' ? `deshizo los cambios de ${p.key}` : `ya no elimina ${p.key}`);
	}
	if (!cosas.length) return '';
	return `${cosas.slice(0, 8).join('; ')}${cosas.length > 8 ? `; y ${cosas.length - 8} cosas más` : ''}.`;
}

/** Lo que se le pide a `PUT /runs/:run/staging`, validado. */
export function parseStagingEdit(body: unknown): ImportStagingEdit {
	const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
	if (typeof b.destino !== 'string' || !b.destino) throw new ValidationError('Falta destino');
	if (b.cambios !== undefined && !Array.isArray(b.cambios)) throw new ValidationError('cambios debe ser una lista');
	const cambios = (b.cambios as unknown[] | undefined)?.map((c, i) => {
		const x = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
		if (x.op !== 'insert' && x.op !== 'update' && x.op !== 'delete') throw new ValidationError(`cambios[${i}].op debe ser insert, update o delete`);
		if (typeof x.key !== 'string') throw new ValidationError(`cambios[${i}].key debe ser texto`);
		return x as unknown as ImportChange;
	});
	const e = b.error as { mensaje?: unknown; problemas?: unknown } | undefined;
	const error = e && typeof e.mensaje === 'string' ? { mensaje: e.mensaje, ...(Array.isArray(e.problemas) ? { problemas: e.problemas as NonNullable<ImportStagingEdit['error']>['problemas'] } : {}) } : undefined;
	return { destino: b.destino, ...(cambios ? { cambios } : {}), ...(error ? { error } : {}) };
}

// -- emparejar archivos con filas (SB-38) ------------------------------------------------------

/**
 * Cada archivo que va a una columna se empareja con las filas cuyo valor en los campos de
 * `emparejar` (default: la llave del destino) aparece en su nombre o su carpeta, como palabras
 * completas («frente AVEO HB 2026 LS Manual.png» → modelo «AVEO HB 2026» y versión «LS Manual»).
 *
 * - Gana la unidad con más campos encontrados (los valores de menos de 3 letras, como el paquete
 *   «A», solo cuentan junto a uno largo). Todas las filas de esa unidad reciben el archivo (los
 *   planes de una versión comparten su foto).
 * - Dos unidades distintas con el mismo puntaje: ambiguo, a `sinEmparejar` con las candidatas.
 * - Valor según el tipo de la columna: `image` la URL; `file` `{ url, nombre, tipo, tamano }`;
 *   `folder` se agrega a la lista (sin repetir nombre); texto, el derivado del agente (ficha.md).
 */
async function emparejar(
	adjuntos: ReturnType<typeof adjuntosDe>,
	filas: Map<string, Record<string, unknown>>,
	def: FilasDef,
	tipos: Record<string, string>,
	extraer: (archivo: ImportRunFile) => Promise<Extraccion>
): Promise<{ extra: StagingExtra[]; sinEmparejar: { archivo: string; motivo: string }[] }> {
	const extra = new Map<string, Extract<StagingExtra, { op: 'update' }>>();
	const sinEmparejar: { archivo: string; motivo: string }[] = [];
	const schema = def.formato.schema();
	for (const { archivo, def: adj } of adjuntos) {
		const campo = adj.columna.campo;
		const campos = adj.columna.emparejar ?? def.llave ?? (schema.key ? [schema.key] : []);
		// El cerebro (o la persona) ya dijo a qué fila va: `destino.fila` trae su llave exacta.
		const fija = archivo.destino?.tipo === 'adjuntar' && typeof archivo.destino.fila === 'string' && archivo.destino.fila ? plano(archivo.destino.fila) : null;
		const nombre = ` ${plano(`${archivo.carpeta ?? ''} ${archivo.nombre.replace(/\.[^.]+$/, '')}`)} `;
		let mejor = 0;
		const unidades = new Map<string, { puntaje: number; llaves: string[]; etiqueta: string }>();
		if (fija) {
			const key = [...filas.keys()].find((k) => plano(k) === fija);
			if (key) unidades.set('fila', { puntaje: 1, llaves: [key], etiqueta: campos.map((f) => filas.get(key)![f]).filter((v) => v !== null && v !== undefined && v !== '').join(' · ') });
			else sinEmparejar.push({ archivo: archivo.id, motivo: `«${archivo.nombre}»: no hay una fila con la llave «${archivo.destino && 'fila' in archivo.destino ? archivo.destino.fila : ''}»` });
			if (!key) continue;
		}
		for (const [key, fila] of fija ? [] : filas) {
			const hallados = campos.filter((f) => {
				const v = plano(fila[f]);
				return v && nombre.includes(` ${v} `);
			});
			const largos = hallados.filter((f) => plano(fila[f]).length >= 3);
			const puntaje = largos.length ? hallados.length : 0;
			if (!puntaje || puntaje < mejor) continue;
			const unidad = hallados.map((f) => `${f}=${plano(fila[f])}`).join('&');
			if (puntaje > mejor) {
				mejor = puntaje;
				unidades.clear();
			}
			const u = unidades.get(unidad) ?? { puntaje, llaves: [], etiqueta: hallados.map((f) => String(fila[f])).join(' · ') };
			u.llaves.push(key);
			unidades.set(unidad, u);
		}
		const motivoTipo = tipos[campo] ?? (schema.columns[campo]?.type as string | undefined) ?? 'text';
		if (!unidades.size) {
			sinEmparejar.push({ archivo: archivo.id, motivo: `«${archivo.nombre}»: su nombre no coincide con ninguna fila (${campos.map((f) => schema.columns[f]?.label ?? f).join(', ')})` });
			continue;
		}
		if (unidades.size > 1) {
			const candidatas = [...unidades.values()].map((u) => u.etiqueta).slice(0, 4).join(' / ');
			sinEmparejar.push({ archivo: archivo.id, motivo: `«${archivo.nombre}» puede ser de varias filas (${candidatas}): renómbralo o elige la fila` });
			continue;
		}
		const ref: FileRef = { url: archivo.url, nombre: archivo.nombre, tipo: archivo.tipo, tamano: archivo.tamano };
		let valor: (fila: Record<string, unknown>) => unknown;
		if (motivoTipo === 'image') valor = () => archivo.url;
		else if (motivoTipo === 'file') valor = () => ref;
		else if (motivoTipo === 'folder') {
			valor = (fila) => {
				const lista = Array.isArray(fila[campo]) ? (fila[campo] as FileRef[]) : [];
				return [...lista.filter((f) => f?.nombre !== ref.nombre), ref];
			};
		} else {
			// La ficha que escribió el agente (ficha.md) o, si no, el documento completo en markdown (método P).
			const derivado = archivo.derivados.find((d) => /markdown|json|text/.test(d.tipo)) ?? archivo.derivados[0];
			const contenido = derivado?.contenido ?? (await extraer(archivo).then(aMarkdown).catch(() => ''));
			if (!contenido.trim()) {
				sinEmparejar.push({ archivo: archivo.id, motivo: `«${archivo.nombre}»: no hay texto que poner en «${campo}»` });
				continue;
			}
			valor = () => contenido;
		}
		const [unidad] = unidades.values();
		const origen = [{ archivo: archivo.id, nota: `emparejado por nombre: ${unidad!.etiqueta}` }];
		for (const key of unidad!.llaves) {
			const fila = filas.get(key)!;
			// Varias fotos o fichas para la misma carpeta: se acumulan sobre lo ya emparejado.
			const previo = extra.get(key);
			const base = previo?.campos[campo] ? { ...fila, [campo]: previo.campos[campo]!.despues } : fila;
			const e = previo ?? { op: 'update' as const, key, campos: {} };
			e.campos[campo] = { despues: valor(base), origen: [...(previo?.campos[campo]?.origen ?? []), ...origen] };
			extra.set(key, e);
			filas.set(key, { ...fila, [campo]: e.campos[campo]!.despues });
		}
	}
	return { extra: [...extra.values()], sinEmparejar };
}

/** Un documento extraído (método P) en markdown: títulos, texto y tablas, por página. */
export function aMarkdown(e: Extraccion): string {
	const celda = (v: string) => v.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
	return e.bloques
		.map((b) => {
			const titulo = b.titulo ? `## ${b.titulo.trim()}\n\n` : '';
			if (b.tipo === 'tabla' && b.encabezados?.length) {
				const head = `| ${b.encabezados.map(celda).join(' | ')} |\n| ${b.encabezados.map(() => '---').join(' | ')} |`;
				const body = (b.filas ?? []).map((f) => `| ${f.map((c) => celda(String(c ?? ''))).join(' | ')} |`).join('\n');
				return `${titulo}${head}${body ? `\n${body}` : ''}`;
			}
			return b.contenido ? `${titulo}${b.contenido.trim()}` : titulo.trim();
		})
		.filter(Boolean)
		.join('\n\n');
}
