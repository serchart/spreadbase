# 01 — Diseño de SpreadBase

> Documento vivo. Decisiones acordadas con el propietario del proyecto,
> numeradas SB-1…
> Referencia de origen: `open-collect-crm/docs/07-anexo-datagrid-engine.md`
> (motor, datos remotos, protocolo del lote; decisiones G-1…G-17).

**Creado:** 2026-09-27 · **Revisado:** 2026-09-27 · **Estado:** 🟢 vigente

---

## 1. Qué es y por qué existe

Una librería npm, instalable **en el backend y en el frontend**, para trabajar
una tabla de base de datos como una hoja de cálculo: miles de filas, edición,
altas y bajas, deshacer y rehacer, borrador que sobrevive a recargar y guardado
en lote que detecta choques entre usuarios.

**La promesa:** quien la implementa se ocupa **solo del dominio de negocio** de
su solución —qué columnas tiene su hoja, qué reglas cumplen, de dónde se leen y
cómo se escriben—. Todo lo demás lo hace SpreadBase por debajo:

- ventana por tramos sobre datos remotos (nunca todas las filas en el navegador);
- borrador local en IndexedDB y reconciliación al recargar;
- historial de deshacer y rehacer, también fuera de la vista;
- panel de cambios, validación al editar y al guardar;
- guardado en lote con concurrencia por campo, avisos, conflictos e idempotencia;
- **después**: colaboración en tiempo real —usuarios conectados en sus
  sesiones, modificando celdas distintas a la vez, presencia, una capa Redis—.

### Origen

Nació como el DataGrid interno de OpenCollect CRM. Lo que allí se llamaba
«sandbox» —el módulo del backend, el playground del frontend y sus pruebas—
mezclaba tres cosas, y solo una era de cobranza:

| Pieza en OpenCollect | Qué es en realidad | En SpreadBase |
|---|---|---|
| Ventana por páginas, `locate`, lote con concurrencia por campo, `rowVersion`, avisos, idempotencia | Protocolo y motor: **genérico** | Núcleo de la librería |
| El arreglo de 50 000 filas en memoria | Almacenamiento | Una **fuente** (memoria para demos y pruebas; Postgres para producción) |
| Columnas de casos, etapas, responsables, semilla, reglas | **Dominio** | Lo único que escribe quien la usa |
| `GridController` + `SpreadsheetGrid` + paneles + IndexedDB | El cliente, casi reutilizable ya | `Sheet` + `<SpreadBase>` |

El trabajo difícil —historial, borrador, conflictos, reconciliación— ya era
genérico. Faltaba sacar el dominio hacia afuera y ponerle nombre. Se decidió
hacerlo **fuera de OpenCollect desde el principio**, como librería con sus
propias pruebas, y que OpenCollect sea su primer consumidor.

---

## 2. Decisiones

| # | Decisión | Estado |
|---|---|---|
| **SB-1** | **Un solo esquema, una sola validación.** La hoja se define una vez y la misma regla valida en el front (al editar) y en el back (al guardar). El código de validación vive en `core` y lo usan los dos lados. Dónde se escribe la definición: SB-12 | ✅ |
| **SB-2** | **Fuente de datos, no base embebida.** SpreadBase no es dueño de la conexión: habla con una interfaz chica (§5.3). Memoria ahora; Postgres después. La conexión es de la app | ✅ |
| **SB-3** | **La escritura es del dominio.** Lectura por vista o consulta; escritura por los `insertMany`/`updateMany`/`deleteMany` del servicio de la app, con sus reglas. SpreadBase pone alrededor versiones, concurrencia, idempotencia y respuesta. Nunca hace `UPDATE` directo de una tabla de dominio. Motivo: en el caso real (cartera de OpenCollect) se lee de una vista con agregados y escribir la etapa pasa por el servicio de casos; «una tabla = un grid» no sirve | ✅ |
| **SB-4** | **La concurrencia exige convenciones en la fuente:** `row_version` por fila y poder saber qué campos cambiaron desde una versión (tabla de historial o versión por campo). Es requisito documentado; cada fuente lo implementa | ✅ |
| **SB-5** | **El protocolo del lote no se rediseña:** `{ from, to }` por campo, `notices`, `conflicts`, `Idempotency-Key`, éxito parcial. Ya está probado (anexo de origen §11.13–§11.14) | ✅ |
| **SB-6** | **Cliente solo Svelte, por ahora.** El controlador usa runes. Svelte 5 es `peerDependency`. Si algún día se pide React, se separa | ✅ |
| **SB-7** | **Estilos: Tailwind + daisyUI como `peerDependencies`.** La app declara `@source` al CSS de la librería y hereda su tema. jspreadsheet, jsuites y lucide son dependencias normales | ✅ |
| **SB-8** | **Tiempo real: se diseña ya, se construye después.** Todo lote aplicado emite un evento `{ sheet, id, fields, rowVersion }`. Más adelante ese evento alimenta presencia, cursores de otros usuarios y Redis. Mientras tanto, nada del diseño debe cerrarle la puerta | ✅ |
| **SB-9** | **Repo privado, licencia MIT al publicar.** Scope npm `@spreadbase` reservado | ✅ |
| **SB-10** | **Tres paquetes: `server`, `client` y `core`** (§3). Quien usa la librería instala `server` en el back y `client` en el front; `core` llega como dependencia de ambos, como `socket.io-parser` con `socket.io` y `socket.io-client` | ✅ |
| **SB-11** | **Dos apps en el repo, con propósitos distintos:** `examples/basic`, didáctica, para developers que llegan a la librería; y `playground/`, banco de desarrollo con 50 000 filas, `mutate`/`reset`, latencia simulada y banco de rendimiento, contra el que corren las E2E (§7) | ✅ |
| **SB-12** | **La definición se escribe en el backend por defecto y viaja al front.** El backend es la autoridad: valida lo que se guarda. Sirve el esquema en `GET <base>/schema`; el front se conecta con `new Sheet(url)` y solo agrega lo visual o lo exclusivo del cliente. **Sin servidor** (datos locales u otra fuente), la definición se escribe en el front. No hay archivo compartido entre front y back. Detalle en §4.2 | ✅ |
| **SB-13** | **En el backend, SpreadBase se usa por piezas, una por capa** (`routes → controller → service`, como Aggy y OpenCollect): el motor es un objeto del servicio, `core` y `server` dan helpers para el controlador y las rutas. `sheetRouter(sheet, { context })` monta las cinco rutas del protocolo; es opcional y no rompe las capas, porque el motor sigue en el servicio. Detalle en §4.1 | ✅ |
| **SB-14** | **Se parte del código probado, no de reimplementaciones.** La base es la copia fiel de OpenCollect en `examples/sandbox/` (verificada con E2E y navegador). Lo que había antes en `packages/` y `apps/demo` se sustituye por lo que se extraiga de esa copia | ✅ |
| **SB-15** | **Validar el diseño con un segundo consumidor distinto** antes de darlo por bueno (p. ej. el ledger de cargos o usuarios de OpenCollect). Si sirve para dos dominios, la abstracción es correcta; hasta entonces no se generaliza por adelantado | ✅ |

---

## 3. Paquetes

| Paquete | Lo instala | Contiene | Se extrae de (OpenCollect) |
|---|---|---|---|
| **`@spreadbase/server`** | El backend | `SpreadBase` (motor: lectura, posición, lote con la regla por campo, `merge`/`strict`, eventos); fuentes (`memorySource`, luego `postgresSource`); helpers HTTP (`parseListQuery`, `parseBatch`, `idempotent()`, errores tipados, `sheetRouter()`) | `backend/src/modules/sandbox/sandbox.service.ts` sin los datos de casos; `common/idempotency.ts`, `common/errors.ts` |
| **`@spreadbase/client`** | El frontend | `Sheet` (el controlador: ventana, cambios, historial, borrador, conflictos, guardado); `<SpreadBase>` (la hoja, barra, paneles); cliente HTTP del protocolo; CSS | `frontend/src/lib/components/datagrid/` completo; `lib/api/sandbox.ts` generalizado a cualquier URL |
| **`@spreadbase/core`** | Nadie a mano | Tipos de columna y del esquema, normalización y validación de valores, tipos del protocolo (lote, conflicto, aviso, página) | `sandbox.types.ts`; la parte de validación de `cellTypes.ts` y de `validateBatch` |

Los paquetes se distribuyen como **TypeScript sin build** mientras sean
privados: los `exports` apuntan a `src/index.ts` (`tsx` en el back, Vite en el
front). Se revisa al publicar.

---

## 4. Cómo se usa

### 4.1 Backend: por capas (SB-13)

Ejemplo con la cartera de OpenCollect. Cada pieza va en la capa donde ya vive
el resto del módulo.

**Servicio**: el motor es un objeto del servicio; la escritura son métodos de
dominio del propio servicio.

```ts
// cases.service.ts
import { SpreadBase, types } from '@spreadbase/server';

export class CasesService {
	readonly portfolio = new SpreadBase({
		id: 'cases.portfolio',
		idField: 'id',
		allowInsert: false,
		allowDelete: false,
		columns: {
			customer_name:  { type: types.TEXT,   label: 'Cliente', readOnly: true, width: 260 },
			stage_code:     { type: types.SELECT, label: 'Etapa', required: true, options: STAGE_OPTIONS },
			promise_amount: { type: types.NUMBER, label: 'Promesa', min: 0, precision: 2, prefix: '$' },
			promise_date:   { type: types.DATE,   label: 'Fecha promesa' }
		},
		source: postgresSource({ pool, view: 'v_portfolio' }),                       // lectura
		handlers: { updateMany: (changes, ctx) => this.updateMany(changes, ctx) },  // escritura (SB-3)
		policy: 'merge'
	});

	async updateMany(changes, ctx) {
		/* reglas de negocio de casos */
	}
}
```

**Controlador**: helpers para leer la petición; lo demás (usuario, logs,
formato) es de la app.

```ts
// cases.controller.ts
import { parseListQuery, parseBatch } from '@spreadbase/server';

export class CasesController {
	constructor(private service: CasesService) {}
	schema   = (req, res) => res.json(this.service.portfolio.schema());
	list     = async (req, res) => res.json(await this.service.portfolio.list(parseListQuery(req.query)));
	position = async (req, res) => res.json(await this.service.portfolio.position(req.params.id, parseListQuery(req.query)));
	get      = async (req, res) => res.json(await this.service.portfolio.get(req.params.id));
	batch    = async (req, res) => res.json(await this.service.portfolio.batch(parseBatch(req.body), { user: req.user }));
}
```

**Rutas**: las de la app, con sus middlewares; SpreadBase aporta `idempotent()`.

```ts
// cases.routes.ts
router.get('/portfolio/schema', c.schema);
router.get('/portfolio', c.list);
router.get('/portfolio/:id/position', c.position);
router.get('/portfolio/:id', c.get);
router.post('/portfolio/batch', idempotent(), c.batch);
```

**Atajo: `sheetRouter()`.** Devuelve un `Router` con las cinco rutas del
protocolo ya conectadas: es exactamente el controlador y las rutas de arriba,
ya escritos, y garantiza que coinciden con lo que espera `new Sheet(url)`. Solo
se salta la capa del controlador; el motor sigue en el servicio.

```ts
// quickstart: «así de fácil»
app.use('/api/contacts', sheetRouter(new SpreadBase({ id: 'contacts', columns, source: memorySource(rows) })));

// módulo real: detrás de la autenticación, pasando el usuario al lote
router.use('/portfolio', authenticate, sheetRouter(casesService.portfolio, {
	context: (req) => ({ user: req.user })
}));
```

| Situación | Qué usar |
|---|---|
| Quickstart, `examples/basic`, `playground/`, herramientas internas | `sheetRouter()` |
| Módulo con autenticación común a todas sus rutas | `sheetRouter()` detrás del middleware, con `context` |
| Algo distinto por ruta: permisos para leer y para guardar, logs propios, rutas extra | Controlador y rutas a mano |

Reglas para que las piezas encajen:

- **Las rutas son el contrato con el cliente.** La base es libre
  (`/api/cases/portfolio`), pero bajo ella deben existir `/schema`, `/`,
  `/:id`, `/:id/position` y `/batch`: es lo que llama `new Sheet(base)`.
- **Errores:** el motor lanza errores tipados con `status`, `code` y
  `details`. La forma de respuesta es `{ error: { code, message, details? } }`,
  la misma que usa OpenCollect, así que su manejador los sirve sin traducir.
- **`handlers` es opcional:** si no se da, escribe la propia fuente
  (`memorySource` lo hace). Con Postgres y dominio real, se dan siempre (SB-3).

### 4.2 Frontend (SB-12)

**Uso normal, contra un servidor:** el front no repite la definición; la pide.

```svelte
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	const sheet = new Sheet('/api/cases/portfolio');
</script>

<SpreadBase {sheet} fill />
```

**Qué guarda `sheet`:** el estado del lado del cliente —el esquema recibido,
la ventana de filas cargadas, los cambios pendientes, el historial, el borrador
en IndexedDB, los conflictos y el estado del guardado—. Es el `GridController`
actual con otro nombre. El componente solo lo dibuja. Tenerlo fuera del
componente es lo que permite escucharlo (`sheet.pendingCount`), guardar desde
otro botón (`sheet.save()`) o montar una barra propia.

**Lo que solo existe en el cliente** se agrega al crearlo: anchos, el buscador
de un `remote-select`, editores propios.

```ts
new Sheet('/api/cases/portfolio', {
	columns: { customer_name: { width: 260 }, customer_id: { search: searchCustomers } }
});
```

**Sin servidor** (fuente local, la del ledger del playground de OpenCollect):
la definición se escribe en el front.

```ts
new Sheet({ id: 'charges', columns, load: loadCharges, save: saveCharges });
```

**Límite de validación:** las reglas declarativas viajan con el esquema y el
front las aplica igual que el back mientras se edita (obligatorio, mínimo y
máximo, longitud, opciones, patrón). Una regla escrita como **función** en el
backend («pagado ≤ importe») no viaja por HTTP: su error aparece al guardar,
salvo que el dev la repita en el `Sheet`.

---

## 5. Protocolo

### 5.1 Rutas bajo la base de la hoja

| Método | Ruta | Respuesta |
|---|---|---|
| `GET` | `/schema` | Columnas (tipo, reglas declarativas, pistas visuales), `idField`, `allowInsert`, `allowDelete`, `policy` |
| `GET` | `/?offset&limit&sort=campo:asc\|desc&search=&<campo>=a,b` | `{ rows, total, offset, limit, version }`. Orden **siempre con desempate por id**. `limit` ≤ 500 |
| `GET` | `/:id` | Una fila, con `rowVersion` |
| `GET` | `/:id/position?…` | `{ id, position, total }` dentro de la misma consulta; `position: null` si la consulta la excluye |
| `POST` | `/batch` | Lote de guardado (§5.2). Acepta `Idempotency-Key` |

Paginación por **offset**, no por cursor: permite saltar a una posición (ir a
una fila desde el panel de cambios). Se revisa si el volumen crece un orden de
magnitud.

### 5.2 Lote de guardado

```jsonc
// Petición — solo los campos que cambian, con el valor que el cliente leyó
{
	"creates": [{ "key": "tmp_m0", "values": { "customer_rfc": "…" } }],
	"updates": [{ "id": "case_002344", "rowVersion": 3,
	              "changes": { "stage_code": { "from": "early", "to": "judicial" } } }],
	"deletes": [{ "id": "case_000008", "rowVersion": 1 }]
}

// Respuesta 200 — éxito parcial
{
	"created":   [{ "key": "tmp_m0", "row": { … } }],
	"updated":   [{ "id": "case_002344", "rowVersion": 5, … }],
	"deleted":   ["case_000008"],
	"notices":   [{ "id": "case_002344", "fields": ["handler_id"] }],
	"conflicts": [{ "op": "update", "id": "case_000900", "reason": "field_conflict",
	                "fields": [{ "field": "stage_code", "from": "early", "yours": "judicial", "remote": "late" }],
	                "remote": { … } }]
}
```

Reglas (probadas en OpenCollect, SB-5):

- **Por cada campo que la petición cambia:** valor actual = `from` → se
  aplica; distinto → `field_conflict`. La comparación es normalizada por tipo
  (`1500` = `"1500.00"`).
- **Cambios ajenos en otros campos**, según la política de la hoja, fijada en
  el servidor: `merge` los conserva y los informa en `notices`; `strict`
  rechaza la fila con `version_mismatch`.
- **Eliminar lo que otro editó** es siempre conflicto. Eliminar lo que otro ya
  eliminó se reporta como eliminado. Editar lo que otro eliminó: `not_found`.
- **Un conflicto no bloquea el resto del lote.** Un lote mal formado (campo
  inexistente, de solo lectura o valor inválido) se rechaza entero con 400.
- **Idempotencia:** la misma llave devuelve la misma respuesta sin reaplicar
  (`Idempotent-Replayed: true`); la misma llave con otro cuerpo, 422. Un 5xx no
  se guarda.

### 5.3 Fuente de datos (SB-2, SB-4)

```ts
interface SheetSource<Row> {
	list(q: ListQuery): Promise<{ rows: Row[]; total: number }>;   // orden y filtros del servidor
	position(id: string, q: ListQuery): Promise<number | null>;
	getMany(ids: string[]): Promise<Row[]>;                         // con rowVersion
	changedFieldsSince(id: string, version: number): Promise<string[]>;
}
```

Requisitos de la tabla o vista para que la concurrencia funcione:

- `row_version` entero, que sube con cada cambio de la fila;
- saber qué campos cambiaron desde una versión: tabla de historial o versión
  por campo (en memoria, hoy es `fieldVersions`);
- aplicar el lote dentro de una transacción con bloqueo de las filas tocadas
  o actualización condicionada (en memoria ya es atómico).

### 5.4 Eventos (SB-8)

Cada lote aplicado emite, por fila, `{ sheet, id, fields, rowVersion }`. Hoy no
lo consume nadie; es el enganche para tiempo real.

---

## 6. Estructura del repo

```
SpreadBase/
├── packages/
│   ├── core/          @spreadbase/core
│   ├── server/        @spreadbase/server
│   └── client/        @spreadbase/client
├── examples/
│   └── basic/         didáctico: hoja chica, back + front mínimos, código comentado
├── playground/        banco de desarrollo: 50 000 filas, mutate/reset, latencia, rendimiento
│   ├── backend/
│   └── frontend/
├── tests/             E2E por módulo contra el playground (§7)
└── docs/
```

`examples/sandbox/` es **temporal**: la copia probada de OpenCollect de la que
se extraen los paquetes (SB-14). Desaparece cuando `playground/` y
`examples/basic` la cubran, igual que `apps/demo` y lo anterior de `packages/`.

---

## 7. Pruebas

Principios, heredados de la estrategia de pruebas de OpenCollect (su doc 09):

1. **E2E primero, sin mocks:** API real, navegador real, datos reales. Una
   prueba cuenta una historia de usuario y puede llamar a la API y manejar el
   navegador en la misma historia.
2. **Servidores encendidos en modo test.** Las pruebas no los arrancan: exigen
   que respondan y, si no, fallan de inmediato con la instrucción para
   arrancarlos. Los endpoints destructivos (`reset`, `mutate`) solo existen en
   modo test.
3. **Lo determinista decide.** Vitest compara valores concretos (respuesta de la
   API, texto o clase de una celda, estado en el servidor). Capturas y consolas
   acompañan, no deciden.
4. **Cada usuario es un contexto de navegador.** Dos contextos = dos usuarios
   editando la misma fila.
5. **Código puro, junto al código.** Lo que exige importar el código —como la
   prueba de propiedades del historial— vive en su paquete
   (`packages/client/src/**/*.test.ts`). Es la excepción.

Herramientas: Vitest 4.1.x como runner y Playwright 1.63.x como librería.

| Directorio | Cubre |
|---|---|
| `tests/protocol/` | Las reglas del §5: lectura, lote, concurrencia por campo, idempotencia (hoy 23 casos) |
| `tests/grid/` | Navegador: tramos, ir a la fila, borrador, combinar, conflicto, bajas, altas |
| `packages/client/src/…test.ts` | Propiedades del historial: deshacer una acción ≙ repetir todo sin ella |

---

## 8. Plan y estado

| # | Paso | Estado |
|---|---|---|
| 1 | Base del repo (workspaces, TypeScript, Vitest) | ✅ |
| 2 | Copia probada de OpenCollect en `examples/sandbox/`: 22 casos de API + 1 omitido (`strict`), propiedad del historial, recorrido en navegador (editar, bajar, recargar, guardar) | ✅ |
| 3 | Commit del estado actual como punto de partida | ⬜ **siguiente** |
| 4 | `core`: tipos de columna y del protocolo, normalización y validación, extraídos de la copia | ⬜ |
| 5 | `server`: `SpreadBase`, `memorySource`, helpers HTTP y `sheetRouter()`. Backend del `playground/` en capas. Pruebas de protocolo en `tests/protocol/` en verde | ⬜ |
| 6 | `client`: `Sheet` + `<SpreadBase>` cargando `/schema`. Frontend del `playground/`. Propiedad del historial y recorrido en navegador en verde | ⬜ |
| 7 | `examples/basic` | ⬜ |
| 8 | Retirar `examples/sandbox`, `apps/demo` y el código anterior de `packages/` | ⬜ |
| 9 | E2E de navegador en `tests/grid/` | ⬜ |
| 10 | OpenCollect consume los paquetes y borra su copia; segundo consumidor (SB-15) | ⬜ |
| 11 | `postgresSource` (SB-2, SB-4) | ⬜ |
| 12 | Colaboración en tiempo real (SB-8) | ⬜ |

**Sobre el plan anterior:** sus pasos 2–5 (`core`, `server` con
`SheetEngine`, `apps/demo`, `tests/engine`) se marcaron hechos, pero se
escribieron reimplementando en lugar de extraer, y no se consideran base
confiable (SB-14). Se sustituyen por los pasos 4–6 de esta tabla.
