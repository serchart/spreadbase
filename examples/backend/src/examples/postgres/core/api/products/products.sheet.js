import { types } from '@spreadbase/server';

/**
 * Definición de la hoja: lo que valida el servidor y lo que pinta el cliente.
 * Un campo de cada tipo.
 *
 * Es una función porque la columna «Responsable» depende de otro módulo: recibe
 * el servicio de usuarios en lugar de importarlo (`03-lookup.md` §3).
 *
 * @param {{ users: import('../users/users.service.js').default }} deps
 */
export const productsSheet = ({ users }) => ({
	id: 'products',
	idField: 'id',
	allowInsert: true,
	allowDelete: true,
	policy: 'merge',
	columns: {
		id: { type: types.TEXT, label: 'ID', width: 100 },
		image_url: { type: types.IMAGE, label: 'Foto', width: 60 },
		name: { type: types.TEXT, label: 'Nombre', required: true, maxLength: 160, searchable: true, width: 220 },
		sku: {
			type: types.TEXT,
			label: 'SKU',
			required: true,
			pattern: '^[A-Z0-9-]{4,20}$',
			patternMessage: 'Mayúsculas, números y guiones (4 a 20)',
			searchable: true,
			width: 110
		},
		owner_id: { type: types.LOOKUP, label: 'Responsable', required: true, width: 180, lookup: users.lookup },
		price: { type: types.NUMBER, label: 'Precio', required: true, min: 0, precision: 2, prefix: '$', thousands: true, width: 120 },
		stock: { type: types.NUMBER, label: 'Existencias', min: 0, width: 100 },
		status: {
			type: types.SELECT,
			label: 'Estado',
			required: true,
			width: 120,
			options: [
				{ value: 'draft', label: 'Borrador' },
				{ value: 'active', label: 'Activo' },
				{ value: 'paused', label: 'Pausado' }
			]
		},
		launch_date: { type: types.DATE, label: 'Lanzamiento', width: 120 },
		restocked_at: { type: types.DATETIME, label: 'Último surtido', width: 150 }
	}
});
