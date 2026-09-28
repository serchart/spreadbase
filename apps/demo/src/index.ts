/**
 * App demo de SpreadBase: la hoja de 50 000 casos sintéticos.
 *
 * Es lo mínimo que escribe quien usa la librería: el esquema, la semilla y dos
 * rutas de pruebas (reset / mutate, solo existen en la demo). El resto lo pone
 * `@spreadbase/server`: catálogos, lectura por tramos, localizar fila y lote.
 */
import cors from 'cors';
import express from 'express';

import { defineSheet } from '@spreadbase/core';
import { AGENTS, HANDLERS, STAGES, generateCases, SEED } from './store.seed.ts';
import { simulatedLatency } from './latency.ts';
import { errorHandler, notFoundHandler, SheetEngine, spreadBase } from '@spreadbase/server';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';
const SIZE = Number(process.env.DEMO_ROWS ?? 50_000);
const LATENCY = Number(process.env.DEMO_LATENCY_MS ?? 150);

const sheet = defineSheet({
	id: 'demo_cases',
	idField: 'id',
	fields: {
		id: { kind: 'text', label: 'ID', readOnly: true },
		customer_name: { kind: 'text', label: 'Cliente', required: true, maxLength: 200 },
		customer_rfc: { kind: 'text', label: 'RFC', required: true },
		stage_code: {
			kind: 'enum',
			label: 'Etapa',
			required: true,
			options: STAGES.map((s) => ({ value: s.code, label: s.name }))
		},
		handler_id: {
			kind: 'enum',
			label: 'Atiende',
			options: HANDLERS.map((h) => ({ value: h.id, label: h.name }))
		},
		dpd: { kind: 'number', label: 'DPD', readOnly: true },
		overdue_amount: { kind: 'number', label: 'Vencido', readOnly: true },
		total_amount: { kind: 'number', label: 'Exposición', readOnly: true },
		charges_overdue: { kind: 'number', label: 'Cargos', readOnly: true },
		contracts: { kind: 'number', label: 'Contratos', readOnly: true },
		promise_amount: { kind: 'number', label: 'Promesa', min: 0 },
		promise_date: { kind: 'date', label: 'Fecha promesa' },
		last_contact_at: { kind: 'date', label: 'Últ. contacto' }
	}
});

const engine = new SheetEngine(sheet, generateCases(SIZE) as unknown as import('@spreadbase/server').Row[], {
	policy: (process.env.SANDBOX_REMOTE_CHANGES ?? 'merge') as 'merge' | 'strict',
	newId: (i) => `case_${String(i).padStart(6, '0')}`
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(simulatedLatency(LATENCY));
app.use(
	cors({
		origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((o) => o.trim())
	})
);

// Solo pruebas: reiniciar la semilla y simular a otro usuario.
app.post('/api/sandbox/dev/reset', (_req, res) => {
	engine.replaceRows(generateCases(SIZE) as unknown as import("@spreadbase/server").Row[], SIZE + 1);
	res.json({ rows: engine.total });
});
app.post('/api/sandbox/dev/mutate', (req, res) => {
	const allowed = new Set(['stage_code', 'handler_id', 'customer_name']);
	const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
	const wanted: string[] = Array.isArray(req.body?.fields) ? req.body.fields : ['stage_code', 'handler_id'];
	for (const f of wanted) {
		if (!allowed.has(f)) throw Object.assign(new Error(`field desconocido: ${f}`), { status: 400 });
	}
	const mutated = ids.map((id) => {
		const row = engine.byIdOrThrow(id);
		const fields: [string, unknown][] = [];
		if (wanted.includes('stage_code')) {
			const others = STAGES.filter((s) => s.code !== row.stage_code);
			fields.push(['stage_code', others[Math.floor(Math.random() * others.length)].code]);
		}
		if (wanted.includes('handler_id')) {
			const others = HANDLERS.filter((h) => h.id !== row.handler_id);
			fields.push(['handler_id', others[Math.floor(Math.random() * others.length)].id]);
		}
		if (wanted.includes('customer_name')) {
			fields.push(['customer_name', `${row.customer_name} · editado por otro`]);
		}
		engine.mutateDirectly(id, fields);
		return { id, rowVersion: engine.byIdOrThrow(id).rowVersion, fields: wanted };
	});
	res.json({ mutated });
});

app.use('/api/sandbox/cases', spreadBase(engine));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api', notFoundHandler);
app.use(errorHandler);

app.listen(PORT, HOST, () => {
	console.log(`demo en http://localhost:${PORT} · sheet demo_cases · ${SIZE.toLocaleString()} filas, latencia ${LATENCY} ms`);
});

export { SEED, engine };
