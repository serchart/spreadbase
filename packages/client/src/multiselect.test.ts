/**
 * Selección múltiple (SB-41): lo que se escribe, pega, copia y valida. Código
 * puro, sin DOM.
 */
import { describe, expect, it } from 'vitest';
import { getCellType } from './cellTypes';
import type { ColumnDef } from './types';

const column: ColumnDef = {
	field: 'brands',
	label: 'Marcas',
	type: 'multiselect',
	options: [
		{ value: 'byd', label: 'BYD' },
		{ value: 'honda', label: 'Honda' },
		{ value: 'kia', label: 'Kía' }
	]
};
const type = getCellType('multiselect');
const ctx = { labelCache: new Map() } as never;

describe('multiselect', () => {
	it('pegar «Honda, BYD» da los valores en el orden del catálogo, sin repetidos, por etiqueta o valor y sin acentos', () => {
		expect(type.fromClipboard!('Honda, BYD', column, ctx)).toEqual(['byd', 'honda']);
		expect(type.fromClipboard!('kia; honda\nHONDA', column, ctx)).toEqual(['honda', 'kia']);
		expect(type.parse('["kia","byd"]', column)).toEqual(['byd', 'kia']);
		expect(type.parse(['honda', 'byd', 'honda'], column)).toEqual(['byd', 'honda']);
	});

	it('vacío es null; lo desconocido se conserva al final para que la validación lo marque', () => {
		expect(type.parse('', column)).toBeNull();
		expect(type.parse([], column)).toBeNull();
		expect(type.parse('Ferrari, BYD', column)).toEqual(['byd', 'Ferrari']);
		expect(type.validate(['byd', 'Ferrari'], column, {} as never, ctx)).toBe('Valor fuera del catálogo');
		expect(type.validate(['byd', 'honda'], column, {} as never, ctx)).toBeNull();
		expect(type.validate(null, { ...column, required: true }, {} as never, ctx)).toBe('"Marcas" es obligatorio');
	});

	it('copiar y mostrar dan las etiquetas separadas por comas; null y [] son iguales', () => {
		expect(type.toClipboard!(['byd', 'kia'], column, ctx)).toBe('BYD, Kía');
		expect(type.format(['byd', 'kia'], column, ctx)).toBe('BYD, Kía');
		// Un valor suelto (la lista de valores del filtro) se muestra por su etiqueta.
		expect(type.format('honda', column, ctx)).toBe('Honda');
		expect(type.equals!(null, [] as never)).toBe(true);
		expect(type.equals!(['byd'], ['byd'])).toBe(true);
		expect(type.equals!(['byd'], ['byd', 'kia'])).toBe(false);
	});
});
