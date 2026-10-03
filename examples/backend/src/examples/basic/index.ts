/**
 * Ejemplo básico: una hoja de contactos en memoria. Montado en /api/basic.
 *
 * Lo único que escribe quien usa la librería es el dominio: las columnas de
 * la hoja y de dónde salen los datos. Lo demás —lectura por tramos, lote de
 * guardado, concurrencia entre usuarios, idempotencia— lo pone SpreadBase.
 */
import { Router } from 'express';
import { SpreadBase, memorySource, sheetRouter, types } from '@spreadbase/server';
import { generateContacts } from './contacts.seed.ts';

// 1. La hoja: columnas, reglas y de dónde se leen y escriben los datos.
//    En memoria para el ejemplo. En una app real: la fuente de tu base de datos.
//    Se exporta para el ejemplo de importación (SB-34), que escribe en ella.
export const contactsSource = memorySource({ rows: generateContacts(1_000), createId: (n) => `c_${String(n).padStart(5, '0')}` });

const contacts = new SpreadBase({
	id: 'contacts',
	allowInsert: true,
	allowDelete: true,
	columns: {
		id: { type: types.TEXT, label: 'ID', width: 90 },
		name: { type: types.TEXT, label: 'Nombre', required: true, maxLength: 120, width: 220 },
		email: {
			type: types.TEXT,
			label: 'Correo',
			required: true,
			pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
			patternMessage: 'Debe ser un correo válido',
			width: 240
		},
		status: {
			type: types.SELECT,
			label: 'Estado',
			required: true,
			options: [
				{ value: 'lead', label: 'Prospecto' },
				{ value: 'active', label: 'Activo' },
				{ value: 'inactive', label: 'Inactivo' }
			],
			width: 130
		},
		credit_limit: { type: types.NUMBER, label: 'Límite de crédito', min: 0, precision: 2, prefix: '$', thousands: true, width: 150 },
		since: { type: types.DATE, label: 'Cliente desde', width: 130 }
	},
	source: contactsSource
});

// 2. Montarla: `sheetRouter` pone las cinco rutas del protocolo.
//    El cliente se conecta con `new Sheet('…/api/basic/contacts')`.
export function createBasicExample(): Router {
	const router = Router();
	router.use('/contacts', sheetRouter(contacts));
	return router;
}
