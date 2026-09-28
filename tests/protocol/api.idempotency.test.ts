import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from '../support/api.ts';
import { batch, reset } from './support.ts';

/** Idempotency-Key (G-12): reintentar un guardado nunca lo aplica dos veces. */

beforeEach(async () => {
	await reset();
});

const createOne = (name: string) => ({
	creates: [{ key: 'tmp_i', values: { customer_name: name, customer_rfc: 'IDE900101AA', stage_code: 'early' } }]
});
const countByName = async (name: string) =>
	(await api(`/api/cases?search=${encodeURIComponent(name)}`)).body.total;

describe('Idempotency-Key', () => {
	it('el reintento con la misma llave devuelve la misma respuesta y no duplica', async () => {
		const key = randomUUID();
		const first = await batch(createOne('Idem Uno'), key);
		const retry = await batch(createOne('Idem Uno'), key);

		expect(first.status).toBe(200);
		expect(first.headers.get('idempotent-replayed')).toBeNull();
		expect(retry.status).toBe(200);
		expect(retry.headers.get('idempotent-replayed')).toBe('true');
		expect(retry.body).toEqual(first.body);
		expect(await countByName('Idem Uno')).toBe(1);
	});

	it('la misma llave con otro cuerpo es 422', async () => {
		const key = randomUUID();
		await batch(createOne('Idem Dos'), key);
		const reused = await batch(createOne('Otro cuerpo'), key);
		expect(reused.status).toBe(422);
		expect(reused.body.error.code).toBe('idempotency_key_reused');
	});

	it('sin llave, cada envío se aplica', async () => {
		await batch(createOne('Idem Tres'));
		await batch(createOne('Idem Tres'));
		expect(await countByName('Idem Tres')).toBe(2);
	});

	it('llaves distintas son guardados distintos', async () => {
		await batch(createOne('Idem Cuatro'), randomUUID());
		await batch(createOne('Idem Cuatro'), randomUUID());
		expect(await countByName('Idem Cuatro')).toBe(2);
	});
});
