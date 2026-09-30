/**
 * Archivos subidos a una columna `image` o `file` (SB-30): de qué tipo son de
 * verdad y dónde se guardan.
 *
 * El destino es configurable: `diskStorage` guarda en una carpeta del servidor;
 * un bucket es otro objeto con el mismo `save`. La URL que devuelve es lo que
 * queda en la celda.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express, { type Router } from 'express';
import type { FileStorage, UploadedFile } from '@spreadbase/core';

// -- tipo real -------------------------------------------------------------------------

const startsWith = (bytes: Uint8Array, sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/** Tipos de Office que por dentro son un zip: se reconocen por la extensión declarada. */
const OFFICE: Record<string, string> = {
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

/** Texto plano: UTF-8 válido y sin bytes de control raros. */
function isText(bytes: Uint8Array): boolean {
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, 64 * 1024));
		return !/[\u0000-\u0008\u000E-\u001F]/.test(text);
	} catch {
		return false;
	}
}

/**
 * El tipo de un archivo por su contenido (la «firma» de sus primeros bytes),
 * no por lo que diga el navegador ni por su extensión. `null` si no es uno
 * que SpreadBase sepa reconocer.
 */
export function sniffType(bytes: Uint8Array, declaredName = ''): string | null {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
	if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
	if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
	if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
		const ext = declaredName.toLowerCase().split('.').pop() ?? '';
		return OFFICE[ext] ?? 'application/zip';
	}
	if (!isText(bytes)) return null;
	const head = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^﻿/, '').trimStart().toLowerCase();
	// Lo que parezca marcado para el navegador se trata como HTML o SVG: nunca se acepta.
	if (/^<!doctype html|^<html|<script|<svg/.test(head)) return head.includes('<svg') ? 'image/svg+xml' : 'text/html';
	if (head.startsWith('<?xml')) return 'application/xml';
	return declaredName.toLowerCase().endsWith('.csv') ? 'text/csv' : 'text/plain';
}

/** Extensión de cada tipo reconocido. */
export const EXTENSION: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'application/pdf': 'pdf',
	'application/xml': 'xml',
	'application/zip': 'zip',
	'text/csv': 'csv',
	'text/plain': 'txt',
	...Object.fromEntries(Object.entries(OFFICE).map(([ext, type]) => [type, ext]))
};

/**
 * Nombre seguro para guardar y mostrar: sin acentos ni signos, sin rutas, con
 * la extensión de su tipo real (un `.exe` renombrado a `.pdf` que pasó como PDF
 * se guarda como `.pdf`, y uno que no lo es no pasa).
 */
export function safeFileName(declared: string, type: string): string {
	const ext = EXTENSION[type] ?? 'bin';
	const base = (declared.split(/[\\/]/).pop() ?? '')
		.replace(/\.[^.]*$/, '')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '')
		.slice(0, 80);
	return `${base || 'archivo'}.${ext}`;
}

// -- destino: carpeta del servidor -----------------------------------------------------

export interface DiskStorageOptions {
	/** Carpeta donde se guardan. Se crea si no existe. */
	dir: string;
	/** Cómo se ven desde el navegador: la URL donde se monta `serve()`. */
	publicUrl: string;
}

export interface DiskStorage extends FileStorage {
	/**
	 * Sirve lo guardado: `app.use('/uploads/logos', logos.serve())`. Para
	 * documentos privados, detrás del middleware de sesión de la app.
	 */
	serve(): Router;
}

/** Tipos que el navegador puede mostrar sin riesgo; el resto se descarga. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

/**
 * Guarda cada archivo en `<dir>/<carpeta aleatoria>/<nombre limpio>`. La
 * carpeta aleatoria hace que nadie adivine la ruta de un archivo ajeno y que
 * dos archivos con el mismo nombre no choquen; el nombre queda al final de la
 * URL y es lo que muestra la celda.
 */
export function diskStorage({ dir, publicUrl }: DiskStorageOptions): DiskStorage {
	const root = path.resolve(dir);
	const base = publicUrl.replace(/\/+$/, '');
	return {
		async save(file: UploadedFile) {
			const folder = randomBytes(9).toString('base64url');
			await mkdir(path.join(root, folder), { recursive: true });
			await writeFile(path.join(root, folder, file.name), file.bytes, { flag: 'wx' });
			return `${base}/${folder}/${encodeURIComponent(file.name)}`;
		},
		serve() {
			const router = express.Router();
			router.use(
				express.static(root, {
					dotfiles: 'deny',
					index: false,
					redirect: false,
					setHeaders(res, filePath) {
						// Por la extensión: `express.static` pone el `Content-Type` después de aquí.
						const ext = path.extname(filePath).slice(1).toLowerCase();
						const mime = Object.entries(EXTENSION).find(([, e]) => e === ext || (ext === 'jpeg' && e === 'jpg'))?.[0] ?? '';
						// El navegador no adivina tipos: un archivo es lo que dice su extensión.
						res.setHeader('X-Content-Type-Options', 'nosniff');
						// Aunque algo se colara, no ejecuta nada. El visor de PDF del navegador
						// no abre en un documento aislado (`sandbox`): el PDF no lo lleva.
						res.setHeader('Content-Security-Policy', `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'${mime === 'application/pdf' ? '' : '; sandbox'}`);
						if (!INLINE.has(mime)) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
					}
				})
			);
			return router;
		}
	};
}
