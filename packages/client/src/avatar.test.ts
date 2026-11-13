/**
 * Iniciales y color de las miniaturas (SB-29): código puro, sin DOM.
 */
import { describe, expect, it } from 'vitest';
import { cachedMedia, hasIcon, initialsOf, recordMedia, rememberMedia, toneOf, withRecordIcon } from './avatar';

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

describe('ícono tomado de un campo (SB-39)', () => {
	const spec = { iconField: 'icon', image: 'photo', initials: true, icon: 'building' };

	it('un nombre conocido gana a las iniciales y al ícono fijo', () => {
		expect(withRecordIcon(spec, 'truck')).toEqual({ ...spec, initials: false, icon: 'truck' });
	});

	it('vacío, desconocido o ausente: el spec tal cual (iniciales o ícono fijo)', () => {
		for (const name of ['', 'no-existe', null, undefined]) expect(withRecordIcon(spec, name)).toBe(spec);
		expect(hasIcon('no-existe')).toBe(false);
		expect(hasIcon('user')).toBe(true);
	});

	it('la miniatura de un registro sale de los campos del spec; lo que no es texto no cuenta', () => {
		expect(recordMedia(spec, { photo: 'https://x/y.png', icon: 'truck' })).toEqual({ image: 'https://x/y.png', icon: 'truck' });
		expect(recordMedia(spec, { photo: '', icon: 3 })).toEqual({ image: null, icon: null });
		expect(recordMedia({ initials: true }, { icon: 'truck' })).toEqual({ image: null, icon: null });
		expect(recordMedia(spec, undefined)).toEqual({ image: null, icon: null });
	});

	it('se guarda y se lee de la caché por columna e id, sin pisar el nombre', () => {
		const cache = new Map<string, string>([['lookup␟stage␟st_2', 'En espera']]);
		rememberMedia(cache, 'stage', 'st_2', { icon: 'hourglass', image: null });
		expect(cachedMedia(cache, 'stage', 'st_2')).toEqual({ image: null, icon: 'hourglass' });
		expect(cachedMedia(cache, 'other', 'st_2')).toEqual({ image: null, icon: null });
		expect(cache.get('lookup␟stage␟st_2')).toBe('En espera');
	});
});

describe('miniatura tomada de una carpeta (SB-38)', () => {
	const f = (name: string, type = '') => ({ url: `https://x/${name}`, name, type, size: 1 });
	/** La forma obsoleta (≤ 0.1.3) se sigue leyendo. */
	const legacy = (nombre: string, tipo = '') => ({ url: `https://x/${nombre}`, nombre, tipo, tamano: 1 });
	const spec = { image: 'fotos' };

	it('el principal si es imagen; si no, la primera imagen; si no hay, nada', () => {
		expect(recordMedia(spec, { fotos: [f('a.png', 'image/png'), f('b.jpg', 'image/jpeg')] }).image).toBe('https://x/a.png');
		expect(recordMedia(spec, { fotos: [f('ficha.pdf', 'application/pdf'), f('b.jpg', 'image/jpeg')] }).image).toBe('https://x/b.jpg');
		expect(recordMedia(spec, { fotos: [f('ficha.pdf', 'application/pdf')] }).image).toBeNull();
		expect(recordMedia(spec, { fotos: [] }).image).toBeNull();
	});

	it('sin tipo, por la extensión; SVG nunca; una carpeta en texto JSON se lee igual', () => {
		expect(recordMedia(spec, { fotos: [f('a.webp')] }).image).toBe('https://x/a.webp');
		expect(recordMedia(spec, { fotos: [f('logo.svg', 'image/svg+xml')] }).image).toBeNull();
		expect(recordMedia(spec, { fotos: JSON.stringify([f('a.png', 'image/png')]) }).image).toBe('https://x/a.png');
		expect(recordMedia(spec, { fotos: 'https://x/suelta.png' }).image).toBe('https://x/suelta.png');
	});

	it('la forma obsoleta { url, nombre, tipo, tamano } da la misma miniatura', () => {
		expect(recordMedia(spec, { fotos: [legacy('ficha.pdf', 'application/pdf'), legacy('b.jpg', 'image/jpeg')] }).image).toBe('https://x/b.jpg');
		expect(recordMedia(spec, { fotos: legacy('a.png', 'image/png') }).image).toBe('https://x/a.png');
	});
});
