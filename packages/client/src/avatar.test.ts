/**
 * Iniciales y color de las miniaturas (SB-29): código puro, sin DOM.
 */
import { describe, expect, it } from 'vitest';
import { initialsOf, toneOf } from './avatar';

describe('initialsOf', () => {
	it('empresas: se saltan la forma de sociedad y los artículos', () => {
		expect(initialsOf('Transportes del Norte SA de CV')).toBe('TN');
		expect(initialsOf('Fletes Monterrey, S.A. de C.V.')).toBe('FM');
		expect(initialsOf('Grupo Industrial SAPI de CV')).toBe('GI');
		expect(initialsOf('La Moderna SRL')).toBe('MO');
		expect(initialsOf('Acme Inc')).toBe('AC');
	});

	it('personas: nombre y primer apellido, con acentos', () => {
		expect(initialsOf('Óscar Núñez')).toBe('ÓN');
		expect(initialsOf('ana lópez garcía')).toBe('AL');
	});

	it('una palabra da sus dos primeras letras; nada da vacío', () => {
		expect(initialsOf('Bimbo')).toBe('BI');
		expect(initialsOf('X')).toBe('X');
		expect(initialsOf('')).toBe('');
		expect(initialsOf('SA de CV')).toBe('');
		expect(initialsOf('  ,  ')).toBe('');
	});

	it('números y signos', () => {
		expect(initialsOf('3M México')).toBe('3M');
		expect(initialsOf('(Taller) & Hijos')).toBe('TH');
	});
});

describe('toneOf', () => {
	it('estable y en 1…8', () => {
		const names = ['Transportes del Norte SA de CV', 'Fletes Monterrey', 'Ana López', 'Bimbo', 'x'];
		for (const n of names) {
			expect(toneOf(n)).toBe(toneOf(n));
			expect(toneOf(n)).toBeGreaterThanOrEqual(1);
			expect(toneOf(n)).toBeLessThanOrEqual(8);
		}
		// Con suficientes nombres se usan todos los tonos.
		const tones = new Set(Array.from({ length: 200 }, (_, i) => toneOf(`Cliente ${i}`)));
		expect(tones.size).toBe(8);
	});
});
