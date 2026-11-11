/**
 * Reconstruir tablas a partir de texto con coordenadas (método P, SB-36). Es
 * geometría pura —no sabe de PDF—: recibe los trozos de texto de una página
 * con su caja y devuelve bloques de tabla y de texto. Así se prueba con
 * coordenadas inventadas, sin archivos.
 *
 * Cómo lo hace:
 *
 * 0. **Encimados**: dos trozos distintos en el mismo lugar no se ven los dos;
 *    se queda el que dice `preferir` (o el más ancho).
 * 1. **Líneas**: trozos a la misma altura (misma línea base).
 * 2. **Filas**: líneas tan juntas que se enciman (menos de 0.8 de la altura
 *    de la letra) son una sola fila: así una celda de dos renglones
 *    («Factor de Arrendamiento:» / «16.09%») o un encabezado partido
 *    («Código» / «GMM») quedan en su fila.
 * 3. **Filas de tabla**: las que tienen al menos tres grupos de texto
 *    separados por espacio en blanco. Las seguidas forman una tabla; un hueco
 *    grande entre ellas empieza otra.
 * 4. **Columnas**: los intervalos de x que ocupa el texto de las filas de
 *    datos, unidos; donde ninguna fila tiene texto, hay un corte de columna.
 *    Un encabezado que no cae sobre ningún dato es de la columna vecina sin
 *    encabezado («AMDA» centrado sobre «55» alineado a la derecha) o abre la
 *    suya («Otros», vacía).
 * 5. **Encabezado**: la primera fila de la tabla si ninguna celda es un número.
 * 6. **Celdas combinadas**: una columna casi vacía («Modelo», con «AVEO HB
 *    2026» centrado sobre muchas filas; «Otros», con una nota que abarca
 *    tres) se reparte. Con `lineaHorizontal` (la página dibujada), cada celda
 *    abarca las filas entre dos líneas de la tabla; sin ella, solo en las
 *    columnas del principio, cada fila toma el valor de centro más cercano.
 *
 * Lo que queda fuera de las tablas sale como bloques de texto.
 */
import type { BloqueExtraido } from './types.ts';

/** Un trozo de texto con su caja: `y` es la línea base, creciendo hacia arriba (como en PDF). */
export interface TextoPosicionado {
	texto: string;
	x0: number;
	x1: number;
	y: number;
	/** Altura de la letra. */
	h: number;
}

/** Lo que la página dibujada sabe y la capa de texto no. */
export interface OpcionesDisposicion {
	/**
	 * ¿Hay una línea horizontal que cruce de `x0` a `x1` entre `yArriba` y
	 * `yAbajo` (coordenadas del PDF)? Con ella, una celda combinada abarca
	 * exactamente las filas entre dos líneas; sin ella, se reparte por cercanía.
	 */
	lineaHorizontal?: (x0: number, x1: number, yArriba: number, yAbajo: number) => boolean;
	/** De dos trozos encimados en la misma línea, el que se ve. */
	preferir?: (a: TextoPosicionado, b: TextoPosicionado) => TextoPosicionado;
}

interface Linea {
	y: number;
	h: number;
	items: TextoPosicionado[];
}

interface Fila {
	/** Centro vertical: el promedio de las líneas base. */
	y: number;
	top: number;
	bottom: number;
	h: number;
	items: TextoPosicionado[];
}

interface Intervalo {
	x0: number;
	x1: number;
}

const median = (values: number[]) => {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
};

/** Espacio mínimo entre dos grupos de texto para que sean columnas distintas. */
const gapFor = (h: number) => Math.max(2, 0.6 * h);

/** Una celda que es un número, un importe o un porcentaje (no un encabezado). */
const NUMERIC = /^[\s$€(),.%+\-\d]+$/;

function lines(items: TextoPosicionado[]): Linea[] {
	const sorted = [...items].sort((a, b) => b.y - a.y || a.x0 - b.x0);
	const out: Linea[] = [];
	for (const item of sorted) {
		const last = out.at(-1);
		if (last && Math.abs(last.y - item.y) <= Math.max(1, 0.25 * Math.max(last.h, item.h))) {
			last.items.push(item);
			last.h = Math.max(last.h, item.h);
		} else out.push({ y: item.y, h: item.h, items: [item] });
	}
	for (const line of out) line.items.sort((a, b) => a.x0 - b.x0);
	return out;
}

function rows(ls: Linea[]): Fila[] {
	const out: (Fila & { lines: Linea[] })[] = [];
	for (const line of ls) {
		const last = out.at(-1);
		const prev = last?.lines.at(-1);
		if (last && prev && prev.y - line.y < 0.8 * Math.max(prev.h, line.h)) {
			last.lines.push(line);
			last.items.push(...line.items);
			last.bottom = line.y;
			last.h = Math.max(last.h, line.h);
		} else out.push({ y: line.y, top: line.y + line.h, bottom: line.y, h: line.h, items: [...line.items], lines: [line] });
	}
	for (const row of out) row.y = row.lines.reduce((s, l) => s + l.y, 0) / row.lines.length;
	return out;
}

/** Une intervalos que se tocan o quedan a menos de `gap`. */
function merge(intervals: Intervalo[], gap: number): Intervalo[] {
	const sorted = [...intervals].sort((a, b) => a.x0 - b.x0);
	const out: Intervalo[] = [];
	for (const it of sorted) {
		const last = out.at(-1);
		if (last && it.x0 - last.x1 < gap) last.x1 = Math.max(last.x1, it.x1);
		else out.push({ ...it });
	}
	return out;
}

const overlap = (a: Intervalo, b: Intervalo) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));

/** La columna de un trozo: la que más se le encima; si ninguna, la más cercana (y se cuenta como dudosa). */
function columnOf(item: TextoPosicionado, columns: Intervalo[]): { index: number; sure: boolean } {
	let best = -1;
	let bestOverlap = 0;
	columns.forEach((c, i) => {
		const o = overlap(item, c);
		if (o > bestOverlap) {
			bestOverlap = o;
			best = i;
		}
	});
	if (best >= 0) return { index: best, sure: true };
	const center = (item.x0 + item.x1) / 2;
	let nearest = 0;
	let distance = Infinity;
	columns.forEach((c, i) => {
		const d = center < c.x0 ? c.x0 - center : center > c.x1 ? center - c.x1 : 0;
		if (d < distance) {
			distance = d;
			nearest = i;
		}
	});
	return { index: nearest, sure: false };
}

/** El texto de unos trozos: por renglón de arriba abajo, y en cada renglón de izquierda a derecha. */
function textOf(items: TextoPosicionado[]): string {
	const out: string[] = [];
	for (const line of lines(items)) {
		let text = '';
		let prev: TextoPosicionado | null = null;
		for (const item of line.items) {
			const glue = prev && item.x0 - prev.x1 > 0.1 * Math.max(item.h, prev.h) ? ' ' : '';
			text += (prev ? glue : '') + item.texto.trim();
			prev = item;
		}
		out.push(text);
	}
	return out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Texto encimado en la misma línea (un «AVEO HB» recortado bajo «TAHOE», o la
 * negrita simulada que escribe dos veces lo mismo): dos textos visibles no se
 * enciman, así que se queda uno. Cuál, lo dice `preferir` (la página
 * dibujada); sin ella, el más ancho.
 */
function withoutOverlaps(items: TextoPosicionado[], preferir?: OpcionesDisposicion['preferir']): TextoPosicionado[] {
	const kept = new Set(items);
	const sorted = [...items].sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0));
	for (let i = 0; i < sorted.length; i++) {
		const a = sorted[i]!;
		for (let j = i + 1; j < sorted.length && kept.has(a); j++) {
			const b = sorted[j]!;
			if (!kept.has(b) || Math.abs(a.y - b.y) >= 0.75 * Math.max(a.h, b.h)) continue;
			if (overlap(a, b) <= 0.5 * Math.max(0.1, b.x1 - b.x0)) continue;
			// Lo mismo escrito dos veces: basta uno. Distinto: el que se ve.
			const winner = a.texto.trim() === b.texto.trim() || !preferir ? a : preferir(a, b);
			kept.delete(winner === a ? b : a);
		}
	}
	return items.filter((i) => kept.has(i));
}

/** Los bloques de una página: tablas y texto, de arriba abajo. */
export function bloquesDePagina(items: TextoPosicionado[], pagina: number, opciones: OpcionesDisposicion = {}): BloqueExtraido[] {
	const clean = withoutOverlaps(
		items.filter((i) => i.texto.trim() !== ''),
		opciones.preferir
	);
	if (!clean.length) return [];
	const all = rows(lines(clean));
	const isAnchor = (row: Fila) => merge(row.items, gapFor(row.h)).length >= 3;

	// Tablas: filas de tabla seguidas; un hueco grande (más de 3 filas típicas) empieza otra.
	const anchors = all.filter(isAnchor);
	const spacing = median(anchors.slice(1).map((r, i) => anchors[i]!.y - r.y));
	const runs: Fila[][] = [];
	for (const row of anchors) {
		const run = runs.at(-1);
		const prev = run?.at(-1);
		if (run && prev && prev.y - row.y <= Math.max(3 * spacing, 4 * row.h)) run.push(row);
		else runs.push([row]);
	}
	const tables = runs.filter((run) => run.length >= 2);
	const inTable = new Set<Fila>();
	const blocks: { top: number; bottom: number; block: BloqueExtraido }[] = [];

	for (const anchored of tables) {
		// Una fila con menos de tres celdas llenas también es de la tabla si está donde va una fila:
		// entre dos filas y lejos de ellas (a más de 0.6 del espacio entre filas), o justo una fila
		// debajo de la última con al menos dos celdas.
		const step = median(anchored.slice(1).map((r, i) => anchored[i]!.y - r.y)) || 4 * anchored[0]!.h;
		const first = anchored[0]!;
		const last = anchored.at(-1)!;
		// Y con algo en una columna que casi todas las filas llenan: las piezas sueltas de una celda
		// combinada («SUBURBAN», una nota en «Otros») caen en columnas casi vacías.
		const dense = (item: TextoPosicionado) => anchored.filter((a) => a.items.some((i) => overlap(i, item) > 0)).length >= 0.5 * anchored.length;
		const sparse = all.filter((r) => {
			if (anchored.includes(r) || r.y >= first.y || !r.items.some(dense)) return false;
			if (r.y < last.y) return Math.abs(last.y - r.y - step) < 0.2 * step && merge(r.items, gapFor(r.h)).length >= 2;
			return Math.min(...anchored.map((a) => Math.abs(a.y - r.y))) >= 0.6 * step;
		});
		const run = [...anchored, ...sparse].sort((a, b) => b.y - a.y);
		const top = run[0]!.top;
		const bottom = run.at(-1)!.bottom;
		// Las filas sueltas dentro de la tabla: celdas combinadas o renglones de más.
		const fragments = all.filter((r) => !run.includes(r) && r.y < top && r.y > bottom - run.at(-1)!.h);
		for (const r of [...run, ...fragments]) inTable.add(r);
		blocks.push({ top, bottom, block: table(run, fragments, pagina, opciones) });
	}

	// Lo demás es texto: párrafos de renglones cercanos.
	let paragraph: Fila[] = [];
	const flush = () => {
		if (!paragraph.length) return;
		const contenido = paragraph.map((r) => textOf(r.items)).join('\n');
		blocks.push({ top: paragraph[0]!.top, bottom: paragraph.at(-1)!.bottom, block: { pagina, tipo: 'texto', contenido } });
		paragraph = [];
	};
	for (const row of all) {
		if (inTable.has(row)) {
			flush();
			continue;
		}
		const prev = paragraph.at(-1);
		if (prev && prev.bottom - row.top > 2.2 * row.h) flush();
		paragraph.push(row);
	}
	flush();

	blocks.sort((a, b) => b.top - a.top);
	// El título de una tabla: el texto que tiene justo encima.
	blocks.forEach((b, i) => {
		const above = blocks[i - 1];
		if (b.block.tipo === 'tabla' && above?.block.tipo === 'texto' && above.bottom - b.top < 40) {
			b.block.titulo = above.block.contenido!.replace(/\n/g, ' ');
		}
	});
	return blocks.map((b) => b.block);
}

function table(run: Fila[], fragments: Fila[], pagina: number, opciones: OpcionesDisposicion): BloqueExtraido {
	const h = median(run.map((r) => r.h));
	const gap = gapFor(h);
	const first = run[0]!;
	const firstCells = merge(first.items, gap).map((seg) => textOf(first.items.filter((i) => overlap(i, seg) > 0)));
	const hasHeader = firstCells.every((c) => !NUMERIC.test(c));
	const header = hasHeader ? first : null;
	const body = hasHeader ? run.slice(1) : run;

	// Columnas: donde el texto de los datos deja un corte vertical; un encabezado sin datos abajo abre la suya.
	let columns = merge(
		body.flatMap((r) => r.items),
		gap
	);
	if (header) {
		const orphans = merge(
			header.items.filter((i) => !columns.some((c) => overlap(i, c) > 0)),
			gap
		);
		for (const orphan of orphans) {
			// Un encabezado centrado sobre números alineados a la derecha («AMDA» sobre «55») no se les
			// encima: es de la columna vecina que no tiene encabezado, si está cerca.
			const distance = (c: Intervalo) => Math.max(c.x0 - orphan.x1, orphan.x0 - c.x1, 0);
			const untitled = columns.filter((c) => !header.items.some((i) => overlap(i, c) > 0) && distance(c) < 3 * h);
			const neighbor = untitled.sort((a, b) => distance(a) - distance(b))[0];
			if (neighbor) {
				neighbor.x0 = Math.min(neighbor.x0, orphan.x0);
				neighbor.x1 = Math.max(neighbor.x1, orphan.x1);
			} else columns.push(orphan);
		}
		columns.sort((a, b) => a.x0 - b.x0);
	}

	let doubtful = 0;
	let total = 0;
	const place = (items: TextoPosicionado[]) => {
		const cells: TextoPosicionado[][] = columns.map(() => []);
		for (const item of items) {
			const { index, sure } = columnOf(item, columns);
			cells[index]!.push(item);
			total++;
			if (!sure) doubtful++;
		}
		return cells;
	};

	const bodyCells = body.map((r) => place(r.items));
	const fill = columns.map((_, c) => bodyCells.filter((cells) => cells[c]!.length > 0).length / Math.max(1, body.length));
	// Columnas del principio casi vacías: celdas combinadas que agrupan filas. Con las líneas de la
	// tabla, cualquier columna con huecos es candidata («Otros», con una nota que abarca tres filas;
	// «Modelo» con grupos de cuatro filas y el nombre en dos renglones): las líneas deciden.
	const leading = new Set<number>();
	for (let c = 0; c < columns.length && fill[c]! < 0.34; c++) leading.add(c);
	if (leading.size === columns.length) leading.clear();
	const merged = new Set(leading);
	if (opciones.lineaHorizontal) columns.forEach((_, c) => fill[c]! > 0 && fill[c]! < 0.6 && merged.add(c));

	const pieces = new Map<number, { y: number; item: TextoPosicionado }[]>();
	for (const c of merged) {
		pieces.set(
			c,
			body.flatMap((r, i) => bodyCells[i]![c]!.map((item) => ({ y: item.y, item })))
		);
	}
	const nearestRow = (y: number) => body.reduce((best, r, i) => (Math.abs(r.y - y) < Math.abs(body[best]!.y - y) ? i : best), 0);
	for (const fragment of fragments) {
		const cells = place(fragment.items);
		cells.forEach((items, c) => {
			if (!items.length) return;
			if (merged.has(c)) pieces.get(c)!.push(...items.map((item) => ({ y: item.y, item })));
			// Un renglón de más de una celda: va a la fila más cercana.
			else bodyCells[nearestRow(fragment.y)]?.[c]!.push(...items);
		});
	}

	const filas = bodyCells.map((cells) => cells.map(textOf));
	let combined = false;
	for (const [c, list] of pieces) {
		if (!list.length) continue;
		// Con la página dibujada, las líneas de la tabla dicen qué filas abarca cada celda combinada. Se
		// buscan a lo ancho de la celda (hasta la mitad del espacio con las columnas vecinas: una letra no
		// llena eso) y entre el texto de una fila y el de la siguiente.
		const left = c > 0 ? (columns[c - 1]!.x1 + columns[c]!.x0) / 2 : columns[c]!.x0 - gap;
		const right = c < columns.length - 1 ? (columns[c]!.x1 + columns[c + 1]!.x0) / 2 : columns[c]!.x1 + gap;
		const cuts = opciones.lineaHorizontal
			? body.slice(1).map((r, i) => opciones.lineaHorizontal!(left, right, body[i]!.y - 0.15 * h, r.y + 0.85 * h))
			: [];
		if (cuts.some(Boolean)) {
			let start = 0;
			for (let i = 0; i <= cuts.length; i++) {
				if (i < cuts.length && !cuts[i]) continue;
				// Filas start…i: el valor son los trozos que caen entre ellas (hasta la mitad del camino a la fila vecina).
				const upper = start > 0 ? (body[start - 1]!.y + body[start]!.y) / 2 : Infinity;
				const lower = i < body.length - 1 ? (body[i]!.y + body[i + 1]!.y) / 2 : -Infinity;
				const text = textOf(list.filter((p) => p.y < upper && p.y >= lower).map((p) => p.item));
				for (let k = start; k <= i; k++) filas[k]![c] = text;
				if (i > start && text) combined = true;
				start = i + 1;
			}
			continue;
		}
		if (!leading.has(c)) {
			// Una columna casi vacía sin líneas que la partan: cada trozo, en su fila.
			const byRow = body.map(() => [] as TextoPosicionado[]);
			for (const p of list) byRow[nearestRow(p.y)]!.push(p.item);
			byRow.forEach((items, i) => (filas[i]![c] = textOf(items)));
			continue;
		}
		combined = true;
		// Sin líneas: trozos cercanos (un valor de varios renglones) son un solo valor, y cada fila toma el de centro más cercano.
		list.sort((a, b) => b.y - a.y);
		const groups: { items: TextoPosicionado[]; top: number; bottom: number }[] = [];
		for (const p of list) {
			const g = groups.at(-1);
			if (g && g.bottom - p.y <= 1.8 * h) {
				g.items.push(p.item);
				g.bottom = p.y;
			} else groups.push({ items: [p.item], top: p.y, bottom: p.y });
		}
		const values = groups.map((g) => ({ text: textOf(g.items), center: (g.top + g.bottom) / 2 }));
		body.forEach((r, i) => {
			const nearest = values.reduce((a, b) => (Math.abs(b.center - r.y) < Math.abs(a.center - r.y) ? b : a));
			filas[i]![c] = nearest.text;
		});
	}

	const encabezados = header ? place(header.items).map(textOf) : undefined;
	const confianza = Math.round((1 - doubtful / Math.max(1, total)) * (combined ? 0.9 : 1) * 100) / 100;
	return { pagina, tipo: 'tabla', ...(encabezados ? { encabezados } : {}), filas, confianza };
}
