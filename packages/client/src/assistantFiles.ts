/**
 * Lo que se suelta en el asistente de importación (SB-36), en archivos sueltos
 * con su carpeta: carpetas leídas con la API nativa del navegador
 * (`webkitGetAsEntry`, o `webkitRelativePath` de un `<input webkitdirectory>`)
 * y zips abiertos aquí con `jszip`, que se carga la primera vez. Si un zip no
 * se puede abrir en el navegador, sube tal cual y lo abre el servidor.
 */

/** Un archivo a subir, con la ruta de la carpeta (o el zip) de donde salió. */
export interface PendingFile {
	file: File;
	carpeta: string | null;
}

/** Mínimo de la API de entradas de archivos del navegador (FileSystemEntry). */
interface Entry {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	file?(ok: (f: File) => void, fail: (e: unknown) => void): void;
	createReader?(): { readEntries(ok: (entries: Entry[]) => void, fail: (e: unknown) => void): void };
}

const IGNORED = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|(^|\/)__MACOSX\//;

const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join('/') || null;

async function walk(entry: Entry, folder: string | null, out: PendingFile[]): Promise<void> {
	if (entry.isFile && entry.file) {
		const file = await new Promise<File>((ok, fail) => entry.file!(ok, fail));
		if (!IGNORED.test(file.name)) out.push({ file, carpeta: folder });
		return;
	}
	if (entry.isDirectory && entry.createReader) {
		const reader = entry.createReader();
		const here = join(folder, entry.name);
		// `readEntries` devuelve por tandas: se llama hasta que vuelve vacío.
		for (;;) {
			const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail));
			if (!batch.length) break;
			for (const child of batch) await walk(child, here, out);
		}
	}
}

/** Lo soltado (archivos y carpetas) en archivos con su carpeta. */
export async function filesFromDrop(data: DataTransfer): Promise<PendingFile[]> {
	const entries = [...data.items]
		.filter((i) => i.kind === 'file')
		.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() ?? null);
	if (!entries.length || entries.some((e) => e === null)) return [...data.files].map((file) => ({ file, carpeta: null }));
	const out: PendingFile[] = [];
	for (const entry of entries) await walk(entry!, null, out);
	return out;
}

/** Lo elegido en un `<input type=file>` (con `webkitdirectory`, cada archivo trae su ruta). */
export function filesFromInput(list: FileList | File[]): PendingFile[] {
	return [...list]
		.map((file) => {
			const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
			const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
			return { file, carpeta: folder };
		})
		.filter((p) => !IGNORED.test(`${p.carpeta ?? ''}/${p.file.name}`));
}

const isZip = (file: File) => /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';

/**
 * Abre los zips en el navegador: cada archivo de adentro, con su ruta en
 * `carpeta` (zip dentro de carpeta dentro de zip, todo se aplana). Un zip que
 * no se puede abrir (cifrado, dañado, `jszip` no disponible) se deja tal cual.
 */
export async function expandZips(files: PendingFile[], maxBytes = Infinity): Promise<PendingFile[]> {
	const out: PendingFile[] = [];
	for (const p of files) {
		if (!isZip(p.file) || p.file.size > maxBytes) {
			out.push(p);
			continue;
		}
		try {
			const { default: JSZip } = await import('jszip');
			const zip = await JSZip.loadAsync(await p.file.arrayBuffer());
			const base = join(p.carpeta, p.file.name.replace(/\.zip$/i, ''));
			const inner: PendingFile[] = [];
			for (const entry of Object.values(zip.files)) {
				if (entry.dir || IGNORED.test(entry.name)) continue;
				const parts = entry.name.split('/');
				const name = parts.pop()!;
				const blob = await entry.async('blob');
				inner.push({ file: new File([blob], name, { lastModified: entry.date?.getTime() }), carpeta: join(base, ...parts) });
			}
			out.push(...(await expandZips(inner, maxBytes)));
		} catch {
			out.push(p);
		}
	}
	return out;
}
