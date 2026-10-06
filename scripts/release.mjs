/**
 * Construye y publica los paquetes de SpreadBase en npm.
 *
 *   node scripts/release.mjs build            → packages/<p>/dist, listo para publicar
 *   node scripts/release.mjs publish          → build + npm publish de cada dist
 *   node scripts/release.mjs publish --dry-run
 *
 * En el monorepo los paquetes se usan como TypeScript en crudo (sus `exports`
 * apuntan a `src/`). Lo que se publica es `dist/`: JavaScript con sus tipos y
 * un `package.json` propio cuyos `exports` apuntan ahí. El `package.json` del
 * repo no cambia, así que el desarrollo sigue igual.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BIN = join(ROOT, 'node_modules/.bin');
const PACKAGES = ['core', 'server', 'client', 'testing'];
const REPOSITORY = { type: 'git', url: 'git+https://github.com/serchart/spreadbase.git' };

const DESCRIPTIONS = {
	core: 'SpreadBase: el contrato común (tipos de columnas, filas, consultas y errores) entre servidor y cliente.',
	server: 'SpreadBase para Express: hojas sobre memoria o Postgres, con filtros, historial, importación y archivos.',
	client: 'SpreadBase para Svelte 5: la hoja de cálculo, el formulario y sus paneles (Tailwind 4 + daisyUI 5).',
	testing: 'SpreadBase: el kit de contrato para probar las hojas de una app con Vitest.'
};

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

function removeTests(dir) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) removeTests(path);
		else if (/\.test\.|\.property\.test\./.test(entry)) rmSync(path);
	}
}

/** Los `exports` del paquete publicado: lo de `src/*.ts` pasa a `dist/*.js` con sus tipos. */
function publishedExports(name) {
	if (name === 'client') {
		return {
			'.': { types: './index.d.ts', svelte: './index.js', default: './index.js' },
			'./theme-daisyui.css': './theme-daisyui.css'
		};
	}
	return { '.': { types: './index.d.ts', default: './index.js' } };
}

function build(name, version) {
	const dir = join(ROOT, 'packages', name);
	const dist = join(dir, 'dist');
	rmSync(dist, { recursive: true, force: true });
	if (name === 'client') run(join(BIN, 'svelte-package'), ['-i', 'src', '-o', 'dist', '--tsconfig', 'tsconfig.json'], dir);
	else run(join(BIN, 'tsc'), ['-p', 'tsconfig.build.json'], dir);
	removeTests(dist);

	const source = read(join(dir, 'package.json'));
	// Entre paquetes de SpreadBase, la misma versión con rango compatible.
	const pin = (deps) =>
		deps && Object.fromEntries(Object.entries(deps).map(([dep, range]) => [dep, dep.startsWith('@spreadbase/') ? `^${version}` : range]));
	const manifest = {
		name: source.name,
		version,
		description: DESCRIPTIONS[name],
		license: source.license ?? 'MIT',
		type: 'module',
		repository: { ...REPOSITORY, directory: `packages/${name}` },
		homepage: 'https://github.com/serchart/spreadbase#readme',
		keywords: ['spreadbase', 'spreadsheet', 'datagrid', name === 'client' ? 'svelte' : 'postgres'],
		exports: publishedExports(name),
		...(name === 'client' ? { svelte: './index.js', sideEffects: ['**/*.css'] } : {}),
		dependencies: pin(source.dependencies),
		peerDependencies: source.peerDependencies,
		publishConfig: { access: process.env.NPM_ACCESS ?? 'public' }
	};
	writeFileSync(join(dist, 'package.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
	copyFileSync(join(ROOT, 'LICENSE'), join(dist, 'LICENSE'));
	const readme = join(dir, 'README.md');
	writeFileSync(
		join(dist, 'README.md'),
		existsSync(readme)
			? readFileSync(readme, 'utf8')
			: `# ${source.name}\n\n${DESCRIPTIONS[name]}\n\nDocumentación y ejemplos: https://github.com/serchart/spreadbase\n`
	);
	console.log(`✓ ${source.name}@${version} → packages/${name}/dist`);
}

const [command = 'build', ...flags] = process.argv.slice(2);
const versions = new Set(PACKAGES.map((name) => read(join(ROOT, 'packages', name, 'package.json')).version));
if (versions.size !== 1) throw new Error(`Los paquetes deben tener la misma versión; hoy: ${[...versions].join(', ')}`);
const [version] = versions;

for (const name of PACKAGES) build(name, version);

if (command === 'publish') {
	// core primero: los demás dependen de él.
	for (const name of PACKAGES) {
		const pkg = `@spreadbase/${name}@${version}`;
		// Si una corrida anterior falló a la mitad, lo ya publicado se salta: npm no deja republicar una versión.
		let published = false;
		try {
			published = execFileSync('npm', ['view', pkg, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === version;
		} catch {
			/* 404: aún no existe */
		}
		if (published) console.log(`= ${pkg} ya estaba publicado`);
		else run('npm', ['publish', ...flags], join(ROOT, 'packages', name, 'dist'));
	}
}
