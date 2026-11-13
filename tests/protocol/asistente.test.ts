/**
 * El ejemplo `/api/import-assistant` (SB-36) encendido, por HTTP: lo que hará
 * el asistente del cliente. Con el modelo de guion del ejemplo (sin red):
 * la bienvenida de `/config`, instrucciones por el chat antes de analizar,
 * subir un CSV (con una fila repetida idéntica), analizar, el veredicto en el
 * chat, conversar («excluye contado»), importar con replace y ver lo
 * importado en la hoja destino.
 */
import { describe, expect, it } from 'vitest';
import { api } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { csvPlanes, FILAS_OK } from '../support/planes.ts';
import { pdfMinimo, texto } from '../support/pdf.ts';

const BASE = '/api/import-assistant';
/** Cada prueba con su usuario: sus corridas no se mezclan con las de otra sesión. */
const USER = { 'X-User': `e2e-${Math.random().toString(36).slice(2, 8)}` };

async function esperar(id: string, estado: string) {
	for (let i = 0; i < 100; i++) {
		const { body } = await api(`${BASE}/runs/${id}`, { headers: USER });
		if (body.estado === estado) return body;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`La corrida no llegó a ${estado}`);
}

describe('ejemplo /api/import-assistant', () => {
	it('subir → analizar → chat → importar (replace) → la hoja destino tiene lo importado', async () => {
		const config = await api(`${BASE}/config`);
		expect(config.body.destinos.map((d: any) => d.adjunto ?? d.tipo)).toEqual(['filas', 'fichas', 'imagen', 'archivos', 'ficha', 'descartar']);
		// El staging se abre sobre la hoja de la tabla; los archivos que van a una columna lo dicen.
		expect(config.body.destinos[0]).toMatchObject({ formato: 'planes', sheetUrl: 'planes' });
		expect(config.body.destinos[2]).toMatchObject({ label: 'Imagen del plan', columna: { formato: 'planes', campo: 'imagen' } });
		expect(config.body.bienvenida).toContain('• Adjuntar → Ficha técnica');

		// La corrida nace al abrir el asistente; lo que se dice en el chat antes de analizar son sus instrucciones.
		const { body: run } = await api(`${BASE}/runs`, { body: {}, headers: USER });
		const nota = await api(`${BASE}/runs/${run.id}/chat`, { body: { texto: 'Los planes de octubre reemplazan a los de septiembre' }, headers: USER });
		expect(nota.body.mensaje.texto).toBe('Anotado: lo tomo en cuenta al analizar.');
		expect(nota.body.corrida.instrucciones).toBe('Los planes de octubre reemplazan a los de septiembre');

		// El boletín repite tablas: una fila idéntica a otra se une.
		const up = await fetch(`${API_URL}${BASE}/runs/${run.id}/files`, {
			method: 'POST',
			headers: { ...USER, 'X-File-Name': encodeURIComponent('planes octubre.csv') },
			body: new Uint8Array(csvPlanes([...FILAS_OK, FILAS_OK[0]!]))
		});
		expect(up.status).toBe(201);
		const [file] = await up.json();
		expect(file).toMatchObject({ nombre: 'planes octubre.csv', tipo: 'text/csv', estado: 'pendiente' });
		// El archivo quedó en la carpeta de subidas del ejemplo, con un nombre limpio.
		expect(file.url).toMatch(/\/uploads\/import-assistant\/[^/]+\/planes-octubre\.csv$/);
		expect((await fetch(file.url)).status).toBe(200);

		expect((await api(`${BASE}/runs/${run.id}/analyze`, { body: {}, headers: USER })).status).toBe(202);
		const listo = await esperar(run.id, 'lista');
		expect(listo.archivos[0]).toMatchObject({ estado: 'analizado', analisis: '3 filas de 1 modelos', destino: { tipo: 'filas', formato: 'planes', modo: 'replace' }, totalFilas: 3, totalAvisos: 1 });
		// El chat reporta sin que se lo pidan.
		expect(listo.chat.at(-1)).toMatchObject({ rol: 'agente', texto: 'planes octubre.csv: 3 filas, 0 errores, listo para reemplazar. 1 fila duplicada idéntica se unió.' });

		const chat = await api(`${BASE}/runs/${run.id}/chat`, { body: { texto: 'Excluye contado' }, headers: USER });
		expect(chat.body.mensaje.texto).toBe('Listo: quité 1 filas con «contado» en el tipo de pago.');
		expect(chat.body.corrida.archivos[0].totalFilas).toBe(2);

		const detalle = await api(`${BASE}/runs/${run.id}/files/${file.id}/rows`, { headers: USER });
		expect(detalle.body.filas.map((f: any) => f.tipoPago)).toEqual(['GMF TASA SUBSIDIADA CON SEGURO', 'LEASING']);

		expect((await api(`${BASE}/runs/${run.id}/import`, { method: 'POST', headers: USER })).status).toBe(202);
		const fin = await esperar(run.id, 'terminada');
		expect(fin.archivos[0].resultado).toMatchObject({ status: 'ok', ok: 2, error: 0, resumen: { modo: 'replace' } });
		expect(fin.chat.at(-1).texto).toBe('Importación terminada: 2 filas importadas.\n• planes octubre.csv: 2 filas importadas.');

		const planes = await api(`${BASE}/planes?limit=50`);
		expect(planes.body.rows.map((r: any) => r.precioFinal)).toEqual([259100, 270700]);
	});

	// -- staging (S, §8.3): la tabla destino con los cambios de toda la corrida ----------------

	/** Corrida con archivos subidos y analizados, de una persona nueva. */
	async function corridaCon(archivos: { nombre: string; csv: Buffer }[], user = { 'X-User': `e2e-${Math.random().toString(36).slice(2, 8)}` }) {
		const { body: run } = await api(`${BASE}/runs`, { body: { origen: 'Planes GMF' }, headers: user });
		const ids: Record<string, string> = {};
		for (const a of archivos) {
			const res = await fetch(`${API_URL}${BASE}/runs/${run.id}/files`, { method: 'POST', headers: { ...user, 'X-File-Name': encodeURIComponent(a.nombre) }, body: new Uint8Array(a.csv) });
			ids[a.nombre] = (await res.json())[0].id;
		}
		await api(`${BASE}/runs/${run.id}/analyze`, { body: {}, headers: user });
		for (let i = 0; i < 100; i++) {
			const { body } = await api(`${BASE}/runs/${run.id}`, { headers: user });
			if (body.estado === 'lista') break;
			await new Promise((r) => setTimeout(r, 50));
		}
		return { run: run.id as string, ids, user };
	}
	const staging = async (c: { run: string; user: Record<string, string> }, query = '') =>
		(await api(`${BASE}/runs/${c.run}/staging?destino=planes${query}`, { headers: c.user })).body;

	/**
	 * La tabla parte de los planes «de septiembre» (3): AVEO contado (igual en octubre), AVEO GMF
	 * (cambia el precio de lista) y ONIX contado (no viene en octubre). Octubre trae AVEO contado
	 * idéntico y AVEO GMF con otro precio en un archivo, y un AVEO LT nuevo en otro.
	 */
	const OCT_A = [FILAS_OK[0]!, ['AVEO HB 2026', 'A', 'LS Manual', 'GMF TASA SUBSIDIADA CON SEGURO', 'RCC', 'HCAM', '$329,100', '($60,000)', '$269,100']];
	const OCT_B = [FILAS_OK[2]!];
	const reset = () => api(`${BASE}/planes/dev/reset`, { body: {} });

	it('S-1 · staging de 2 archivos unidos: update solo con los campos que cambian, idénticas sin marca, insert y (replace) delete con el id de la hoja', async () => {
		await reset();
		const c = await corridaCon([
			{ nombre: 'octubre-a.csv', csv: csvPlanes(OCT_A) },
			{ nombre: 'octubre-b.csv', csv: csvPlanes(OCT_B) }
		]);
		const s = await staging(c);
		expect(s).toMatchObject({ destino: 'planes', modo: 'replace', base: { filas: 3 }, resumen: { insert: 1, update: 1, delete: 1, errores: 0 }, problemas: [], sinEmparejar: [] });
		const update = s.cambios.find((x: any) => x.op === 'update');
		// Solo los campos que cambian, con antes y después, y de qué archivo salió.
		expect(update).toEqual({
			op: 'update',
			key: 'aveo hb 2026 | a | ls manual | gmf tasa subsidiada con seguro | rcc | hcam',
			id: 'pl_00002',
			campos: {
				precioLista: { antes: 319100, despues: 329100, origen: [{ archivo: c.ids['octubre-a.csv'], fila: 1 }] },
				precioFinal: { antes: 259100, despues: 269100, origen: [{ archivo: c.ids['octubre-a.csv'], fila: 1 }] }
			}
		});
		// La fila idéntica (AVEO contado) no genera cambio.
		expect(s.cambios.some((x: any) => x.key.includes('contado') && x.key.startsWith('aveo'))).toBe(false);
		const insert = s.cambios.find((x: any) => x.op === 'insert');
		expect(insert).toMatchObject({ valores: { modelo: 'AVEO HB 2026', paquete: 'B', tipoPago: 'LEASING', precioFinal: 270700 }, origen: [{ archivo: c.ids['octubre-b.csv'], fila: 0 }] });
		expect(s.cambios.find((x: any) => x.op === 'delete')).toEqual({ op: 'delete', key: 'onix 2026 | a | ls | contado con seguro | rcc | hccm', id: 'pl_00003', motivo: 'No viene en los archivos (reemplazar)' });
	});

	it('S-2 · upsert no elimina: lo que no viene queda intacto (por el destino de los archivos o por ?modo=)', async () => {
		await reset();
		const c = await corridaCon([{ nombre: 'octubre-a.csv', csv: csvPlanes(OCT_A) }]);
		expect((await staging(c)).resumen).toMatchObject({ update: 1, delete: 1 });
		expect((await staging(c, '&modo=upsert')).resumen).toMatchObject({ insert: 0, update: 1, delete: 0 });
		await api(`${BASE}/runs/${c.run}/files/${c.ids['octubre-a.csv']}/destination`, { method: 'PUT', body: { destino: { tipo: 'filas', formato: 'planes', modo: 'upsert' } }, headers: c.user });
		const s = await staging(c);
		expect(s.modo).toBe('upsert');
		expect(s.cambios.map((x: any) => x.op)).toEqual(['update']);
	});

	it('S-3 · los problemas del review van por llave y campo; PUT guarda las ediciones de la persona y GET las devuelve tal cual', async () => {
		await reset();
		const MALA = ['ONIX 2026', 'A', 'LS', 'LEASING', 'RCC', 'LCCN', '$300,000', '($1,000)', '$300,000'];
		const c = await corridaCon([{ nombre: 'octubre.csv', csv: csvPlanes([...OCT_A, MALA]) }]);
		const s = await staging(c);
		expect(s.problemas).toEqual([{ key: 'onix 2026 | a | ls | leasing | rcc | lccn', campo: 'precioFinal', nivel: 'error', mensaje: 'Debería ser 299000 (lista + descuento)' }]);
		expect(s.resumen.errores).toBe(1);
		// La persona corrige la fila nueva y deja de borrar ONIX contado.
		const cambios = s.cambios
			.filter((x: any) => x.op !== 'delete')
			.map((x: any) => (x.op === 'insert' && x.key.startsWith('onix') ? { ...x, valores: { ...x.valores, precioFinal: 299000 } } : x));
		const put = await api(`${BASE}/runs/${c.run}/staging`, { method: 'PUT', body: { destino: 'planes', cambios }, headers: c.user });
		expect(put.status).toBe(200);
		const again = await staging(c);
		expect(again.cambios).toEqual(cambios);
		expect(again.resumen).toMatchObject({ insert: 1, update: 1, delete: 0 });
		// Otro análisis cambia lo que proponen los archivos: lo editado ya no vale y se recalcula.
		await api(`${BASE}/runs/${c.run}/files/${c.ids['octubre.csv']}/rows`, { method: 'PUT', body: { filas: [] }, headers: c.user });
		expect((await staging(c)).cambios).toEqual([]);
	});

	it('S-4 · importar después de guardar la hoja: la corrida se marca sin volver a aplicar, y el chat dice qué cambió; un error al guardar va al chat', async () => {
		await reset();
		const c = await corridaCon([
			{ nombre: 'octubre-a.csv', csv: csvPlanes(OCT_A) },
			{ nombre: 'octubre-b.csv', csv: csvPlanes(OCT_B) }
		]);
		// Un error al guardar la hoja (lo manda el cliente): el agente lo dice en el chat.
		const fallo = await api(`${BASE}/runs/${c.run}/staging`, {
			method: 'PUT',
			body: { destino: 'planes', error: { mensaje: 'El lote tiene valores inválidos', problemas: [{ key: 'AVEO HB 2026 · B · LT Manual', campo: 'precioFinal', mensaje: 'Debería ser 270700 (lista + descuento)' }] } },
			headers: c.user
		});
		expect(fallo.status).toBe(200);
		const conError = (await api(`${BASE}/runs/${c.run}`, { headers: c.user })).body;
		expect(conError.chat.at(-1).texto).toBe(
			'No se pudo guardar Planes GMF: El lote tiene valores inválidos. Corrige las celdas marcadas y vuelve a importar.\n• AVEO HB 2026 · B · LT Manual · Precio Final: Debería ser 270700 (lista + descuento)'
		);
		// El cliente guarda la hoja con el lote de siempre…
		const s = await staging(c);
		const u = s.cambios.find((x: any) => x.op === 'update');
		const i = s.cambios.find((x: any) => x.op === 'insert');
		const d = s.cambios.find((x: any) => x.op === 'delete');
		const fila = (await api(`${BASE}/planes/${u.id}`)).body;
		const batch = await api(`${BASE}/planes/batch`, {
			body: {
				creates: [{ key: 'n1', values: i.valores }],
				updates: [{ id: u.id, rowVersion: fila.rowVersion, changes: Object.fromEntries(Object.entries(u.campos).map(([f, v]: any) => [f, { from: v.antes, to: v.despues }])) }],
				deletes: [{ id: d.id, rowVersion: (await api(`${BASE}/planes/${d.id}`)).body.rowVersion }]
			}
		});
		expect(batch.status).toBe(200);
		// …y marca la corrida.
		const imp = await api(`${BASE}/runs/${c.run}/import`, { body: { staging: [{ destino: 'planes', resumen: { insert: 1, update: 1, delete: 1 } }] }, headers: c.user });
		expect(imp.status).toBe(202);
		const fin = await esperarCon(c, 'terminada');
		expect(fin.archivos.map((f: any) => f.resultado)).toEqual([
			expect.objectContaining({ status: 'ok', ok: 2, mensaje: 'Guardado con el staging' }),
			expect.objectContaining({ status: 'ok', ok: 1, mensaje: 'Guardado con el staging' })
		]);
		expect(fin.staging.planes.publicado.resumen).toEqual({ insert: 1, update: 1, delete: 1 });
		expect(fin.chat.at(-1).texto.split('\n').slice(0, 2)).toEqual(['Importación terminada: 3 filas importadas.', 'Planes GMF: 1 nueva, 1 actualizada, 1 eliminada.']);
		// La tabla quedó como el staging: sin volver a aplicar (ONIX fuera, AVEO GMF con su precio nuevo, AVEO LT nuevo).
		const planes = (await api(`${BASE}/planes?limit=50`)).body.rows;
		expect(planes.map((r: any) => [r.id, r.tipoPago, r.precioFinal])).toEqual([
			['pl_00001', 'CONTADO CON SEGURO', 319100],
			['pl_00002', 'GMF TASA SUBSIDIADA CON SEGURO', 269100],
			['pl_00004', 'LEASING', 270700]
		]);
	});

	it('S-5 · importar un solo destino (§10): `destinos` importa solo los archivos de ese staging; la corrida vuelve a `lista` mientras falten otros y el chat lo reporta por destino', async () => {
		await reset();
		const user = { 'X-User': `e2e-${Math.random().toString(36).slice(2, 8)}` };
		const { body: run } = await api(`${BASE}/runs`, { body: { origen: 'Planes GMF' }, headers: user });
		const subir = async (nombre: string, bytes: Uint8Array) =>
			(await (await fetch(`${API_URL}${BASE}/runs/${run.id}/files`, { method: 'POST', headers: { ...user, 'X-File-Name': encodeURIComponent(nombre) }, body: bytes })).json())[0].id as string;
		const csv = await subir('octubre-a.csv', new Uint8Array(csvPlanes(OCT_A)));
		const notas = await subir('notas.txt', new Uint8Array(Buffer.from('Vigencia octubre')));
		await api(`${BASE}/runs/${run.id}/files/${notas}/destination`, { method: 'PUT', body: { destino: { tipo: 'descartar' } }, headers: user });
		await api(`${BASE}/runs/${run.id}/analyze`, { body: {}, headers: user });
		const c = { run: run.id as string, user };
		await esperarCon(c, 'lista');

		// Un destino que no existe, o `destinos` mal formado: 400.
		expect((await api(`${BASE}/runs/${run.id}/import`, { body: { destinos: ['otra'] }, headers: user })).status).toBe(400);
		expect((await api(`${BASE}/runs/${run.id}/import`, { body: { destinos: 'planes' }, headers: user })).status).toBe(400);

		// Solo Planes GMF: entra el CSV; notas.txt (descartar) se queda.
		const imp = await api(`${BASE}/runs/${run.id}/import`, { body: { destinos: ['planes'] }, headers: user });
		expect(imp.status).toBe(202);
		expect(imp.body.importacion).toEqual({ destinos: ['planes'], archivos: [csv] });
		expect(imp.body.archivos.map((f: any) => f.estado)).toEqual(['en_cola', 'analizado']);
		const parcial = await esperarCon(c, 'lista');
		expect(parcial.archivos.map((f: any) => [f.nombre, f.estado])).toEqual([
			['octubre-a.csv', 'importado'],
			['notas.txt', 'analizado']
		]);
		expect(parcial.chat.at(-1).texto).toBe('Importé Planes GMF: 2 filas importadas.\n• octubre-a.csv: 2 filas importadas.\nFalta 1 archivo por importar: notas.txt.');
		// Ya no hay nada de Planes GMF por importar.
		expect((await api(`${BASE}/runs/${run.id}/import`, { body: { destinos: ['planes'] }, headers: user })).body.error.message).toBe('No hay archivos por importar en Planes GMF');

		// Lo que falta, con «Importar todo»: la corrida termina.
		expect((await api(`${BASE}/runs/${run.id}/import`, { body: {}, headers: user })).status).toBe(202);
		const fin = await esperarCon(c, 'terminada');
		expect(fin.archivos.map((f: any) => f.estado)).toEqual(['importado', 'importado']);
		expect(fin.chat.at(-1).texto).toMatch(/^Importación terminada: 2 filas importadas\.\n• octubre-a\.csv: 2 filas importadas\.\n• notas\.txt: descartado\.$/);
	});

	async function esperarCon(c: { run: string; user: Record<string, string> }, estado: string) {
		for (let i = 0; i < 100; i++) {
			const { body } = await api(`${BASE}/runs/${c.run}`, { headers: c.user });
			if (body.estado === estado) return body;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`La corrida no llegó a ${estado}`);
	}

	// -- archivos a columnas (T, SB-38): emparejar por nombre ------------------------------------

	it('T-1 · la hoja Planes GMF trae imagen (IMAGE), archivos (FOLDER) y ficha técnica (texto largo), con subida', async () => {
		const { body } = await api(`${BASE}/planes/schema`);
		expect(body.columns.imagen).toMatchObject({ type: 'image', upload: { maxSize: 5 * 1024 * 1024 } });
		expect(body.columns.archivos).toMatchObject({ type: 'folder', upload: { maxSize: 20 * 1024 * 1024 } });
		expect(body.columns.fichaTecnica).toMatchObject({ type: 'text', multiline: true });
	});

	it('T-2 · emparejar archivos con filas por nombre: foto a Imagen de toda la unidad, PDF a la carpeta, ficha de texto a Ficha técnica; lo que no empareja (o es ambiguo) va a sinEmparejar', async () => {
		await reset();
		const user = { 'X-User': `e2e-${Math.random().toString(36).slice(2, 8)}` };
		const { body: run } = await api(`${BASE}/runs`, { body: {}, headers: user });
		const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
		const subir = async (nombre: string, bytes: Buffer, destino: string) => {
			const res = await fetch(`${API_URL}${BASE}/runs/${run.id}/files`, { method: 'POST', headers: { ...user, 'X-File-Name': encodeURIComponent(nombre) }, body: new Uint8Array(bytes) });
			const [f] = await res.json();
			await api(`${BASE}/runs/${run.id}/files/${f.id}/destination`, { method: 'PUT', body: { destino: { tipo: 'adjuntar', adjunto: destino } }, headers: user });
			return f;
		};
		const foto = await subir('AVEO HB 2026 LS Manual.png', PNG, 'imagen');
		const ficha = await subir('ONIX 2026 LS ficha.txt', Buffer.from('Ficha técnica ONIX 2026\nMotor 1.0 turbo\nTransmisión automática'), 'ficha');
		const manual = await subir('ONIX 2026 manual.pdf', pdfMinimo([texto(72, 720, 'Manual ONIX 2026')]), 'archivos');
		const suelta = await subir('catalogo.png', PNG, 'imagen');
		const ambigua = await subir('AVEO HB 2026 y ONIX 2026.png', PNG, 'imagen');

		const s = (await api(`${BASE}/runs/${run.id}/staging?destino=planes`, { headers: user })).body;
		// Sin filas de archivos no se elimina nada, ni con reemplazar.
		expect(s.resumen).toMatchObject({ insert: 0, update: 3, delete: 0 });
		const por = Object.fromEntries(s.cambios.map((c: any) => [c.id, c]));
		// La foto, a las dos filas de esa unidad (AVEO HB 2026 · LS Manual).
		for (const id of ['pl_00001', 'pl_00002']) {
			expect(por[id].campos).toEqual({ imagen: { antes: null, despues: foto.url, origen: [{ archivo: foto.id, nota: 'emparejado por nombre: AVEO HB 2026 · LS Manual' }] } });
		}
		// La ficha (su texto, en markdown) y el PDF a la carpeta, en ONIX 2026.
		expect(por.pl_00003.campos.fichaTecnica.despues).toBe('Ficha técnica ONIX 2026\nMotor 1.0 turbo\nTransmisión automática');
		expect(por.pl_00003.campos.archivos.despues).toEqual([{ url: manual.url, name: 'ONIX 2026 manual.pdf', type: 'application/pdf', size: manual.tamano }]);
		expect(por.pl_00003.campos.fichaTecnica.origen).toEqual([{ archivo: ficha.id, nota: 'emparejado por nombre: ONIX 2026 · LS' }]);
		expect(s.sinEmparejar).toEqual([
			{ archivo: suelta.id, motivo: '«catalogo.png»: su nombre no coincide con ninguna fila (Modelo, Versión, Paquete)' },
			{ archivo: ambigua.id, motivo: '«AVEO HB 2026 y ONIX 2026.png» puede ser de varias filas (AVEO HB 2026 / ONIX 2026): renómbralo o elige la fila' }
		]);

		// Guardar la hoja con esos cambios (como el cliente) e importar: los archivos quedan «en la columna».
		const updates = [];
		for (const c of s.cambios) {
			const fila = (await api(`${BASE}/planes/${c.id}`)).body;
			updates.push({ id: c.id, rowVersion: fila.rowVersion, changes: Object.fromEntries(Object.entries(c.campos).map(([f, v]: any) => [f, { from: v.antes, to: v.despues }])) });
		}
		expect((await api(`${BASE}/planes/batch`, { body: { creates: [], updates, deletes: [] } })).status).toBe(200);
		await api(`${BASE}/runs/${run.id}/import`, { body: { staging: [{ destino: 'planes', resumen: { insert: 0, update: 3, delete: 0 } }] }, headers: user });
		const fin = await esperarCon({ run: run.id, user }, 'terminada');
		expect(fin.archivos.find((f: any) => f.id === foto.id).resultado).toMatchObject({ status: 'ok', mensaje: 'En la columna «imagen»' });
		const onix = (await api(`${BASE}/planes/pl_00003`)).body;
		expect(onix.archivos).toEqual([{ url: manual.url, name: 'ONIX 2026 manual.pdf', type: 'application/pdf', size: manual.tamano }]);
		expect(onix.fichaTecnica).toContain('Motor 1.0 turbo');
		expect((await api(`${BASE}/planes/pl_00001`)).body.imagen).toBe(foto.url);
	});

	it('T-3 · `destino.fila` (la llave exacta que deja el cerebro o la persona) manda sobre el nombre del archivo', async () => {
		await reset();
		const user = { 'X-User': `e2e-${Math.random().toString(36).slice(2, 8)}` };
		const { body: run } = await api(`${BASE}/runs`, { body: {}, headers: user });
		const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
		const res = await fetch(`${API_URL}${BASE}/runs/${run.id}/files`, { method: 'POST', headers: { ...user, 'X-File-Name': 'IMG_0042.png' }, body: new Uint8Array(PNG) });
		const [f] = await res.json();
		await api(`${BASE}/runs/${run.id}/files/${f.id}/destination`, {
			method: 'PUT',
			body: { destino: { tipo: 'adjuntar', adjunto: 'imagen', fila: 'onix 2026 | a | ls | contado con seguro | rcc | hccm' } },
			headers: user
		});
		const s = (await api(`${BASE}/runs/${run.id}/staging?destino=planes`, { headers: user })).body;
		expect(s.sinEmparejar).toEqual([]);
		expect(s.cambios).toEqual([{ op: 'update', key: 'onix 2026 | a | ls | contado con seguro | rcc | hccm', id: 'pl_00003', campos: { imagen: { antes: null, despues: f.url, origen: [expect.objectContaining({ archivo: f.id })] } } }]);
	});
});
