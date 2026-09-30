/**
 * Miniaturas antes del texto de una celda (SB-29): foto, iniciales o ícono.
 *
 * Todo se arma con nodos del DOM (`textContent`, `img.src` validado): ningún
 * texto que llegue de los datos se inserta como HTML. Los íconos son
 * componentes de lucide convertidos a SVG una sola vez y guardados.
 */
import { flushSync, mount, unmount, type Component } from 'svelte';
import User from '@lucide/svelte/icons/user';
import UserRound from '@lucide/svelte/icons/user-round';
import Users from '@lucide/svelte/icons/users';
import Building from '@lucide/svelte/icons/building';
import Store from '@lucide/svelte/icons/store';
import Truck from '@lucide/svelte/icons/truck';
import Bot from '@lucide/svelte/icons/bot';
import Landmark from '@lucide/svelte/icons/landmark';
import Mail from '@lucide/svelte/icons/mail';
import Phone from '@lucide/svelte/icons/phone';
import FileText from '@lucide/svelte/icons/file-text';
import FileIcon from '@lucide/svelte/icons/file';
import FileImage from '@lucide/svelte/icons/file-image';
import FileCode from '@lucide/svelte/icons/file-code';
import FileSpreadsheet from '@lucide/svelte/icons/file-spreadsheet';
import FileArchive from '@lucide/svelte/icons/file-archive';
import ExternalLink from '@lucide/svelte/icons/external-link';
import type { AvatarSpec } from '@spreadbase/core';

/** Los íconos que SpreadBase trae; la app agrega los suyos con `registerIcons`. */
const icons = new Map<string, Component>([
	['user', User],
	['user-round', UserRound],
	['users', Users],
	['building', Building],
	['store', Store],
	['truck', Truck],
	['bot', Bot],
	['landmark', Landmark],
	['mail', Mail],
	['phone', Phone],
	['file-text', FileText],
	// Los de las celdas de archivo (SB-30).
	['file', FileIcon],
	['file-image', FileImage],
	['file-code', FileCode],
	['file-spreadsheet', FileSpreadsheet],
	['file-archive', FileArchive],
	['external-link', ExternalLink]
]);
const svgCache = new Map<string, string>();

/**
 * Agrega íconos al registro, por nombre: `registerIcons({ truck: Truck })`.
 * El esquema del servidor los nombra (`avatar: { icon: 'truck' }`): un nombre
 * viaja en JSON, un componente no.
 */
export function registerIcons(more: Record<string, Component>): void {
	for (const [name, icon] of Object.entries(more)) {
		icons.set(name, icon);
		svgCache.delete(name);
	}
}

/** El SVG de un ícono del registro, por nombre (se calcula una vez). */
export function iconSvg(name: string): string {
	const cached = svgCache.get(name);
	if (cached !== undefined) return cached;
	const icon = icons.get(name) ?? icons.get('user')!;
	if (typeof document === 'undefined') return '';
	const host = document.createElement('div');
	const instance = mount(icon, { target: host, props: { size: 12, 'aria-hidden': 'true', strokeWidth: 2.25 } });
	flushSync();
	const html = host.innerHTML;
	unmount(instance);
	svgCache.set(name, html);
	return html;
}

/** Palabras que no dan inicial: formas de sociedad y artículos («Transportes del Norte SA de CV» → «TN»). */
const SKIP = new Set([
	'sa', 's.a.', 's.a', 'cv', 'c.v.', 'c.v', 'de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'sapi', 's.a.p.i.',
	'srl', 's.r.l.', 'rl', 's.', 'sc', 's.c.', 'sas', 'ab', 'the', 'and', 'of', 'inc', 'llc', 'ltd', 'corp'
]);

/** Hasta dos iniciales: las de las dos primeras palabras que cuentan; con una sola palabra, sus dos primeras letras. */
export function initialsOf(text: string): string {
	const words = text
		.split(/[\s,]+/)
		.map((w) => w.replace(/[^\p{L}\p{N}.]/gu, ''))
		.filter((w) => w && !SKIP.has(w.toLowerCase()));
	const letters = (w: string) => [...w.replace(/[^\p{L}\p{N}]/gu, '')];
	if (words.length === 0) return '';
	if (words.length === 1) return letters(words[0]!).slice(0, 2).join('').toUpperCase();
	return (letters(words[0]!)[0]! + (letters(words[1]!)[0] ?? '')).toUpperCase();
}

/** 1…8: el mismo texto da siempre el mismo color (`--dg-avatar-1`… del tema). */
export function toneOf(text: string): number {
	let h = 0;
	for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
	return (h % 8) + 1;
}

const IMAGE_URL = /^(https?:\/\/|data:image\/|\/)/;

/**
 * El nodo de la miniatura para `text` según `spec`: imagen, y si no hay o no
 * carga, iniciales o ícono. `null` si la celda está vacía (sin texto no hay a
 * quién representar).
 */
export function avatarNode(spec: AvatarSpec, text: string, imageUrl?: string | null): HTMLElement | null {
	if (!text) return null;
	const node = document.createElement('span');
	const shape = spec.shape ?? 'round';
	node.className = `oc-avatar is-${shape}`;
	node.setAttribute('aria-hidden', 'true');

	const fallback = () => {
		node.replaceChildren();
		node.classList.remove('has-image');
		node.classList.add('is-fallback');
		const initials = spec.initials ? initialsOf(text) : '';
		if (initials) {
			// En un atributo y no como texto: el `textContent` de la celda sigue
			// siendo solo su valor (lo que leen las pruebas y un lector de pantalla).
			node.classList.add('has-initials', `tone-${toneOf(text)}`);
			node.dataset.initials = initials;
		} else {
			node.classList.add('has-icon');
			node.innerHTML = iconSvg(spec.icon ?? (shape === 'square' ? 'building' : 'user'));
		}
	};

	if (imageUrl && IMAGE_URL.test(imageUrl)) {
		const img = document.createElement('img');
		img.alt = '';
		img.loading = 'lazy';
		// Un enlace roto cae a las iniciales o al ícono, no a una imagen rota.
		img.onerror = fallback;
		img.src = imageUrl;
		node.classList.add('has-image');
		node.appendChild(img);
	} else {
		fallback();
	}
	return node;
}

/** Llave, en la caché de etiquetas, de la imagen de un registro de un `lookup`. */
export const avatarKey = (field: string, id: unknown) => `avatar␟${field}␟${String(id)}`;
