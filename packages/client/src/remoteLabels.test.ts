/**
 * Una fuente remota escrita a mano (`new Sheet({ columns, dataSource: { loadPage } })`)
 * entrega los nombres, fotos e íconos de sus `lookup` igual que `Sheet(url)` (SB-39):
 * los `labels`, `images` e `icons` de cada tramo y los `labels` de la lista de valores
 * entran a la caché del controlador.
 */
import { describe, expect, it } from 'vitest';
import { GridController } from './GridController.svelte';
import { cachedMedia } from './avatar';
import { lookupKey } from './cellTypes';
import type { GridConfig, PageResult } from './types';

const page: PageResult = {
	rows: [
		{ id: 'c1', stage: 'st_1', owner: 'u1' },
		{ id: 'c2', stage: 'st_2', owner: 'u2' }
	],
	total: 2,
	labels: { stage: { st_1: 'Recepción', st_2: 'En espera' }, owner: { u1: 'Ana', u2: 'Luis' } },
	images: { owner: { u1: 'https://x/ana.png' } },
	icons: { stage: { st_1: 'inbox', st_2: 'hourglass' } }
};

const lookup = { value: 'id', display: 'name', columns: {}, search: async () => ({ rows: [], total: 0 }) };

const config = (): GridConfig => ({
	id: 'remote-labels',
	persist: 'none',
	columns: [
		{ field: 'stage', label: 'Etapa', type: 'lookup', avatar: { iconField: 'icon' }, lookup },
		{ field: 'owner', label: 'Responsable', type: 'lookup', avatar: { image: 'photo' }, lookup }
	],
	dataSource: {
		loadPage: async () => structuredClone(page),
		values: async () => ({ values: [{ value: 'st_9', count: 1 }], truncated: false, labels: { st_9: 'Archivado' } })
	}
});

describe('fuente remota a mano: nombres y miniaturas de los lookup', () => {
	it('los labels, images e icons del tramo entran a la caché antes de pintar', async () => {
		const grid = new GridController(config());
		await grid.load();
		expect(grid.rows.map((r) => r.stage)).toEqual(['st_1', 'st_2']);
		expect(grid.labelCache.get(lookupKey('stage', 'st_2'))).toBe('En espera');
		expect(grid.labelCache.get(lookupKey('owner', 'u1'))).toBe('Ana');
		expect(cachedMedia(grid.labelCache, 'stage', 'st_1')).toEqual({ image: null, icon: 'inbox' });
		expect(cachedMedia(grid.labelCache, 'owner', 'u1')).toEqual({ image: 'https://x/ana.png', icon: null });
	});

	it('los labels de la lista de valores de un filtro, también', async () => {
		const grid = new GridController(config());
		await grid.loadValues('stage');
		expect(grid.labelCache.get(lookupKey('stage', 'st_9'))).toBe('Archivado');
	});
});
