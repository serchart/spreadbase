/**
 * Archivos del asistente de importación (SB-36): de qué tipo son, abrir un
 * zip (respaldo: normalmente se expande en el navegador), sacar el texto de un
 * .docx, y el almacenamiento que además sabe leer lo que guardó.
 *
 * El zip se lee a mano con `node:zlib` (almacenado o deflate, sin cifrado ni
 * zip64): unas decenas de líneas en lugar de una dependencia, con topes contra
 * las bombas de descompresión.
 */
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { FileStorage, UploadedFile } from '@spreadbase/core';
import { sniffType } from '../storage.ts';

/** Un `FileStorage` (SB-30) que además devuelve los bytes de lo que guardó: el agente los analiza. */
export interface ImportFileStorage extends FileStorage {
	read(url: string, ctx: Record<string, unknown>): Promise<Uint8Array>;
	/** Para la retención: borrar lo de una corrida vencida. Opcional. */
	remove?(url: string, ctx: Record<string, unknown>): Promise<void>;
}

/** Guarda en memoria: para pruebas y ejemplos. Las URL son `memory://<id>/<nombre>`. */
export function memoryFileStorage(): ImportFileStorage & { readonly size: number } {
	const files = new Map<string, Uint8Array>();
	return {
		get size() {
			return files.size;
		},
		async save(file: UploadedFile) {
			const url = `memory://${randomBytes(9).toString('base64url')}/${encodeURIComponent(file.name)}`;
			files.set(url, file.bytes);
			return url;
		},
		async read(url) {
			const bytes = files.get(url);
			if (!bytes) throw new Error(`No existe el archivo ${url}`);
			return bytes;
		},
		async remove(url) {
			files.delete(url);
		}
	};
}

/** Extensión → tipo, para lo que no se reconoce por el contenido. */
const BY_EXTENSION: Record<string, string> = {
	heic: 'image/heic',
	heif: 'image/heif',
	md: 'text/markdown',
	markdown: 'text/markdown',
	json: 'application/json',
	csv: 'text/csv',
	tsv: 'text/tab-separated-values',
	txt: 'text/plain'
};

export const extensionOf = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '');

/**
 * El tipo real de un archivo: por su firma (`sniffType`, SB-30) y, para el
 * texto y lo que no tiene firma conocida (HEIC), por la extensión. HTML y SVG
 * nunca: `null`.
 */
export function fileType(bytes: Uint8Array, name: string): string | null {
	const sniffed = sniffType(bytes, name);
	const ext = extensionOf(name);
	if (sniffed === 'text/html' || sniffed === 'image/svg+xml') return null;
	if (sniffed === 'text/plain' || sniffed === null) return BY_EXTENSION[ext] ?? sniffed;
	return sniffed;
}

export interface ZipEntry {
	/** Ruta dentro del zip (`fotos/septiembre/a.png`). */
	path: string;
	bytes: Uint8Array;
}

/** ¿Es un zip (y no un Office)? */
export const isZip = (type: string) => type === 'application/zip';

/**
 * Los archivos de un zip. Se saltan carpetas, `__MACOSX/`, `.DS_Store` y
 * entradas cifradas o con otro método de compresión. `maxBytes` topa lo
 * descomprimido en total (y por entrada): una bomba no pasa.
 */
export function unzip(data: Uint8Array, maxBytes: number): ZipEntry[] {
	const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error('El zip está dañado: no tiene directorio central');
	const count = buf.readUInt16LE(eocd + 10);
	let at = buf.readUInt32LE(eocd + 16);
	if (at === 0xffffffff) throw new Error('El zip es zip64 (más de 4 GB): no se abre en el servidor');
	const out: ZipEntry[] = [];
	let total = 0;
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('El zip está dañado');
		const flags = buf.readUInt16LE(at + 8);
		const method = buf.readUInt16LE(at + 10);
		const compressed = buf.readUInt32LE(at + 20);
		const size = buf.readUInt32LE(at + 24);
		const nameLength = buf.readUInt16LE(at + 28);
		const extraLength = buf.readUInt16LE(at + 30);
		const commentLength = buf.readUInt16LE(at + 32);
		const local = buf.readUInt32LE(at + 42);
		const rawName = buf.subarray(at + 46, at + 46 + nameLength);
		const path = (flags & 0x800 ? rawName.toString('utf8') : rawName.toString('latin1')).replace(/\\/g, '/');
		at += 46 + nameLength + extraLength + commentLength;

		const skip = path.endsWith('/') || path.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(path) || flags & 0x1 || (method !== 0 && method !== 8);
		if (skip) continue;
		total += size;
		if (size > maxBytes || total > maxBytes) throw new Error(`El zip descomprimido pasa del máximo (${Math.round(maxBytes / 1_048_576)} MB)`);
		const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
		const raw = buf.subarray(start, start + compressed);
		const bytes = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: size + 1 });
		out.push({ path, bytes: new Uint8Array(bytes) });
	}
	return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** El texto de un .docx: un párrafo por renglón, celdas de tabla separadas por tabuladores. */
export function docxText(data: Uint8Array): string {
	const doc = unzip(data, 100 * 1_048_576).find((e) => e.path === 'word/document.xml');
	if (!doc) throw new Error('El .docx no trae word/document.xml');
	return new TextDecoder()
		.decode(doc.bytes)
		.replace(/<\/w:p>/g, '\n')
		.replace(/<\/w:tc>/g, '\t')
		.replace(/<w:tab\/>/g, '\t')
		.replace(/<[^>]+>/g, '')
		.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]!)
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
		.replace(/\t\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
