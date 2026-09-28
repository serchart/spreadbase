import type { CaseRow, FieldName, FieldSpec } from './sandbox.types.ts';

/*
	Generador determinista, el mismo del mock del frontend
	(`frontend/src/lib/mocks/cases.ts`): mismas etapas, responsables,
	distribución de DPD y forma de nombres y RFC. Con semilla fija, cada arranque
	produce exactamente las mismas filas: se puede reportar «la fila case_031415
	se ve mal» y cualquiera la encuentra igual.
*/

export const STAGES = [
	{ code: 'pre_due', name: 'Preventiva', dpdFrom: -7, dpdTo: 0 },
	{ code: 'early', name: 'Mora temprana', dpdFrom: 1, dpdTo: 30 },
	{ code: 'late', name: 'Mora tardía', dpdFrom: 31, dpdTo: 60 },
	{ code: 'extrajudicial', name: 'Extrajudicial', dpdFrom: 61, dpdTo: 90 },
	{ code: 'judicial', name: 'Judicial', dpdFrom: 91, dpdTo: null }
] as const;

export const USERS = [
	{ id: 'usr_mock_1', name: 'Karina Gloria' },
	{ id: 'usr_2', name: 'Ricardo Alanís' },
	{ id: 'usr_3', name: 'Mónica Treviño' },
	{ id: 'usr_4', name: 'Javier Sepúlveda' },
	{ id: 'usr_5', name: 'Diana Cantú' }
] as const;

export const AGENTS = [
	{ id: 'agt_1', name: 'Aggy · Preventivo' },
	{ id: 'agt_2', name: 'Aggy · Cobranza' },
	{ id: 'agt_3', name: 'Aggy · Negociador' }
] as const;

export const HANDLERS = [...AGENTS, ...USERS];

/** Esquema de columnas: tipo, nulabilidad y si el cliente puede editarla. */
export const FIELDS: Record<FieldName, FieldSpec> = {
	id: { kind: 'id', nullable: false, editable: false },
	customer_name: { kind: 'text', nullable: false, editable: true },
	customer_rfc: { kind: 'text', nullable: false, editable: true },
	stage_code: { kind: 'enum', nullable: false, editable: true, values: STAGES.map((s) => s.code) },
	handler_id: { kind: 'enum', nullable: true, editable: true, values: HANDLERS.map((h) => h.id) },
	dpd: { kind: 'number', nullable: false, editable: false },
	overdue_amount: { kind: 'number', nullable: false, editable: false },
	total_amount: { kind: 'number', nullable: false, editable: false },
	charges_overdue: { kind: 'number', nullable: false, editable: false },
	contracts: { kind: 'number', nullable: false, editable: false },
	promise_amount: { kind: 'number', nullable: true, editable: true },
	promise_date: { kind: 'date', nullable: true, editable: true },
	last_contact_at: { kind: 'date', nullable: true, editable: true }
};

const PREFIXES = [
	'Transportes', 'Logística', 'Fletes', 'Autotransportes', 'Grúas', 'Materiales',
	'Constructora', 'Arrendadora', 'Distribuidora', 'Maquinaria', 'Servicios Industriales',
	'Refacciones'
];
const SUFFIXES = [
	'del Norte', 'del Bajío', 'Monterrey', 'Regiomontana', 'Peninsular', 'de Occidente',
	'Saltillo', 'La Laguna', 'Apodaca', 'Santa Catarina', 'del Golfo', 'García'
];
const LEGAL = ['SA de CV', 'S de RL de CV', 'SAPI de CV'];

/** Fecha de referencia fija: con `new Date()` los datos cambiarían cada día. */
export const REFERENCE_DATE = Date.UTC(2026, 8, 26);

export function mulberry32(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export type Random = ReturnType<typeof mulberry32>;

export const pick = <T>(rand: Random, list: readonly T[]): T =>
	list[Math.floor(rand() * list.length)]!;

export const between = (rand: Random, min: number, max: number) =>
	min + Math.floor(rand() * (max - min + 1));

/** Fecha ISO (`YYYY-MM-DD`) desplazada respecto a la de referencia. */
export function dateOffset(days: number): string {
	return new Date(REFERENCE_DATE + days * 86_400_000).toISOString().slice(0, 10);
}

export function stageForDpd(dpd: number): string {
	const stage = STAGES.find((s) => dpd >= s.dpdFrom && (s.dpdTo === null || dpd <= s.dpdTo));
	return (stage ?? STAGES[0]).code;
}

function rfcFor(rand: Random, name: string, index: number): string {
	const letters = name
		.replace(/[^A-Za-zÁÉÍÓÚÑ ]/g, '')
		.split(' ')
		.map((w) => w[0] ?? '')
		.join('')
		.toUpperCase()
		.padEnd(3, 'X')
		.slice(0, 3);
	const year = 80 + (index % 20);
	return `${letters}${year}${String(between(rand, 1, 12)).padStart(2, '0')}${between(rand, 10, 28)}`;
}

export const idFor = (index: number) => `case_${String(index).padStart(6, '0')}`;

function makeCase(rand: Random, index: number): CaseRow {
	const name = `${pick(rand, PREFIXES)} ${pick(rand, SUFFIXES)} ${pick(rand, LEGAL)}`;

	// Sesgada hacia la mora temprana, como una cartera real.
	const roll = rand();
	const dpd =
		roll < 0.18 ? between(rand, -7, 0)
		: roll < 0.5 ? between(rand, 1, 30)
		: roll < 0.74 ? between(rand, 31, 60)
		: roll < 0.9 ? between(rand, 61, 90)
		: between(rand, 91, 260);

	const overdue = dpd <= 0 ? 0 : between(rand, 3, 480) * 1000 + between(rand, 0, 99) * 10;
	const notYetDue = between(rand, 0, 6) * 25_000;
	const byAgent = rand() < 0.42;
	const hasPromise = dpd > 0 && rand() < 0.3;

	return {
		id: idFor(index),
		customer_name: name,
		customer_rfc: rfcFor(rand, name, index),
		stage_code: stageForDpd(dpd),
		handler_id: byAgent ? pick(rand, AGENTS).id : pick(rand, USERS).id,
		dpd,
		overdue_amount: overdue,
		total_amount: overdue + notYetDue,
		charges_overdue: dpd <= 0 ? 0 : between(rand, 1, 14),
		contracts: between(rand, 1, 5),
		promise_amount: hasPromise ? Math.round(overdue * (0.2 + rand() * 0.8)) : null,
		promise_date: hasPromise ? dateOffset(between(rand, -10, 20)) : null,
		last_contact_at: rand() < 0.08 ? null : dateOffset(-between(rand, 0, 40)),
		rowVersion: 1,
		updated_at: new Date(REFERENCE_DATE).toISOString()
	};
}

export const SEED = 20260926;

export function generateCases(count: number): CaseRow[] {
	const rand = mulberry32(SEED);
	return Array.from({ length: count }, (_, i) => makeCase(rand, i + 1));
}
