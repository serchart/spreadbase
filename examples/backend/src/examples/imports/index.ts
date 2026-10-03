/**
 * Ejemplo de importación (SB-34): un formato «Contactos» que escribe en la hoja
 * del ejemplo básico. Montado en /api/imports.
 *
 * El formato declara columnas como una hoja —tipos, reglas, catálogo— más de
 * dónde sale cada dato: del archivo, del formulario o de cualquiera de los dos.
 * La app solo escribe `review` (qué haría) y `apply` (hacerlo); leer el archivo,
 * emparejar encabezados, la vista previa editable y validar es de SpreadBase.
 */
import { Router } from 'express';
import { importFormat, importRoutes, types } from '@spreadbase/server';
import type { ImportRow } from '@spreadbase/server';
import { contactsSource } from '../basic/index.ts';

const STATUS = [
	{ value: 'lead', label: 'Prospecto' },
	{ value: 'active', label: 'Activo' },
	{ value: 'inactive', label: 'Inactivo' }
];

/** Los contactos que ya existen, por correo (la llave). */
const byEmail = () => new Map(contactsSource.all().map((r) => [String(r.email).toLowerCase(), r]));

const contactos = importFormat({
	id: 'contactos',
	label: 'Contactos',
	description: 'Contactos a la hoja del ejemplo básico: se crean o se actualizan por su correo.',
	key: 'email',
	columns: {
		name: { type: types.TEXT, label: 'Nombre', required: true, maxLength: 120, aliases: ['Nombre completo', 'Contacto'] },
		email: {
			type: types.TEXT,
			label: 'Correo',
			required: true,
			pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
			patternMessage: 'Debe ser un correo válido',
			aliases: ['Email', 'E-mail']
		},
		credit_limit: { type: types.NUMBER, label: 'Límite de crédito', min: 0, precision: 2, prefix: '$', aliases: ['Límite'] },
		since: { type: types.DATE, label: 'Cliente desde', aliases: ['Alta'] },
		// Del archivo si trae la columna; si no, se elige una vez en el formulario.
		status: { type: types.SELECT, label: 'Estado', required: true, options: STATUS, from: 'either', aliases: ['Estatus'], defaultValue: 'lead' }
	},
	review(rows) {
		const existing = byEmail();
		const updates = rows.filter((r) => existing.has(String(r.email).toLowerCase())).length;
		return { summary: { crear: rows.length - updates, actualizar: updates } };
	},
	apply(rows: ImportRow[]) {
		const existing = byEmail();
		let created = 0;
		let updated = 0;
		for (const r of rows) {
			const pick = (f: string) => r[f] ?? null;
			const values = { name: pick('name'), email: pick('email'), status: pick('status'), credit_limit: pick('credit_limit'), since: pick('since') };
			const current = existing.get(String(r.email).toLowerCase());
			if (current) {
				contactsSource.update(String(current.id), values);
				updated++;
			} else {
				contactsSource.insert(values);
				created++;
			}
		}
		return { summary: { creados: created, actualizados: updated } };
	}
});

export function createImportsExample(): Router {
	return importRoutes([contactos]);
}
