import { types } from '@spreadbase/server';
import { hashPassword } from '../../../common/passwords.js';

/**
 * La hoja de usuarios: un ejemplo de contraseña (SB-22) y de casilla.
 *
 * - `password_hash` es `PASSWORD`: se escribe en claro y SpreadBase guarda
 *   `hash(plain)`. Nunca sale: al leer viaja una marca opaca.
 * - Desactivar es desmarcar «Activo»: la hoja no borra usuarios (`allowDelete: false`).
 */
export const usersSheet = {
	id: 'users',
	idField: 'id',
	allowInsert: true,
	allowDelete: false,
	policy: 'merge',
	columns: {
		id: { type: types.TEXT, label: 'ID', width: 100 },
		avatar: { type: types.IMAGE, label: '', width: 44, shape: 'round' },
		name: { type: types.TEXT, label: 'Nombre', required: true, maxLength: 120, searchable: true, width: 200 },
		email: {
			type: types.TEXT,
			label: 'Correo',
			required: true,
			pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
			patternMessage: 'Correo inválido',
			searchable: true,
			width: 260
		},
		password_hash: { type: types.PASSWORD, label: 'Contraseña', required: true, minLength: 10, width: 130, hash: hashPassword },
		role: {
			type: types.SELECT,
			label: 'Rol',
			required: true,
			width: 130,
			options: [
				{ value: 'admin', label: 'Administrador' },
				{ value: 'supervisor', label: 'Supervisor' },
				{ value: 'ejecutivo', label: 'Ejecutivo' }
			]
		},
		active: { type: types.BOOLEAN, label: 'Activo', width: 80 }
	}
};
