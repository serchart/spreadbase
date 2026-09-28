/**
 * Propiedades del historial de deshacer/rehacer (docs/07-anexo-datagrid-engine.md §11.12).
 *
 * Controlador real con fuente local y datos en línea —una fuente de datos
 * legítima del grid, no un mock— y miles de operaciones aleatorias con
 * semilla fija. Sustituye a la prueba diferencial que se usó al reescribir el
 * historial y que no quedó en el repo.
 */
import { describe, expect, it } from 'vitest';
import { GridController } from './GridController.svelte';
import type { GridConfig } from './types';

const seedRows = Array.from({ length: 30 }, (_, i) => ({
	id: `r${i}`,
	name: i % 5 === 0 ? '' : `Nombre ${i}`,
	qty: i * 3,
	note: i % 3 ? `n${i}` : null
}));

const config = (): GridConfig => ({
	id: 'history-property',
	persist: 'none',
	dataSource: { load: async () => structuredClone(seedRows) },
	columns: [
		{ field: 'name', label: 'Nombre', type: 'text', required: true },
		{
			field: 'qty',
			label: 'Cantidad',
			type: 'number',
			min: 0,
			validate: (v, row) => (Number(v ?? 0) > 40 && row.note === 'x' ? 'qty > 40 con nota x' : null)
		},
		{ field: 'note', label: 'Nota', type: 'text', maxLength: 4 }
	]
});

function rng(seed: number) {
	return () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
}

type AnyController = GridController & Record<string, any>;

/**
 * Estado completo y serializable del controlador, para comparar con `toEqual`.
 * Las claves temporales son solo identidad y su contador es compartido entre
 * instancias; se anominan en orden de aparición, con «real:» si su id existe.
 */
function snapshot(c: AnyController) {
	const idField = 'id';
	const aliased = new Map<string, string>();
	const alias = (k: string) => aliased.get(k) ?? aliased.set(k, `tmp_${aliased.size}`).get(k)!;
	const rows = structuredClone(c.rows) as any[];
	for (const row of rows) row.__key = row[idField] != null ? `real:${row[idField]}` : alias(row.__key);
	const keyOf = (raw: string) => (raw.startsWith('tmp_') ? alias(raw) : `real:${raw}`);
	const splitKey = (raw: string) => {
		const at = raw.lastIndexOf('::');
		return [raw.slice(0, at), raw.slice(at + 2)] as const;
	};
	const base = [...(c['baseline'] as Map<string, any>).entries()].map(([k, v]) => [keyOf(k), { ...v, __key: keyOf(k) }]).sort();
	return {
		rows,
		baseline: base,
		dirty: [...(c['dirtyCells'] as Set<string>)].map((s) => `${keyOf(splitKey(s)[0])}::${splitKey(s)[1]}`).sort(),
		created: [...(c['createdKeys'] as Set<string>)].map(keyOf).sort(),
		deleted: structuredClone(c['deletedRows'] as any[]).map((d: any) => ({ ...d, key: keyOf(d.key), row: { ...d.row, __key: keyOf(d.key) } })),
		errors: [...(c['errors'] as Map<string, string>).entries()]
			.map(([k, v]) => [`${keyOf(splitKey(k)[0])}::${splitKey(k)[1]}`, v])
			.sort(),
		summary: { ...c.rowSummary },
		changeSet: normalizeChangeSet(c)
	};
}

function normalizeChangeSet(c: AnyController) {
	const cs = c.buildChangeSet();
	const strip = (o: any) => {
		const { __key: _k, key: _key, ...rest } = o;
		return rest;
	};
	cs.updates.sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
	cs.deletes.sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
	return {
		creates: cs.creates.map(strip),
		updates: cs.updates.map(strip),
		deletes: cs.deletes.map(strip)
	};
}

describe('historial: propiedades', () => {
	it('operaciones aleatorias: deshacer todo = estado inicial; rehacer todo = estado final', async () => {
		for (let seed = 1; seed <= 12; seed++) {
			const realNow = Date.now;
			Date.now = () => seed; // claves tmp_ deterministas por semilla
			try {
				const c = new GridController(config()) as AnyController;
				await c.load();
				c.validateAll();
				const initial = snapshot(c);

				/*
					El historial guarda solo las últimas 50 acciones, así que «deshacer
					todo» no vuelve al inicio. La propiedad comprobable es más fuerte:
					deshacer una acción deja el estado **idéntico al de un controlador que
					repitió todas las acciones menos esa**. Se mantiene la lista de
					referencia y se reconstruye por replay.
				*/
				const applied: ((c2: AnyController) => void)[] = [];
				const undoneStack: ((c2: AnyController) => void)[] = [];
				const r = rng(seed);
				const fields = ['name', 'qty', 'note'];
				const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
				const replay = async (steps: ((c2: AnyController) => void)[]) => {
					const c2 = new GridController(config()) as AnyController;
					await c2.load();
					c2.validateAll();
					for (const step of steps) step(c2);
					return snapshot(c2);
				};
				const trail: string[] = [];
				const sameData = (a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>, where = '') => {
					try {
						expect(a).toEqual(b);
					} catch (e) {
						console.log('[historial] diverge en', where, JSON.stringify(a.errors.filter(([k]) => k.startsWith('tmp_')).length), trail.slice(-18));
						throw e;
					}
				};

				for (let i = 0; i < 400; i++) {
					const n = c.rows.length;
					const roll = r();
					let action: ((c2: AnyController) => void) | null = null;
					let describe = '';
					if (roll < 0.4 && n > 0) {
						const [y, f, v] = [Math.floor(r() * n), pick(fields), r() < 0.2 ? null : `v${Math.floor(r() * 9)}`];
						describe = `set ${c.rows[y]?.__key}.${f}=${JSON.stringify(v)}`;
						action = (c2) => c2.setCellValue(y, f, v);
					} else if (roll < 0.52 && n > 0) {
						const edits = Array.from({ length: 1 + Math.floor(r() * 6) }, () => {
							const f = pick(fields);
							return { x: Math.floor(r() * n), f, v: f === 'qty' ? Math.floor(r() * 50) : `v${Math.floor(r() * 9)}` };
						});
						describe = `tx-set ${JSON.stringify(edits.map((e) => [c.rows[e.x]?.__key, e.f, e.v]))}`;
						action = (c2) => c2.transaction(() => edits.forEach((e) => c2.setCellValue(e.x, e.f, e.v)));
					} else if (roll < 0.58) {
						const [at, k] = [Math.floor(r() * (n + 3)), 1 + Math.floor(r() * 3)];
						describe = `insert @${at} x${k}`;
						action = (c2) => c2.insertRows(at, k);
					} else if (roll < 0.64 && n > 0) {
						const idx = Array.from({ length: 1 + Math.floor(r() * 3) }, () => Math.floor(r() * n));
						describe = `remove ${JSON.stringify(idx)}→${JSON.stringify(idx.map((i) => c.rows[i]?.__key))}`;
						action = (c2) => c2.removeRowsAt(idx);
					} else if (roll < 0.68 && n > 0) {
						const [at, y] = [Math.floor(r() * (n + 1)), Math.floor(r() * n)];
						describe = `tx-mixed y=${c.rows[y]?.__key} at=${at}`;
						action = (c2) =>
							c2.transaction(() => {
								c2.setCellValue(y, 'name', 'en tx');
								c2.insertRows(at, 1);
								c2.setCellValue(Math.min(at, c2.rows.length - 1), 'note', 'x');
								c2.removeRowsAt([Math.min(y, c2.rows.length - 1)]);
							});
					} else if (roll < 0.7) {
						// Una transacción vacía no crea entrada de historial: no se rastrea.
						c.transaction(() => {});
					} else if (roll < 0.86) {
						// Deshacer: el estado debe ser el del replay sin la acción deshecha.
						if (c.undo() && applied.length > 0) {
							undoneStack.push(applied.pop()!);
							const expected = await replay(applied);
							sameData(snapshot(c), expected);
						}
					} else {
						if (c.redo() && undoneStack.length > 0) applied.push(undoneStack.pop()!);
					}
					if (action) {
						action(c);
						applied.push(action);
						undoneStack.length = 0;
						trail.push(`${i}: ${describe}`);
					}

					// Propiedad por paso: «sucia» es siempre «valor ≠ original».
					for (const cell of [...(c['dirtyCells'] as Set<string>)]) {
						const at = cell.lastIndexOf('::');
						const row = c.getRow(cell.slice(0, at))!;
						const field = cell.slice(at + 2);
						const base = (c['baseline'] as Map<string, Record<string, unknown>>).get(row.__key);
						expect(
							String(row[field]),
							`semilla ${seed} paso ${i}: ${cell} marcada sucia sin diferir`
						).not.toBe(String(base?.[field] ?? null));
					}
				}

				// Rehacer hasta el final devuelve el estado final exacto (con historial completo).
				// El estado del final del loop puede venir tras undos (con rehacer pendiente).
				const afterLoop = await replay(applied);
				sameData(snapshot(c), afterLoop, `semilla ${seed} al final del loop`);
				while (c.undo()) {
					if (applied.length > 0) undoneStack.push(applied.pop()!);
				}
				const undone = await replay(applied);
				sameData(snapshot(c), undone);
				while (c.redo()) {
					if (undoneStack.length > 0) applied.push(undoneStack.pop()!);
				}
				const redoneAll = await replay(applied);
				sameData(snapshot(c), redoneAll);
				expect(c.canRedo).toBe(false);
				expect(initial.rows).toHaveLength(30);
			} finally {
				Date.now = realNow;
			}
		}
	}, 300_000);
});
