import { types } from '@spreadbase/server';

/** Definición de la hoja: lo que valida el servidor y lo que pinta el cliente. */
export const productsSheet = {
	id: 'products',
	idField: 'id',
	allowInsert: true,
	allowDelete: true,
	policy: 'merge',
	columns: {
		id: { type: types.TEXT, label: 'ID', width: 100 },
		name: { type: types.TEXT, label: 'Nombre', required: true, maxLength: 160, searchable: true, width: 240 },
		sku: {
			type: types.TEXT,
			label: 'SKU',
			required: true,
			pattern: '^[A-Z0-9-]{4,20}$',
			patternMessage: 'Mayúsculas, números y guiones (4 a 20)',
			searchable: true,
			width: 120
		},
		price: { type: types.NUMBER, label: 'Precio', required: true, min: 0, precision: 2, prefix: '$', thousands: true, width: 130 },
		stock: { type: types.NUMBER, label: 'Existencias', min: 0, width: 110 },
		status: {
			type: types.SELECT,
			label: 'Estado',
			required: true,
			width: 130,
			options: [
				{ value: 'draft', label: 'Borrador' },
				{ value: 'active', label: 'Activo' },
				{ value: 'paused', label: 'Pausado' }
			]
		}
	}
};
