import { SpreadBase, postgresSource, types } from '@spreadbase/server';
import { ValidationError } from '../../../common/errors.js';
import { usersSheet } from './users.sheet.js';

const COLUMNS = 'id, name, email, avatar';
/** Minúsculas y sin acentos, en SQL; `fold` hace lo mismo en JS. */
const FOLD = (expr) => `translate(lower(${expr}), 'áéíóúüñàèìòù', 'aeiouunaeiou')`;
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Servicio de usuarios.
 * @typedef {import('../../orchestrator/orchestrator.js').default} Orchestrator
 */
class UsersService {
	/** @param {Orchestrator} orchestrator */
	constructor(orchestrator) {
		this.pool = orchestrator.pool;

		/**
		 * Cómo se elige un usuario desde cualquier hoja (SB-21, `03-lookup.md` §3).
		 * Una columna lo usa con `lookup: users.lookup`. La forma del objeto es lo
		 * que exige SpreadBase; que viva aquí es organización de esta app.
		 */
		this.lookup = {
			value: 'id',
			display: 'name',
			columns: {
				avatar: { type: types.IMAGE, label: '', width: 40, shape: 'round' },
				name: { type: types.TEXT, label: 'Nombre', width: 190 },
				email: { type: types.TEXT, label: 'Correo', width: 260 },
				id: { type: types.TEXT, label: 'ID', width: 90 }
			},
			search: (q, page, ctx) => this.search(q, page, ctx),
			byIds: (ids, ctx) => this.byIds(ids, ctx),
			resolve: (texts, ctx) => this.byNames(texts, ctx)
		};

		/**
		 * La hoja de usuarios. Escribe la fuente (sin SQL propio); los handlers solo
		 * traducen el choque del correo único a un error de dominio. La contraseña
		 * les llega ya como hash.
		 */
		const source = postgresSource({ pool: this.pool, table: 'users', createId: () => `usr_${crypto.randomUUID().slice(0, 8)}` });
		this.sheet = new SpreadBase({
			...usersSheet,
			source,
			handlers: {
				insertMany: (items, { tx }) => this.#uniqueEmail(() => sequential(items, (i) => tx.insert(i.values))),
				updateMany: (items, { tx }) => this.#uniqueEmail(() => sequential(items, (i) => tx.update(i.id, i.values)))
			}
		});
	}

	/** El correo es único en la tabla: el choque se explica en vez de un 500. */
	async #uniqueEmail(write) {
		try {
			return await write();
		} catch (error) {
			if (error.code === '23505') throw new ValidationError('Ya existe un usuario con ese correo');
			throw error;
		}
	}

	/**
	 * Búsqueda paginada por nombre o correo, sin distinguir acentos ni mayúsculas.
	 * @param {string} q
	 * @param {{ offset: number, limit: number }} page
	 */
	async search(q, { offset, limit }) {
		const where = q ? `WHERE active AND (${FOLD('name')} LIKE $1 OR ${FOLD('email')} LIKE $1)` : 'WHERE active';
		const params = q ? [`%${fold(q)}%`] : [];
		const n = params.length;
		const [rows, count] = await Promise.all([
			this.pool.query(`SELECT ${COLUMNS} FROM users ${where} ORDER BY name, id LIMIT $${n + 1} OFFSET $${n + 2}`, [...params, limit, offset]),
			this.pool.query(`SELECT count(*)::int AS total FROM users ${where}`, params)
		]);
		return { rows: rows.rows, total: count.rows[0].total };
	}

	/** Los usuarios de estos ids: para pintar nombres y validar al guardar. */
	async byIds(ids) {
		const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM users WHERE id = ANY($1)`, [ids]);
		return rows;
	}

	/** Para pegar: candidatos por nombre (sin acentos) o por id. SpreadBase empareja cada texto. */
	async byNames(texts) {
		const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM users WHERE ${FOLD('name')} = ANY($1) OR id = ANY($2)`, [
			texts.map(fold),
			texts
		]);
		return rows;
	}
}

/** En una transacción, una consulta a la vez. */
async function sequential(items, fn) {
	const out = [];
	for (const item of items) out.push(await fn(item));
	return out;
}

export default UsersService;
