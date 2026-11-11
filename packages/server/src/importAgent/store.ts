/**
 * Corridas en memoria y cola en proceso (SB-36): lo que usa el agente si la
 * app no pone las suyas. Valen para un proceso, como `memorySource`.
 */
import type { ImportRun } from '@spreadbase/core';
import type { ImportJob, ImportRunStore, ImportRunner } from './types.ts';

/** Una copia profunda: lo guardado no se cambia por fuera (ni lo leído cambia lo guardado). */
const clone = <T>(value: T): T => structuredClone(value);

/** Corridas en memoria. Las vencidas (`expira`) desaparecen al leer. */
export function memoryRunStore(): ImportRunStore & { readonly size: number } {
	const runs = new Map<string, ImportRun>();
	const alive = (run: ImportRun) => {
		if (Date.parse(run.expira) > Date.now()) return true;
		runs.delete(run.id);
		return false;
	};
	return {
		get size() {
			return runs.size;
		},
		async crear(run) {
			if (runs.has(run.id)) throw new Error(`La corrida ${run.id} ya existe`);
			runs.set(run.id, clone(run));
		},
		async obtener(id) {
			const run = runs.get(id);
			return run && alive(run) ? clone(run) : null;
		},
		async guardar(run, versionLeida) {
			const current = runs.get(run.id);
			if (!current || current.version !== versionLeida) return false;
			runs.set(run.id, clone(run));
			return true;
		},
		async listar({ propietario, limite = 50 }) {
			return [...runs.values()]
				.filter((r) => alive(r) && (propietario === undefined || r.propietario === propietario))
				.sort((a, b) => b.creada.localeCompare(a.creada))
				.slice(0, limite)
				.map(clone);
		},
		async borrar(id) {
			runs.delete(id);
		}
	};
}

/**
 * Una cola en el mismo proceso, con `concurrencia` trabajos a la vez. Un
 * trabajo que falla no detiene la cola (el agente ya guardó el error en la
 * corrida). `vacia()` espera a que no quede nada: para pruebas.
 */
export function inProcessRunner(options: { concurrencia?: number } = {}): ImportRunner & { vacia(): Promise<void>; readonly pendientes: number } {
	const limit = Math.max(1, options.concurrencia ?? 2);
	const queue: ImportJob[] = [];
	let running = 0;
	let procesar: ((t: ImportJob) => Promise<void>) | null = null;
	let waiters: (() => void)[] = [];

	const pump = () => {
		while (procesar && running < limit && queue.length) {
			const job = queue.shift()!;
			running++;
			procesar(job)
				.catch((error) => console.error('importAgent: falló un trabajo', job, error))
				.finally(() => {
					running--;
					pump();
				});
		}
		if (running === 0 && queue.length === 0) {
			const done = waiters;
			waiters = [];
			for (const w of done) w();
		}
	};

	return {
		get pendientes() {
			return queue.length + running;
		},
		iniciar(fn) {
			procesar = fn;
			pump();
		},
		encolar(job) {
			queue.push(job);
			// En la siguiente vuelta: quien encola termina de responder antes de que empiece.
			setImmediate(pump);
		},
		vacia() {
			if (running === 0 && queue.length === 0) return Promise.resolve();
			return new Promise((resolve) => waiters.push(resolve));
		}
	};
}
