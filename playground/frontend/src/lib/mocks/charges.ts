/**
 * Mock data del ledger `contract_charges` y de las fuentes externas que
 * consumen los selectores remotos.
 *
 * Contraparte real prevista en un backend:
 *   GET    /api/v1/charges            → loadCharges()
 *   POST   /api/v1/charges/batch      → saveCharges(changeSet)
 *   GET    /api/v1/customers/search   → searchCustomers(query)
 *
 * Mientras no exista el backend, estas funciones simulan latencia de red y
 * mantienen el estado en memoria para que el ciclo completo (editar →
 * guardar → recargar) se comporte como el definitivo.
 */

import type { ChangeSet, Option } from '@spreadbase/client';

export interface ChargeRecord {
	id: string;
	customer_id: string;
	kind: string;
	status: string;
	serie: string;
	folio: string;
	uuid_fiscal: string | null;
	due_date: string;
	amount: number;
	paid_amount: number;
	installment_number: number | null;
	last_seen_corte: string | null;
	synced_at: string | null;
	evidence_url: string | null;
	portal_password: string | null;
	notes: string | null;
}

// --- catálogos -------------------------------------------------------------

export const CHARGE_KINDS: Option[] = [
	{ value: 'pactado', label: 'Parcialidad pactada' },
	{ value: 'interes_moratorio', label: 'Interés moratorio' },
	{ value: 'cargo', label: 'Cargo extraordinario' },
	{ value: 'ajuste', label: 'Ajuste' }
];

export const CHARGE_STATUSES: Option[] = [
	{ value: 'chg_programado', label: 'Programado' },
	{ value: 'chg_vigente', label: 'Vigente' },
	{ value: 'chg_vencido', label: 'Vencido' },
	{ value: 'chg_parcial', label: 'Pago parcial' },
	{ value: 'chg_pagado', label: 'Pagado' },
	{ value: 'chg_pagado_presunto', label: 'Pagado presunto' },
	{ value: 'chg_cancelado', label: 'Cancelado' },
	{ value: 'chg_reestructurado', label: 'Reestructurado' }
];

/** Simula el catálogo de clientes que en producción vive en Postgres. */
const CUSTOMERS: Option[] = [
	{ value: 'CU-0101', label: 'Transportes del Norte SA de CV' },
	{ value: 'CU-0102', label: 'Logística Peninsular SA' },
	{ value: 'CU-0103', label: 'Autolíneas del Bajío SC' },
	{ value: 'CU-0104', label: 'Fletes Monterrey SA de CV' },
	{ value: 'CU-0105', label: 'Grupo Carretero Santa Fe' },
	{ value: 'CU-0106', label: 'Remolques y Cajas del Golfo' },
	{ value: 'CU-0107', label: 'Distribuidora Sierra Madre' },
	{ value: 'CU-0108', label: 'Transportadora Occidente SA' },
	{ value: 'CU-0109', label: 'Servicios Logísticos Anáhuac' },
	{ value: 'CU-0110', label: 'Acarreos y Mudanzas del Centro' },
	{ value: 'CU-0111', label: 'Comercializadora Ruta 57' },
	{ value: 'CU-0112', label: 'Arrendadora Vial del Pacífico' }
];

/** Etiquetas precargadas para que los valores ya guardados se vean legibles. */
export const CUSTOMER_LABELS: [string, string][] = CUSTOMERS.map((c) => [c.value, c.label]);

// --- almacén en memoria ----------------------------------------------------

const SEED: ChargeRecord[] = [
	{
		id: 'CHG-1001',
		customer_id: 'CU-0101',
		kind: 'pactado',
		status: 'chg_vencido',
		serie: 'A',
		folio: '59199',
		uuid_fiscal: 'a1b2c3d4-0001-4aaa-9bbb-000000000001',
		due_date: '2026-06-15',
		amount: 35000,
		paid_amount: 0,
		installment_number: 14,
		last_seen_corte: '2026-07-29',
		synced_at: '2026-07-29 06:15',
		evidence_url: null,
		portal_password: null,
		notes: 'Cliente pidió refactura con nuevo domicilio fiscal.'
	},
	{
		id: 'CHG-1002',
		customer_id: 'CU-0101',
		kind: 'interes_moratorio',
		status: 'chg_vencido',
		serie: 'A',
		folio: '59862',
		uuid_fiscal: 'a1b2c3d4-0002-4aaa-9bbb-000000000002',
		due_date: '2026-07-01',
		amount: 2835.12,
		paid_amount: 0,
		installment_number: null,
		last_seen_corte: '2026-07-29',
		synced_at: '2026-07-29 06:15',
		evidence_url: null,
		portal_password: null,
		notes: 'Moratorio de la factura A-57608.'
	},
	{
		id: 'CHG-1003',
		customer_id: 'CU-0102',
		kind: 'pactado',
		status: 'chg_parcial',
		serie: 'A',
		folio: '60110',
		uuid_fiscal: 'a1b2c3d4-0003-4aaa-9bbb-000000000003',
		due_date: '2026-07-10',
		amount: 50000,
		paid_amount: 16800,
		installment_number: 7,
		last_seen_corte: '2026-07-29',
		synced_at: '2026-07-29 06:15',
		evidence_url: 'https://picsum.photos/seed/comprobante1/200/140',
		portal_password: null,
		notes: 'Abono por transferencia el 22/07.'
	},
	{
		id: 'CHG-1004',
		customer_id: 'CU-0103',
		kind: 'pactado',
		status: 'chg_vigente',
		serie: 'A',
		folio: '60244',
		uuid_fiscal: null,
		due_date: '2026-08-20',
		amount: 78000,
		paid_amount: 0,
		installment_number: 3,
		last_seen_corte: null,
		synced_at: null,
		evidence_url: null,
		portal_password: null,
		notes: 'Aún no facturada por el sistema externo.'
	},
	{
		id: 'CHG-1005',
		customer_id: 'CU-0104',
		kind: 'cargo',
		status: 'chg_pagado_presunto',
		serie: 'A',
		folio: '58991',
		uuid_fiscal: 'a1b2c3d4-0005-4aaa-9bbb-000000000005',
		due_date: '2026-05-30',
		amount: 12400,
		paid_amount: 0,
		installment_number: null,
		last_seen_corte: '2026-07-15',
		synced_at: '2026-07-16 06:15',
		evidence_url: null,
		portal_password: null,
		notes: 'Desapareció del corte sin pago que lo respalde.'
	},
	{
		id: 'CHG-1006',
		customer_id: 'CU-0106',
		kind: 'interes_moratorio',
		status: 'chg_vencido',
		serie: 'B',
		folio: '61002',
		uuid_fiscal: 'a1b2c3d4-0006-4aaa-9bbb-000000000006',
		due_date: '2026-07-05',
		amount: 5983.4,
		paid_amount: 0,
		installment_number: null,
		last_seen_corte: '2026-07-29',
		synced_at: '2026-07-29 06:15',
		evidence_url: 'https://picsum.photos/seed/comprobante2/200/140',
		portal_password: null,
		notes: null
	},
	{
		id: 'CHG-1007',
		customer_id: 'CU-0109',
		kind: 'pactado',
		status: 'chg_programado',
		serie: 'A',
		folio: '60890',
		uuid_fiscal: null,
		due_date: '2026-09-15',
		amount: 42150.75,
		paid_amount: 0,
		installment_number: 1,
		last_seen_corte: null,
		synced_at: null,
		evidence_url: null,
		portal_password: null,
		notes: null
	}
];

let store: ChargeRecord[] = structuredClone(SEED);
let sequence = 2000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- operaciones -----------------------------------------------------------

export async function loadCharges(): Promise<Record<string, unknown>[]> {
	await delay(320);
	return structuredClone(store) as unknown as Record<string, unknown>[];
}

export async function saveCharges(changeSet: ChangeSet): Promise<void> {
	await delay(560);

	// Simula una regla de negocio del backend para poder probar el manejo de error.
	const invalid = changeSet.creates.find((row) => !row.customer_id);
	if (invalid) throw new Error('El backend rechazó una fila nueva sin cliente asignado.');

	for (const row of changeSet.creates) {
		store.push({
			...(row as unknown as ChargeRecord),
			id: `CHG-${++sequence}`
		});
	}

	for (const update of changeSet.updates) {
		const target = store.find((r) => r.id === update.id);
		if (target) Object.assign(target, update.changes);
	}

	const deletedIds = new Set(changeSet.deletes.map((d) => d.id));
	store = store.filter((r) => !deletedIds.has(r.id));

	console.info('[mock] changeset aplicado', {
		creates: changeSet.creates.length,
		updates: changeSet.updates.length,
		deletes: changeSet.deletes.length
	});
}

/** Contraparte de `GET /api/v1/customers/search?q=`. */
export async function searchCustomers(query: string): Promise<Option[]> {
	await delay(220);
	const q = query.trim().toLowerCase();
	const matches = q
		? CUSTOMERS.filter((c) => c.label.toLowerCase().includes(q) || c.value.toLowerCase().includes(q))
		: CUSTOMERS;
	return matches.slice(0, 8);
}

/**
 * Sustituye el almacén por `count` registros sintéticos.
 *
 * Existe para el banco de rendimiento del `07-anexo-datagrid-engine.md` §9: sin
 * un dataset del tamaño del escenario crítico, el presupuesto de rendimiento no
 * es verificable y queda en promesa.
 *
 * Los valores se derivan de la semilla con variación determinista —no aleatoria—
 * para que dos ejecuciones sean comparables entre sí. Una medición que cambia de
 * datos en cada intento no sirve para detectar una regresión.
 */
export function seedSyntheticCharges(count: number): void {
	const rows: ChargeRecord[] = new Array(count);
	for (let i = 0; i < count; i++) {
		const base = SEED[i % SEED.length];
		const n = 100000 + i;
		rows[i] = {
			...base,
			id: `CHG-${n}`,
			folio: String(60000 + i),
			// El día se reparte en el mes para que los filtros por fecha no vean
			// un único valor repetido, que sería un caso irrealmente favorable.
			due_date: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
			amount: Math.round((1000 + (i % 9000) + (i % 97) / 100) * 100) / 100,
			uuid_fiscal: `a1b2c3d4-${String(i % 10000).padStart(4, '0')}-4aaa-9bbb-${String(i).padStart(12, '0')}`,
			notes: i % 7 === 0 ? `Nota sintética ${i}` : null
		};
	}
	store = rows;
	sequence = 100000 + count;
}

/** Restablece el almacén al estado original (útil desde el playground). */
export function resetChargesStore(): void {
	store = structuredClone(SEED);
	sequence = 2000;
}
