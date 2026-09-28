/**
 * Concurrencia entre dos usuarios, los dos en el navegador (tests/grid/README.md §4).
 * «Chrome A» y «Chrome B» son dos contextos: cada uno con su IndexedDB.
 * Salvo que se diga, B guarda primero y A guarda después.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { browserHarness } from '../support/browser.ts';
import { FRONT_URL } from '../support/env.ts';
import { GridPage } from '../support/grid.ts';
import { getCase, policy, reset } from '../protocol/support.ts';

const { user } = browserHarness();

beforeEach(async () => {
	await reset();
});

/** Abre la hoja remota para un usuario. */
async function open(name: string) {
	const u = await user(name);
	const grid = await new GridPage(u.page).open(`${FRONT_URL}/`);
	return { ...u, grid };
}

/** B edita y guarda; deja el diálogo cerrado. */
async function saveOk(grid: GridPage) {
	expect(await grid.save()).toContain('Cambios guardados');
	await grid.closeDialog();
}

describe('mismo campo, valores distintos (C-1, C-2)', () => {
	it('A se queda con lo suyo: «Mío»', async () => {
		const A = await open('A');
		const B = await open('B');
		await A.grid.editText('case_000001', 'Cliente', 'A SA');
		await B.grid.editText('case_000001', 'Cliente', 'B SA');
		await saveOk(B.grid);

		const text = await A.grid.save();
		expect(text).toContain('Guardado con conflictos');
		const row = A.grid.rowById('case_000001');
		expect(await A.grid.state(row, 'Cliente')).toContain('oc-cell-conflict');
		await A.shot('conflicto');

		await A.grid.reviewConflicts();
		await A.grid.expand('case_000001');
		const card = A.grid.panelRow('case_000001');
		await expect.poll(() => card.innerText()).toContain('Tú y otro usuario cambiaron los mismos campos.');
		expect(await card.innerText()).toMatch(/mío\s*A SA/i);
		expect(await card.innerText()).toMatch(/remoto\s*B SA/i);

		await A.grid.chooseField('case_000001', 'Cliente', 'Mío');
		await saveOk(A.grid);
		expect((await getCase('case_000001')).customer_name).toBe('A SA');
	});

	it('A acepta lo de B: «Remoto»', async () => {
		const A = await open('A');
		const B = await open('B');
		await A.grid.editText('case_000001', 'Cliente', 'A SA');
		await B.grid.editText('case_000001', 'Cliente', 'B SA');
		await saveOk(B.grid);

		expect(await A.grid.save()).toContain('Guardado con conflictos');
		await A.grid.reviewConflicts();
		await A.grid.expand('case_000001');
		await A.grid.chooseField('case_000001', 'Cliente', 'Remoto');

		const row = A.grid.rowById('case_000001');
		await expect.poll(() => A.grid.text(row, 'Cliente')).toBe('B SA');
		const state = await A.grid.state(row, 'Cliente');
		expect(state).not.toContain('oc-cell-conflict');
		expect(state).not.toContain('oc-cell-dirty');
		const server = await getCase('case_000001');
		expect(server).toMatchObject({ customer_name: 'B SA', rowVersion: 2 });
	});
});

const HANDLERS: Record<string, string> = { usr_2: 'Ricardo Alanís', usr_3: 'Mónica Treviño' };

/** Un responsable distinto del actual de la fila. */
async function otherHandler(id: string): Promise<string> {
	const current = (await getCase(id)).handler_id;
	return current === 'usr_2' ? 'usr_3' : 'usr_2';
}

/** Posición en la hoja de `case_00000n` sin filas nuevas: n − 1. */
const y = (id: string) => Number(id.slice(5)) - 1;

describe('campos distintos (C-3)', () => {
	it('con merge se combinan: se guarda lo de A, se conserva lo de B y se avisa', async (ctx) => {
		if ((await policy()) !== 'merge') ctx.skip();
		const A = await open('A');
		const B = await open('B');
		await A.grid.editText('case_000001', 'Cliente', 'A SA');
		await B.grid.editText('case_000001', 'RFC', 'BBB900101');
		await saveOk(B.grid);

		const text = await A.grid.save();
		expect(text).toContain('Cambios guardados');
		expect(text).toContain('Una fila se combinó con cambios de otro usuario');
		expect(text).toMatch(/Fila 1\s*RFC: BBB900101/);
		await A.grid.closeDialog();

		// Al cerrar el modal, la celda que cambió B se resalta.
		const row = A.grid.rowById('case_000001');
		await expect.poll(() => A.grid.state(row, 'RFC')).toContain('oc-cell-merged');
		expect(await A.grid.text(row, 'RFC')).toBe('BBB900101');
		expect(await getCase('case_000001')).toMatchObject({ customer_name: 'A SA', customer_rfc: 'BBB900101' });
	});
});

describe('eliminar lo que otro editó (C-6, G-16)', () => {
	it('«Eliminar de todos modos» la borra', async () => {
		const A = await open('A');
		const B = await open('B');
		await A.grid.deleteRow('case_000007');
		expect(await A.grid.state(A.grid.rowById('case_000007'), 'Cliente')).toContain('oc-row-deleted');
		await B.grid.editText('case_000007', 'Cliente', 'B SA');
		await saveOk(B.grid);

		expect(await A.grid.save()).toContain('Guardado con conflictos');
		await A.grid.reviewConflicts();
		await A.grid.expand('case_000007');
		await expect.poll(() => A.grid.panelRow('case_000007').innerText()).toContain(
			'Otro usuario editó esta fila mientras la eliminabas.'
		);
		await A.grid.resolveRow('case_000007', 'Eliminar de todos modos');
		expect(await A.grid.save()).toContain('Cambios guardados');
		expect((await getCase('case_000007')).error.code).toBe('not_found');
	});

	it('«Cancelar eliminación» la conserva con lo de B', async () => {
		const A = await open('A');
		const B = await open('B');
		await A.grid.deleteRow('case_000007');
		await B.grid.editText('case_000007', 'Cliente', 'B SA');
		await saveOk(B.grid);

		expect(await A.grid.save()).toContain('Guardado con conflictos');
		await A.grid.reviewConflicts();
		await A.grid.expand('case_000007');
		await A.grid.resolveRow('case_000007', 'Cancelar eliminación');

		const row = A.grid.rowById('case_000007');
		await expect.poll(() => A.grid.text(row, 'Cliente')).toBe('B SA');
		expect(await A.grid.state(row, 'Cliente')).not.toContain('oc-row-deleted');
		expect(await getCase('case_000007')).toMatchObject({ customer_name: 'B SA', rowVersion: 2 });
	});
});

describe('editar lo que otro eliminó (C-7)', () => {
	it('«Recrear como nueva» la vuelve a crear con lo de A', async () => {
		const A = await open('A');
		const B = await open('B');
		await A.grid.editText('case_000020', 'Cliente', 'A SA');
		await B.grid.deleteRow('case_000020');
		await saveOk(B.grid);

		expect(await A.grid.save()).toContain('Guardado con conflictos');
		await A.grid.reviewConflicts();
		await A.grid.expand('case_000020');
		await expect.poll(() => A.grid.panelRow('case_000020').innerText()).toContain('Otro usuario eliminó esta fila.');
		await A.grid.resolveRow('case_000020', 'Recrear como nueva');

		// Vuelve arriba como fila nueva («+»), con los valores de A.
		const created = A.grid.row('+');
		await expect.poll(() => A.grid.text(created, 'Cliente')).toBe('A SA');
		const text = await A.grid.save();
		expect(text).toContain('Cambios guardados');
		expect(text).toMatch(/Filas creadas\s*1/);
		const recreated = await getCase('case_050001');
		expect(recreated).toMatchObject({ customer_name: 'A SA', rowVersion: 1 });
	});

	it('«Descartar mis cambios» la quita de la hoja', async () => {
		const A = await open('A');
		const B = await open('B');
		await A.grid.editText('case_000020', 'Cliente', 'A SA');
		await B.grid.deleteRow('case_000020');
		await saveOk(B.grid);

		expect(await A.grid.save()).toContain('Guardado con conflictos');
		await A.grid.reviewConflicts();
		await A.grid.expand('case_000020');
		await A.grid.resolveRow('case_000020', 'Descartar mis cambios');

		await expect.poll(() => A.grid.rowById('case_000020').count()).toBe(0);
		expect(await A.grid.row('+').count()).toBe(0);
		expect((await getCase('case_000020')).error.code).toBe('not_found');
	});
});

describe('conflicto detectado antes de guardar (C-9)', () => {
	it('al recargar: mismo campo → conflicto; otro campo → se adopta y lo de A sigue pendiente', async () => {
		const A = await open('A');
		const B = await open('B');
		await A.grid.editText('case_000010', 'Cliente', 'A-10');
		await A.grid.editText('case_000012', 'Cliente', 'A-12');
		// Que el borrador de A llegue a IndexedDB antes de recargar.
		await A.page.waitForTimeout(600);

		const handler = await otherHandler('case_000012');
		await B.grid.editText('case_000010', 'Cliente', 'B-10');
		await B.grid.setField(y('case_000012'), 'Atiende', handler);
		await saveOk(B.grid);

		await A.page.reload();
		await A.grid.open(`${FRONT_URL}/`);
		const r10 = A.grid.rowById('case_000010');
		const r12 = A.grid.rowById('case_000012');
		await expect.poll(() => A.grid.state(r10, 'Cliente')).toContain('oc-cell-conflict');
		expect(await A.grid.text(r12, 'Atiende')).toBe(HANDLERS[handler]);
		expect(await A.grid.text(r12, 'Cliente')).toBe('A-12');
		expect(await A.grid.state(r12, 'Cliente')).toContain('oc-cell-dirty');
		await A.shot('reconciliado');
	});
});

describe('lote mixto, éxito parcial (C-11, G-11, G-13)', () => {
	it('lo que no choca se guarda, lo que choca queda pendiente y el scroll no se mueve', async (ctx) => {
		// La fila 3 se combina (A cambia Cliente, B Atiende): solo con `merge`.
		if ((await policy()) !== 'merge') ctx.skip();
		const A = await open('A');
		const B = await open('B');
		await A.grid.editText('case_000003', 'Cliente', 'A-3');
		await A.grid.editText('case_000004', 'Cliente', 'A-4');
		await A.grid.editText('case_000005', 'Cliente', 'A-5');
		await A.grid.deleteRow('case_000007');

		const handler = await otherHandler('case_000003');
		await B.grid.setField(y('case_000003'), 'Atiende', handler);
		await B.grid.editText('case_000004', 'Cliente', 'B-4');
		await B.grid.editText('case_000007', 'Cliente', 'B-7');
		await saveOk(B.grid);

		const scroll = await A.grid.scrollTop();
		const text = await A.grid.save();
		expect(text).toContain('Guardado con conflictos');
		expect(text).toContain('2 filas no se guardaron');
		expect(text).toMatch(/Actualizadas\s*2/);
		expect(text).toMatch(/Fila 3\s*Atiende: /);
		expect(await A.grid.scrollTop()).toBe(scroll);

		expect(await getCase('case_000003')).toMatchObject({ customer_name: 'A-3', handler_id: handler });
		expect(await getCase('case_000005')).toMatchObject({ customer_name: 'A-5' });
		expect(await getCase('case_000004')).toMatchObject({ customer_name: 'B-4' });
		expect(await getCase('case_000007')).toMatchObject({ customer_name: 'B-7' });

		await A.grid.reviewConflicts();
		await expect.poll(() => A.grid.panelRow('case_000004').count()).toBe(1);
		expect(await A.grid.panelRow('case_000007').count()).toBe(1);
		expect(await A.grid.panelRow('case_000003').count()).toBe(0);
	});
});
