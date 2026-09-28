/**
 * Opciones de las columnas de la hoja remota. Deben coincidir con el catálogo
 * del backend (`backend/src/modules/sandbox/sandbox.seed.ts`), que rechaza
 * cualquier otro valor.
 */
import type { Option } from '$lib/components/datagrid/types';

export const STAGE_OPTIONS: Option[] = [
	{ value: 'pre_due', label: 'Preventiva' },
	{ value: 'early', label: 'Mora temprana' },
	{ value: 'late', label: 'Mora tardía' },
	{ value: 'extrajudicial', label: 'Extrajudicial' },
	{ value: 'judicial', label: 'Judicial' }
];

export const HANDLER_OPTIONS: Option[] = [
	{ value: 'agt_1', label: 'Aggy · Preventivo' },
	{ value: 'agt_2', label: 'Aggy · Cobranza' },
	{ value: 'agt_3', label: 'Aggy · Negociador' },
	{ value: 'usr_mock_1', label: 'Karina Gloria' },
	{ value: 'usr_2', label: 'Ricardo Alanís' },
	{ value: 'usr_3', label: 'Mónica Treviño' },
	{ value: 'usr_4', label: 'Javier Sepúlveda' },
	{ value: 'usr_5', label: 'Diana Cantú' }
];
