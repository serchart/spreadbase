/**
 * Cruzar dos extracciones del mismo archivo (SB-36), celda por celda: la
 * determinista (P) contra la del LLM (X). Donde coinciden, el dato es
 * confiable; donde no, se le muestra a la persona.
 *
 * Las tablas de una página se emparejan en orden; las columnas, por su
 * encabezado (sin acentos ni mayúsculas, como `locateTable`) y si no, por
 * posición; las filas, alineando las secuencias (una fila de más o de menos en
 * un lado no desfasa todas las siguientes).
 */
import { normalizeHeader } from '@spreadbase/core';
import type { BloqueExtraido, Extraccion } from './types.ts';

export interface Diferencia {
	pagina: number;
	/** La tabla dentro de la página: 0 = la primera. */
	bloque: number;
	/** Fila en P (0 = la primera de datos); si la fila solo está en X, su fila en X. */
	fila: number;
	/** Fila en X, cuando la hay. */
	filaX: number | null;
	/** El encabezado de la columna (el de P si lo hay), o `#n` sin encabezado. */
	columna: string;
	/** `null`: la fila o la columna no está en ese lado. */
	valorP: string | null;
	valorX: string | null;
}

export interface OpcionesComparacion {
	/** Cómo se comparan dos celdas. Default: sin espacios de más. */
	normalizar?: (valor: string) => string;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

export function compararExtracciones(p: Extraccion, x: Extraccion, opciones: OpcionesComparacion = {}): Diferencia[] {
	const norm = opciones.normalizar ?? collapse;
	const same = (a: string | undefined, b: string | undefined) => norm(a ?? '') === norm(b ?? '');
	const tables = (e: Extraccion, pagina: number) => e.bloques.filter((b) => b.pagina === pagina && b.tipo === 'tabla');
	const pages = [...new Set([...p.bloques, ...x.bloques].map((b) => b.pagina))].sort((a, b) => a - b);
	const out: Diferencia[] = [];

	for (const pagina of pages) {
		const tp = tables(p, pagina);
		const tx = tables(x, pagina);
		for (let bloque = 0; bloque < Math.max(tp.length, tx.length); bloque++) {
			out.push(...compareTables(tp[bloque], tx[bloque], pagina, bloque, same));
		}
	}
	return out;
}

/** Columnas de P y X que son la misma: por encabezado; las que quedan, por posición. */
function pairColumns(a: BloqueExtraido | undefined, b: BloqueExtraido | undefined): { name: string; ia: number | null; ib: number | null }[] {
	const width = (t?: BloqueExtraido) => Math.max(t?.encabezados?.length ?? 0, ...(t?.filas ?? []).map((r) => r.length), 0);
	const ha = a?.encabezados ?? [];
	const hb = b?.encabezados ?? [];
	const pairs: { name: string; ia: number | null; ib: number | null }[] = [];
	const usedB = new Set<number>();
	const byHeader = new Map<string, number>();
	hb.forEach((h, i) => {
		const key = normalizeHeader(h);
		if (key && !byHeader.has(key)) byHeader.set(key, i);
	});
	const pending: number[] = [];
	for (let ia = 0; ia < width(a); ia++) {
		const ib = byHeader.get(normalizeHeader(ha[ia]));
		if (ib !== undefined && !usedB.has(ib)) {
			usedB.add(ib);
			pairs.push({ name: ha[ia]!, ia, ib });
		} else pending.push(ia);
	}
	// Por posición, si en esa posición del otro lado queda una libre y las dos tienen encabezado (o ninguna).
	const titled = (h: string | undefined) => normalizeHeader(h) !== '';
	for (const ia of pending) {
		const ib = ia < width(b) && !usedB.has(ia) && titled(ha[ia]) === titled(hb[ia]) ? ia : null;
		if (ib !== null) usedB.add(ib);
		pairs.push({ name: ha[ia] || hb[ib ?? -1] || `#${ia + 1}`, ia, ib });
	}
	for (let ib = 0; ib < width(b); ib++) if (!usedB.has(ib)) pairs.push({ name: hb[ib] || `#${ib + 1}`, ia: null, ib });
	return pairs;
}

function compareTables(
	a: BloqueExtraido | undefined,
	b: BloqueExtraido | undefined,
	pagina: number,
	bloque: number,
	same: (a: string | undefined, b: string | undefined) => boolean
): Diferencia[] {
	const columns = pairColumns(a, b);
	const ra = a?.filas ?? [];
	const rb = b?.filas ?? [];
	const shared = columns.filter((c) => c.ia !== null && c.ib !== null);
	// Dos filas son la misma si coinciden en al menos la mitad de las columnas comunes.
	const match = (i: number, j: number) =>
		shared.length > 0 && shared.filter((c) => same(ra[i]![c.ia!], rb[j]![c.ib!])).length >= Math.ceil(shared.length / 2);

	// Alineación por la subsecuencia común más larga.
	const n = ra.length;
	const m = rb.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i]![j] = match(i, j) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
	}
	const pairs: [number | null, number | null][] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (match(i, j) && dp[i]![j] === dp[i + 1]![j + 1]! + 1) pairs.push([i++, j++]);
		else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) pairs.push([i++, null]);
		else pairs.push([null, j++]);
	}
	while (i < n) pairs.push([i++, null]);
	while (j < m) pairs.push([null, j++]);

	const out: Diferencia[] = [];
	for (const [fi, fj] of pairs) {
		for (const c of columns) {
			const vp = fi !== null && c.ia !== null ? (ra[fi]![c.ia] ?? '') : null;
			const vx = fj !== null && c.ib !== null ? (rb[fj]![c.ib] ?? '') : null;
			if (vp !== null && vx !== null ? same(vp, vx) : !(vp ?? vx ?? '').trim()) continue;
			out.push({ pagina, bloque, fila: (fi ?? fj)!, filaX: fj, columna: c.name, valorP: vp, valorX: vx });
		}
	}
	return out;
}
