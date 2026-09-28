import { beforeEach, describe, expect, it } from 'vitest';
import { batch, getCase, mutate, policy, reset } from './support.ts';

/**
 * Reglas del lote de guardado (docs/07-anexo-datagrid-engine.md §11.13–§11.14).
 * Cada test lee la fila real, simula a «otro usuario» con `/dev/mutate` o con
 * otro lote, y comprueba lo que responde la API y cómo queda la fila.
 */

beforeEach(async () => {
	await reset();
});

/** Edición de un campo tal como la manda el grid: valor leído y valor nuevo. */
const edit = (row: any, field: string, to: unknown) => ({
	id: row.id,
	rowVersion: row.rowVersion,
	changes: { [field]: { from: row[field], to } }
});

describe('sin cambios ajenos', () => {
	it('aplica la edición y sube la versión', async () => {
		const row = await getCase('case_000001');
		const { status, body } = await batch({ updates: [edit(row, 'customer_name', 'CASA')] });
		expect(status).toBe(200);
		expect(body.updated).toHaveLength(1);
		expect(body.updated[0]).toMatchObject({ id: 'case_000001', customer_name: 'CASA', rowVersion: 2 });
		expect(body.notices).toEqual([]);
		expect(body.conflicts).toEqual([]);
		expect((await getCase('case_000001')).customer_name).toBe('CASA');
	});

	it('crea filas y devuelve la clave temporal junto al id real', async () => {
		const { body } = await batch({
			creates: [{ key: 'tmp_a', values: { customer_name: 'Nueva SA', customer_rfc: 'NSA900101AA', stage_code: 'early' } }]
		});
		expect(body.created).toHaveLength(1);
		expect(body.created[0].key).toBe('tmp_a');
		expect(body.created[0].row).toMatchObject({ id: 'case_050001', customer_name: 'Nueva SA', rowVersion: 1 });
	});

	it('elimina con la versión leída', async () => {
		const row = await getCase('case_000008');
		const { body } = await batch({ deletes: [{ id: row.id, rowVersion: row.rowVersion }] });
		expect(body.deleted).toEqual(['case_000008']);
		expect((await getCase('case_000008')).error.code).toBe('not_found');
	});
});

describe('otro usuario cambió la fila (concurrencia por campo, G-14)', () => {
	it('mismo campo, valores distintos → field_conflict con leído · tuyo · remoto', async () => {
		const mine = await getCase('case_000004');
		await mutate('case_000004', ['customer_name']);
		const remote = await getCase('case_000004');

		const { body } = await batch({ updates: [edit(mine, 'customer_name', 'MIO-4')] });
		expect(body.updated).toEqual([]);
		expect(body.conflicts).toHaveLength(1);
		expect(body.conflicts[0]).toMatchObject({
			op: 'update',
			id: 'case_000004',
			reason: 'field_conflict',
			fields: [{ field: 'customer_name', from: mine.customer_name, yours: 'MIO-4', remote: remote.customer_name }]
		});
		expect(body.conflicts[0].remote.rowVersion).toBe(remote.rowVersion);
		// No se escribió nada.
		expect((await getCase('case_000004')).customer_name).toBe(remote.customer_name);
	});

	it('mismo campo, mismo valor → no es conflicto de campo', async () => {
		const mine = await getCase('case_000005');
		// Otro usuario deja el campo exactamente en el valor que yo quiero.
		const other = await batch({ updates: [edit(mine, 'customer_name', 'IGUAL SA')] });
		expect(other.body.conflicts).toEqual([]);

		const { body } = await batch({ updates: [edit(mine, 'customer_name', 'IGUAL SA')] });
		// Con `strict`, que otro tocara la fila basta para rechazarla, aunque coincidan.
		if ((await policy()) === 'strict') {
			expect(body.conflicts).toMatchObject([{ id: 'case_000005', reason: 'version_mismatch' }]);
			return;
		}
		expect(body.conflicts).toEqual([]);
		expect(body.updated[0]).toMatchObject({ id: 'case_000005', customer_name: 'IGUAL SA' });
		expect((await getCase('case_000005')).customer_name).toBe('IGUAL SA');
	});

	it('campos distintos con política merge → se aplica, se conserva lo ajeno y se avisa', async (ctx) => {
		if ((await policy()) !== 'merge') ctx.skip();
		const mine = await getCase('case_000001');
		await mutate('case_000001', ['handler_id']);
		const remote = await getCase('case_000001');

		const { body } = await batch({ updates: [edit(mine, 'customer_name', 'CASA')] });
		expect(body.conflicts).toEqual([]);
		expect(body.updated[0]).toMatchObject({ customer_name: 'CASA', handler_id: remote.handler_id });
		expect(body.notices).toEqual([{ id: 'case_000001', fields: ['handler_id'] }]);
	});

	it('campos distintos con política strict → version_mismatch', async (ctx) => {
		if ((await policy()) !== 'strict') ctx.skip();
		const mine = await getCase('case_000001');
		await mutate('case_000001', ['handler_id']);
		const { body } = await batch({ updates: [edit(mine, 'customer_name', 'CASA')] });
		expect(body.updated).toEqual([]);
		expect(body.conflicts[0]).toMatchObject({ id: 'case_000001', reason: 'version_mismatch' });
	});

	it('el cambio ajeno puede venir de otro lote, no solo de /dev/mutate', async (ctx) => {
		if ((await policy()) !== 'merge') ctx.skip();
		const readByA = await getCase('case_000001');
		const readByB = await getCase('case_000001');
		await batch({ updates: [edit(readByB, 'customer_rfc', 'PERRO')] });
		const { body } = await batch({ updates: [edit(readByA, 'customer_name', 'CASA')] });
		expect(body.updated[0]).toMatchObject({ customer_name: 'CASA', customer_rfc: 'PERRO', rowVersion: 3 });
		expect(body.notices).toEqual([{ id: 'case_000001', fields: ['customer_rfc'] }]);
	});

	it('los valores se comparan normalizados: 1500 = "1500.00" no es conflicto', async (ctx) => {
		if ((await policy()) !== 'merge') ctx.skip();
		const row = await getCase('case_000002');
		await mutate('case_000002', ['handler_id']); // sube la versión: obliga a comparar por campo
		const { body } = await batch({
			updates: [
				{
					id: row.id,
					rowVersion: row.rowVersion,
					changes: { promise_amount: { from: String(Number(row.promise_amount).toFixed(2)), to: 1234 } }
				}
			]
		});
		expect(body.conflicts).toEqual([]);
		expect(body.updated[0].promise_amount).toBe(1234);
	});
});

describe('bajas', () => {
	it('eliminar una fila que otro editó es siempre conflicto (G-16)', async () => {
		const mine = await getCase('case_000007');
		await mutate('case_000007', ['handler_id']);
		const { body } = await batch({ deletes: [{ id: mine.id, rowVersion: mine.rowVersion }] });
		expect(body.deleted).toEqual([]);
		expect(body.conflicts[0]).toMatchObject({ op: 'delete', id: 'case_000007', reason: 'version_mismatch' });
		expect((await getCase('case_000007')).id).toBe('case_000007');
	});

	it('eliminar algo que otro ya eliminó no es conflicto: se reporta eliminado', async () => {
		const row = await getCase('case_000050');
		await batch({ deletes: [{ id: row.id, rowVersion: row.rowVersion }] });
		const { body } = await batch({ deletes: [{ id: row.id, rowVersion: row.rowVersion }] });
		expect(body.deleted).toEqual(['case_000050']);
		expect(body.conflicts).toEqual([]);
	});

	it('editar una fila que otro eliminó → not_found', async () => {
		const row = await getCase('case_000020');
		await batch({ deletes: [{ id: row.id, rowVersion: row.rowVersion }] });
		const { body } = await batch({ updates: [edit(row, 'customer_name', 'MIA-20')] });
		expect(body.conflicts).toEqual([{ op: 'update', id: 'case_000020', reason: 'not_found', remote: null }]);
	});
});

describe('éxito parcial y lotes inválidos', () => {
	it('un conflicto no bloquea el resto del lote (G-11)', async () => {
		const a = await getCase('case_000003');
		const b = await getCase('case_000004');
		await mutate('case_000004', ['customer_name']);
		const { body } = await batch({
			updates: [edit(a, 'customer_name', 'MIO-3'), edit(b, 'customer_name', 'MIO-4')]
		});
		expect(body.updated.map((r: { id: string }) => r.id)).toEqual(['case_000003']);
		expect(body.conflicts.map((c: { id: string }) => c.id)).toEqual(['case_000004']);
	});

	it('la forma vieja de changes (sin from/to) es 400 y no aplica nada', async () => {
		const { status, body } = await batch({
			updates: [{ id: 'case_000006', rowVersion: 1, changes: { customer_name: 'X' } }]
		});
		expect(status).toBe(400);
		expect(body.error.code).toBe('validation_error');
		expect((await getCase('case_000006')).rowVersion).toBe(1);
	});

	it('un campo de solo lectura es 400', async () => {
		const row = await getCase('case_000006');
		const { status } = await batch({ updates: [edit(row, 'dpd', 999)] });
		expect(status).toBe(400);
	});
});
