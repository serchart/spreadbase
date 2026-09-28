/**
 * Ejemplo básico de SpreadBase: una hoja de contactos servida por Express.
 *
 * Lo único que escribe quien usa la librería es el dominio: las columnas de
 * la hoja y de dónde salen los datos. Lo demás —lectura por tramos, lote de
 * guardado, concurrencia entre usuarios, idempotencia— lo pone SpreadBase.
 */
import cors from 'cors';
import express from 'express';
import { SpreadBase, errorHandler, memorySource, sheetRouter, types } from '@spreadbase/server';
import { generateContacts } from './contacts.ts';

// 1. La hoja: columnas, reglas y de dónde se leen y escriben los datos.
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
	// En memoria para el ejemplo. En una app real: la fuente de tu base de datos.
	source: memorySource({ rows: generateContacts(1_000), createId: (n) => `c_${String(n).padStart(5, '0')}` })
});

// 2. La app: monta la hoja en una URL. El cliente se conecta con `new Sheet(url)`.
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5280' }));
app.use(express.json({ limit: '10mb' }));
app.use('/api/contacts', sheetRouter(contacts));
app.use(errorHandler);

const port = Number(process.env.PORT ?? 4200);
app.listen(port, () => console.log(`Ejemplo básico: http://localhost:${port}/api/contacts/schema`));
