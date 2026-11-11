/**
 * Etapas e íconos (SB-39): una tabla «Etapas» con el nombre de su ícono y una
 * hoja «Casos» cuya columna `etapa` (lookup) muestra el ícono de la etapa
 * elegida. En memoria, montado en /api/stages.
 *
 * - `avatar: { iconField: 'icon' }`: un ícono por fila, cuyo nombre sale de un
 *   campo (en Etapas, de la misma fila; en Casos, del registro elegido).
 * - `options[].icon`: ícono por opción de un `select` («Prioridad»); con valor y
 *   etiqueta iguales («Estado»), la lista no repite el valor.
 *
 * Los nombres (`hourglass`, `calendar-check`…) los registra la página con
 * `registerIcons`: el servidor solo los nombra.
 */
import { Router } from 'express';
import { SpreadBase, memorySource, sheetRouter, types } from '@spreadbase/server';

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** Las etapas de la semilla. Las dos últimas prueban el respaldo: sin ícono y con uno desconocido. */
export const STAGES = [
	{ id: 'st_1', name: 'Recepción', icon: 'inbox' },
	{ id: 'st_2', name: 'En espera', icon: 'hourglass' },
	{ id: 'st_3', name: 'Cita agendada', icon: 'calendar-check' },
	{ id: 'st_4', name: 'Cerrado', icon: 'circle-check' },
	{ id: 'st_5', name: 'Sin ícono', icon: '' },
	{ id: 'st_6', name: 'Ícono desconocido', icon: 'no-existe' }
];

const stagesSource = memorySource({ rows: STAGES, createId: (n) => `st_${n}` });

const stages = new SpreadBase({
	id: 'stages',
	allowInsert: true,
	columns: {
		id: { type: types.TEXT, label: 'ID', width: 80 },
		// De la misma fila: el nombre lleva el ícono de su campo `icon`.
		name: { type: types.TEXT, label: 'Etapa', required: true, width: 200, avatar: { iconField: 'icon', initials: true, shape: 'square' } },
		// El nombre de un ícono de `registerIcons`; vacío o desconocido, las iniciales.
		icon: { type: types.TEXT, label: 'Ícono', width: 150 }
	},
	source: stagesSource
});

/** Folio 1001…: el texto del botón de cada fila (`label: (row) => …`). */
const seedCases = () =>
	Array.from({ length: 40 }, (_, i) => ({
		id: `cs_${String(i + 1).padStart(3, '0')}`,
		folio: String(1001 + i),
		title: `Caso ${1001 + i}`,
		stage_id: STAGES[i % STAGES.length]!.id,
		priority: (['high', 'medium', 'low'] as const)[i % 3],
		status: i % 4 === 3 ? 'Cerrado' : 'Abierto'
	}));

export const casesSource = memorySource({ rows: seedCases(), createId: (n) => `cs_${String(n).padStart(3, '0')}` });

const stageRows = () => stagesSource.all();

const cases = new SpreadBase({
	id: 'stage-cases',
	allowInsert: true,
	columns: {
		id: { type: types.TEXT, label: 'ID', width: 80 },
		folio: { type: types.TEXT, label: 'Folio', width: 80 },
		title: { type: types.TEXT, label: 'Asunto', width: 160 },
		stage_id: {
			type: types.LOOKUP,
			label: 'Etapa',
			width: 190,
			// Del registro elegido: el servidor manda el ícono con su nombre (`icons`).
			avatar: { iconField: 'icon', initials: true, shape: 'square' },
			lookup: {
				value: 'id',
				display: 'name',
				columns: { name: { type: types.TEXT, label: 'Etapa', width: 200 } },
				search: (q, { offset, limit }) => {
					const found = stageRows().filter((s) => !q || fold(String(s.name)).includes(fold(q)));
					return { rows: found.slice(offset, offset + limit), total: found.length };
				},
				byIds: (ids) => stageRows().filter((s) => ids.includes(String(s.id))),
				resolve: (texts) => stageRows().filter((s) => texts.some((t) => fold(t) === fold(String(s.name))))
			}
		},
		// Valor y etiqueta distintos (un código): la lista muestra el código a la derecha.
		priority: {
			type: types.SELECT,
			label: 'Prioridad',
			width: 130,
			options: [
				{ value: 'high', label: 'Alta', icon: 'arrow-up' },
				{ value: 'medium', label: 'Media', icon: 'minus' },
				{ value: 'low', label: 'Baja', icon: 'arrow-down' }
			]
		},
		// Valor y etiqueta iguales: la lista no los repite.
		status: {
			type: types.SELECT,
			label: 'Estado',
			width: 120,
			options: [
				{ value: 'Abierto', label: 'Abierto' },
				{ value: 'Cerrado', label: 'Cerrado' }
			]
		}
	},
	source: casesSource
});

export function createStagesExample({ devRoutes = false } = {}): Router {
	const router = Router();
	// Las pruebas vuelven a la semilla (solo con APP_ENV=test, como en casos).
	if (devRoutes) {
		router.post('/reset', (_req, res) => {
			stagesSource.reset(STAGES);
			casesSource.reset(seedCases());
			res.json({ ok: true });
		});
	}
	router.use('/stages', sheetRouter(stages));
	router.use('/cases', sheetRouter(cases));
	return router;
}
