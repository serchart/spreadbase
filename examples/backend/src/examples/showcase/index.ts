/**
 * La vitrina: 10 000 clientes en memoria con un campo de cada tipo (imagen,
 * texto, select, número con formato, lookup, booleano, fecha y fecha-hora).
 * Montada en /api/showcase. Es la hoja de las capturas del README: no necesita
 * base de datos.
 */
import { Router } from 'express';
import { SpreadBase, memorySource, sheetRouter, types } from '@spreadbase/server';
import { generateCustomers, generateTeam } from './seed.ts';

const team = generateTeam();
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

const customers = new SpreadBase({
	id: 'customers',
	allowInsert: true,
	allowDelete: true,
	columns: {
		avatar: { type: types.IMAGE, label: '', width: 52, shape: 'round', readOnly: true },
		name: { type: types.TEXT, label: 'Customer', required: true, maxLength: 120, width: 190 },
		company: { type: types.TEXT, label: 'Company', width: 150 },
		email: {
			type: types.TEXT,
			label: 'Email',
			required: true,
			pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
			patternMessage: 'Must be a valid email',
			width: 270
		},
		plan: {
			type: types.SELECT,
			label: 'Plan',
			required: true,
			options: [
				{ value: 'free', label: 'Free' },
				{ value: 'starter', label: 'Starter' },
				{ value: 'pro', label: 'Pro' },
				{ value: 'enterprise', label: 'Enterprise' }
			],
			width: 120
		},
		status: {
			type: types.SELECT,
			label: 'Status',
			required: true,
			options: [
				{ value: 'lead', label: 'Lead' },
				{ value: 'trial', label: 'Trial' },
				{ value: 'active', label: 'Active' },
				{ value: 'churned', label: 'Churned' }
			],
			width: 115
		},
		mrr: { type: types.NUMBER, label: 'MRR', min: 0, precision: 2, prefix: '$', thousands: true, width: 120 },
		seats: { type: types.NUMBER, label: 'Seats', min: 1, width: 80 },
		owner_id: {
			type: types.LOOKUP,
			label: 'Account owner',
			width: 180,
			lookup: {
				value: 'id',
				display: 'name',
				columns: {
					avatar: { type: types.IMAGE, label: '', width: 40, shape: 'round' },
					name: { type: types.TEXT, label: 'Name', width: 170 },
					email: { type: types.TEXT, label: 'Email', width: 190 }
				},
				search: async (q, { offset, limit }) => {
					const found = q ? team.filter((m) => fold(`${m.name} ${m.email}`).includes(fold(q))) : team;
					return { rows: found.slice(offset, offset + limit), total: found.length };
				},
				byIds: async (ids) => team.filter((m) => ids.includes(m.id)),
				resolve: async (texts) => team.filter((m) => texts.some((t) => fold(t) === fold(m.name)))
			}
		},
		verified: { type: types.BOOLEAN, label: 'Verified', width: 90 },
		signed_up: { type: types.DATE, label: 'Signed up', width: 120 },
		last_seen: { type: types.DATETIME, label: 'Last seen', width: 160 }
	},
	source: memorySource({ rows: generateCustomers(10_000, team), createId: (n) => `cus_${String(n).padStart(5, '0')}` })
});

export function createShowcaseExample(): Router {
	const router = Router();
	router.use('/customers', sheetRouter(customers));
	return router;
}
