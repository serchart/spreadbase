import { types } from '@spreadbase/server';

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

export default UsersService;
