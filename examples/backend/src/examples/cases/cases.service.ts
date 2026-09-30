import { SpreadBase, memorySource, types } from '@spreadbase/server';
import type { CellValue, FileStorage, RemoteChangePolicy, Row } from '@spreadbase/server';
import { NotFoundError } from '../../common/errors.ts';
import { HANDLERS, STAGES, generateCases, idFor } from './cases.seed.ts';

/** Campos que `mutate` puede cambiar para simular a otro usuario. */
export const MUTABLE_FIELDS = ['stage_code', 'handler_id', 'customer_name'] as const;
export type MutableField = (typeof MUTABLE_FIELDS)[number];

const money = { precision: 2, prefix: '$', thousands: true } as const;

/**
 * Servicio del módulo de casos. Así se vería en OpenCollect: la hoja es un
 * objeto del servicio, y lo que es de dominio —valores por omisión de una
 * alta, qué puede hacer otro usuario— son métodos del propio servicio.
 */
export class CasesService {
	/** Los datos. En OpenCollect sería la conexión a Postgres; aquí, memoria. */
	private readonly store = memorySource({ rows: [], createId: idFor });

	readonly portfolio: SpreadBase;

	constructor(
		private readonly size: number,
		policy: RemoteChangePolicy,
		files: FileStorage
	) {
		this.portfolio = new SpreadBase({
			id: 'cases.portfolio',
			idField: 'id',
			allowInsert: true,
			allowDelete: true,
			policy,
			columns: {
				id: { type: types.TEXT, label: 'ID', readOnly: true, width: 110 },
				customer_name: {
					type: types.TEXT,
					label: 'Cliente',
					required: true,
					maxLength: 200,
					searchable: true,
					width: 260,
					// Las iniciales de la empresa, con su color (SB-29).
					avatar: { initials: true, shape: 'square' }
				},
				customer_rfc: { type: types.TEXT, label: 'RFC', required: true, maxLength: 200, searchable: true, width: 120 },
				stage_code: {
					type: types.SELECT,
					label: 'Etapa',
					required: true,
					options: STAGES.map((s) => ({ value: s.code, label: s.name })),
					width: 140
				},
				handler_id: {
					type: types.SELECT,
					label: 'Atiende',
					options: HANDLERS.map((h) => ({ value: h.id, label: h.name })),
					width: 180
				},
				// El ledger manda en estas: se leen, no se editan.
				dpd: { type: types.NUMBER, label: 'DPD', readOnly: true, width: 72 },
				overdue_amount: { type: types.NUMBER, label: 'Vencido', readOnly: true, width: 124, ...money },
				total_amount: { type: types.NUMBER, label: 'Exposición', readOnly: true, width: 124, ...money },
				charges_overdue: { type: types.NUMBER, label: 'Cargos', readOnly: true, width: 80 },
				contracts: { type: types.NUMBER, label: 'Contratos', readOnly: true, width: 88 },
				promise_amount: { type: types.NUMBER, label: 'Promesa', min: 0, width: 118, ...money },
				promise_date: { type: types.DATE, label: 'Fecha promesa', width: 126 },
				last_contact_at: { type: types.DATE, label: 'Últ. contacto', width: 122 },
				// Un archivo por caso: se pega su URL o se sube (SB-30).
				contract_file: {
					type: types.FILE,
					label: 'Contrato',
					width: 200,
					upload: { storage: files, maxSize: '2mb', accept: ['application/pdf', 'image/png', 'image/jpeg'] }
				}
			},
			source: this.store,
			handlers: {
				insertMany: (items) => this.insertMany(items)
			}
		});
		this.reset();
	}

	/**
	 * Altas de dominio: un caso nuevo aún no tiene cargos. SpreadBase ya validó
	 * los valores y resolvió la concurrencia; aquí solo queda lo del negocio.
	 */
	private insertMany(items: { values: Record<string, CellValue> }[]): Row[] {
		return items.map(({ values }) =>
			this.store.insert({
				dpd: 0,
				overdue_amount: 0,
				total_amount: 0,
				charges_overdue: 0,
				contracts: 0,
				...values
			})
		);
	}

	// -- utilidades de prueba -------------------------------------------------

	reset(): { rows: number } {
		this.store.reset(generateCases(this.size) as unknown as Record<string, unknown>[]);
		return { rows: this.store.size };
	}

	/**
	 * Simula a otro usuario editando: cambia `count` filas al azar, o las de
	 * `ids`, y sube su versión. Las filas que el cliente tenga pendientes de
	 * guardar entrarán en conflicto o se combinarán al guardar.
	 */
	mutate(count: number, ids?: string[], fields: MutableField[] = ['stage_code', 'handler_id']) {
		const all = this.store.all();
		const targets = ids?.length
			? ids.map((id) => {
					const row = this.store.get(id);
					if (!row) throw new NotFoundError(`No existe la fila ${id}`);
					return row;
				})
			: Array.from({ length: Math.min(count, all.length) }, () => all[Math.floor(Math.random() * all.length)]!);

		const mutated = targets.map((row) => {
			const changes: Record<string, CellValue> = {};
			if (fields.includes('stage_code')) {
				const others = STAGES.filter((s) => s.code !== row.stage_code);
				changes.stage_code = others[Math.floor(Math.random() * others.length)]!.code;
			}
			if (fields.includes('handler_id')) {
				const others = HANDLERS.filter((h) => h.id !== row.handler_id);
				changes.handler_id = others[Math.floor(Math.random() * others.length)]!.id;
			}
			if (fields.includes('customer_name')) {
				changes.customer_name = `${row.customer_name} · editado por otro`;
			}
			const updated = this.store.update(String(row.id), changes);
			return { id: String(row.id), rowVersion: updated.rowVersion, fields };
		});
		return { mutated };
	}
}
