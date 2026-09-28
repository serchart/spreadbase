import type { BatchInput, BatchResult } from './sandbox.types.ts';

/**
 * Log de depuración del sandbox: qué pidió el cliente y qué se le respondió.
 * Sirve para seguir un conflicto de punta a punta junto al log del navegador.
 * Se apaga con `SANDBOX_LOG=0`.
 */
const enabled = process.env.SANDBOX_LOG !== '0';

const time = () => new Date().toTimeString().slice(0, 8);
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '∅' : JSON.stringify(v));

export function logBatch(input: BatchInput, result: BatchResult, idempotencyKey: string | undefined): void {
	if (!enabled) return;
	const lines = [
		`[batch] ${time()} key=${idempotencyKey?.slice(0, 8) ?? '—'} · ${input.updates.length} edit · ${input.creates.length} alta · ${input.deletes.length} baja`
	];
	for (const u of input.updates) {
		const fields = Object.entries(u.changes)
			.map(([f, c]) => `${f}: ${show(c?.from)} → ${show(c?.to)}`)
			.join(', ');
		lines.push(`  ← edit ${u.id} leída v${u.rowVersion} · ${fields}`);
	}
	for (const c of input.creates) lines.push(`  ← alta ${c.key}`);
	for (const d of input.deletes) lines.push(`  ← baja ${d.id} leída v${d.rowVersion}`);

	for (const r of result.updated) lines.push(`  → aplicada ${r.id} ahora v${r.rowVersion}`);
	for (const c of result.created) lines.push(`  → creada ${c.key} = ${c.row.id}`);
	for (const id of result.deleted) lines.push(`  → eliminada ${id}`);
	for (const n of result.notices) lines.push(`  → aviso ${n.id}: otro cambió ${n.fields.join(', ')}`);
	for (const c of result.conflicts) {
		const detail = c.fields?.map((f) => `${f.field}: leída ${show(f.from)} · tuya ${show(f.yours)} · remota ${show(f.remote)}`).join('; ');
		lines.push(`  → CONFLICTO ${c.op} ${c.id} (${c.reason}${c.remote ? `, remota v${c.remote.rowVersion}` : ''})${detail ? ' · ' + detail : ''}`);
	}
	console.log(lines.join('\n'));
}

export function logMutate(mutated: { id: string; rowVersion: number; fields: string[] }[]): void {
	if (!enabled) return;
	for (const m of mutated) console.log(`[mutate] ${time()} ${m.id} → v${m.rowVersion} · ${m.fields.join(', ')}`);
}
