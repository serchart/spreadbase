/**
 * Harness de navegador (doc 09 §4, §6).
 *
 * - **Cada usuario es un contexto** con su propio almacenamiento: dos
 *   contextos son dos usuarios; dos pestañas de un contexto, no.
 * - La consola de cada usuario se guarda en disco siempre, y una captura si la
 *   prueba falla. Los artefactos acompañan; las aserciones deciden.
 * - Un error de página (`pageerror`) hace fallar la prueba aunque lo demás pase.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const RESULTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-results');

export interface TestUser {
	page: Page;
	logs: string[];
	errors: string[];
	/** Captura con nombre: `user('A')` + shot('A', 'modal') → A-modal.png */
	shot: (label: string) => Promise<void>;
}

let browserPromise: Promise<Browser> | null = null;
const browser = () => (browserPromise ??= chromium.launch());

export function browserHarness() {
	let dir = '';
	let users: [string, TestUser & { context: BrowserContext }][] = [];

	beforeEach(({ task }) => {
		dir = path.join(RESULTS, path.basename(task.file?.filepath ?? 'x', task.file?.filepath ? '.test.ts' : ''), safeName(task.name));
	});

	afterEach(async ({ task }) => {
		await mkdir(dir, { recursive: true });
		const failed = task.result?.state === 'fail';
		for (const [name, user] of users) {
			await writeFile(path.join(dir, `${name}-console.log`), user.logs.join('\n'));
			// Una prueba puede cerrar la pestaña a propósito: entonces no hay qué capturar.
			if (failed && !user.page.isClosed()) await user.page.screenshot({ path: path.join(dir, `${name}-fallo.png`), fullPage: true });
			await user.context.close();
		}
		// Una excepción de página que nadie miró invalida la prueba igual.
		for (const [, user] of users) expect(user.errors, 'errores de página').toEqual([]);
		users = [];
	});

	async function user(name: string): Promise<TestUser> {
		const context = await (await browser()).newContext({ viewport: { width: 1500, height: 900 } });
		const page = await context.newPage();
		const logs: string[] = [];
		const errors: string[] = [];
		page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
		page.on('pageerror', (e) => errors.push(String(e)));
		const u = {
			page,
			context,
			logs,
			errors,
			shot: async (label: string) => page.screenshot({ path: path.join(dir, `${name}-${label}.png`) })
		};
		users.push([name, u]);
		return u;
	}
	return { user };
}

const safeName = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80);
