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
| **SB-4** | **La concurrencia no exige nada en la tabla del usuario** (revisada 2026-09-28). `rowVersion` es un testigo **opaco** que pone la fuente: `memorySource` usa un contador; `postgresSource`, una **huella (hash) de las columnas escribibles** calculada al leer, o una columna de versión si la tabla ya la tiene. Cualquier escritura cambia la huella, venga de la hoja, de un worker o de un script. Sin triggers, sin `row_version` obligatorio, sin tabla de cambios | ✅ |
| **SB-5** | **El protocolo del lote se conserva:** `{ from, to }` por campo, `notices`, `conflicts`, `Idempotency-Key`, éxito parcial. Ya está probado (anexo de origen §11.13–§11.14). Única ampliación: `base` en cada edición (SB-16) | ✅ |
| **SB-6** | **Cliente solo Svelte, por ahora.** El controlador usa runes. Svelte 5 es `peerDependency`. Si algún día se pide React, se separa | ✅ |
| **SB-7** | **Estilos: Tailwind + daisyUI como `peerDependencies`.** La app declara `@source` al CSS de la librería y hereda su tema. jspreadsheet, jsuites y lucide son dependencias normales | ✅ |
| **SB-8** | **Tiempo real: se diseña ya, se construye después.** Todo lote aplicado emite un evento `{ sheet, id, fields, rowVersion }`. Más adelante ese evento alimenta presencia, cursores de otros usuarios y Redis. Mientras tanto, nada del diseño debe cerrarle la puerta | ✅ |
| **SB-9** | **Repo privado, licencia MIT al publicar.** Scope npm `@spreadbase` reservado | ✅ |
| **SB-10** | **Tres paquetes: `server`, `client` y `core`** (§3). Quien usa la librería instala `server` en el back y `client` en el front; `core` llega como dependencia de ambos, como `socket.io-parser` con `socket.io` y `socket.io-client` | ✅ |
| **SB-11** | **Un servidor y una app para todos los ejemplos** (revisada 2026-09-28). `examples/backend` tiene la base común y una carpeta por ejemplo en `src/examples/`, montada bajo `/api/<nombre>`; `examples/frontend` tiene un índice y una página por ejemplo. Ejemplos: básico (didáctico), Postgres (backend JS estilo Aggy), casos (50 000 filas en capas, `mutate`/`reset`, latencia; contra él corren las E2E) y sin servidor. Un ejemplo nuevo es una carpeta, no un servidor | ✅ |
| **SB-12** | **La definición se escribe en el backend por defecto y viaja al front.** El backend es la autoridad: valida lo que se guarda. Sirve el esquema en `GET <base>/schema`; el front se conecta con `new Sheet(url)` y solo agrega lo visual o lo exclusivo del cliente. **Sin servidor** (datos locales u otra fuente), la definición se escribe en el front. No hay archivo compartido entre front y back. Detalle en §4.2 | ✅ |
| **SB-13** | **En el backend, SpreadBase se usa por piezas, una por capa** (`routes → controller → service`, como Aggy y OpenCollect): el motor es un objeto del servicio, `core` y `server` dan helpers para el controlador y las rutas. `sheetRouter(sheet, { context })` monta las cinco rutas del protocolo; es opcional y no rompe las capas, porque el motor sigue en el servicio. Detalle en §4.1 | ✅ |
| **SB-14** | **Se parte del código probado, no de reimplementaciones.** Los paquetes se extrajeron de la copia fiel de OpenCollect (verificada con E2E y navegador) y el ejemplo de casos (`examples/backend/src/examples/cases`) es esa copia sobre los paquetes. Lo que había antes en `packages/` y `apps/demo` se retiró | ✅ |
| **SB-15** | **Validar el diseño con un segundo consumidor distinto** antes de darlo por bueno (p. ej. el ledger de cargos o usuarios de OpenCollect). Si sirve para dos dominios, la abstracción es correcta; hasta entonces no se generaliza por adelantado | ✅ |
| **SB-16** | **Los avisos de `merge` los calcula el servidor con lo que manda el cliente.** Cada edición lleva `base`: los valores que el cliente leyó en las columnas escribibles que **no** tocó. Un campo de `base` cuyo valor actual ya es otro lo cambió otro usuario → aviso. Solo columnas escribibles: un cambio del sistema en una de solo lectura (el DPD del ledger) no es «otro usuario». La huella de SB-4 se calcula sobre las mismas columnas | ✅ |
| **SB-17** | **Mismo campo, mismo valor, no es conflicto.** Si otro dejó el campo justo en el valor que pide el cliente, se aplica sin preguntar; igual al guardar que al recargar | ✅ |
| **SB-18** | **Idempotencia dentro de SpreadBase.** El motor recibe la `Idempotency-Key` y guarda llave y respuesta con la fuente, **en la misma transacción que el lote**: o se confirma todo o nada. En memoria, un mapa; con Postgres, la tabla `spreadbase_idempotency`, que **crea la librería** (`CREATE TABLE IF NOT EXISTS`). Sustituye al middleware `idempotent()` | ✅ |
| **SB-19** | **La transacción la trae la fuente.** Si la fuente tiene `transaction`, el motor corre el lote dentro: bloquea las filas (`lock`), compara, aplica y guarda la respuesta idempotente. Los handlers reciben la transacción en `ctx.tx` y escriben con ella. Quien usa la librería no la configura. Sin transacción (memoria), el motor aplica los lotes de uno en uno. Detalle: `02-fuentes-transacciones-handlers.md` | ✅ |
| **SB-20** | **Un error de dominio aborta el lote entero.** Si un handler lanza, la transacción se deshace y no queda nada escrito; el cliente conserva sus cambios. Tratarlo por fila, como un conflicto, queda para cuando un caso real lo pida | ✅ |
| **SB-21** | **Columna `lookup`: elegir un registro de otro recurso, configurada en el servidor** (2026-09-28). Se guarda `value` (el id) y se ve `display`. El popover es una mini tabla HTML con el tema de la hoja —no otra jspreadsheet—, con encabezado fijo (ninguno si hay una sola columna) y **paginada desde el principio**. La columna declara `search` (paginado), `byIds` (nombres de cada página y validación al guardar) y `resolve` (opcional, para pegar). Pegar resuelve en tres pasos —memoria de lo copiado, nombres conocidos, una sola petición con los textos únicos— y se aplica como un solo paso del historial. SpreadBase exige solo la forma del objeto `lookup`; que lo defina el módulo dueño del recurso y que la hoja sea una función con sus dependencias es la organización recomendada, no un requisito. Detalle: `03-lookup.md` | ✅ |
| **SB-22** | **Contraseña como tipo de columna; el hash lo pone el motor** (2026-09-28). La columna `PASSWORD` declara `hash(plain, ctx)` (obligatoria: sin ella no arranca). Lo guardado nunca sale: el motor lo cambia por una marca opaca (`pwd:…`, por fila) en toda fila que devuelve, sea cual sea la fuente; la concurrencia por campo funciona sobre la marca. Handlers y fuente solo ven el hash. No se filtra ni se ordena por ella. En el cliente, vacío es «no cambiarla» y nunca se guarda en el borrador local. Junto con ella entra `BOOLEAN` (casilla). Detalle: `04-tipos-de-columna.md` | ✅ |
| **SB-23** | **Columnas del cliente sobre el esquema del servidor** (2026-09-28). El servidor define la hoja (SB-12), pero lo que es de la pantalla —qué hacer al pulsar, un ancho, un título— se decide en el cliente: `new Sheet(url, { columns, actions })`. `columns[field]` es un **parche** que se mezcla sobre la columna del servidor, o una **función** que la recibe y devuelve la final; el campo nunca se renombra. Un campo que no está en el esquema es una columna **solo del cliente** (`at: 'start' \| 'end'`), siempre de solo lectura: no hay dónde guardarla. `actions` es un **atajo**: cada acción es una columna `action` al principio (`__action_0`…), a la que después se le aplican los ajustes de `columns` como a cualquier otra. Por debajo es una sola función pura, `applyColumnOverrides` | ✅ |
| **SB-24** | **La barra en tres secciones y extensible** (2026-09-28). De izquierda a derecha: **edición** (deshacer, portapapeles, filas, recargar, descartar; solo icono, lo que no cabe pasa a ⋮), **acciones** (Guardar y los botones propios de la página, con texto; nunca se ocultan) y **paneles** (Filtros, Grupos, Cambios; al extremo derecho). Los botones propios se pasan en `toolbar={{ actions: [{ label, icon, onclick, variant, disabled }] }}`; `variant` es `outline` por defecto, porque la acción primaria de la vista suele ser Guardar. Además, las filas invisibles con que la barra y `PanelButton` miden sus botones van dentro de una caja recortada: sueltas, desbordaban y daban scroll horizontal a la página que contiene la hoja | ✅ |
| **SB-34** | **Importar a través de un formato** (2026-09-30). Un **formato** (`importFormat`, server) declara columnas como una hoja —mismos tipos y reglas, `lookup` incluido— sin tabla detrás, más `aliases` (otros encabezados con que puede venir: «Razón Social» = «Nombre fiscal») y **de dónde sale cada dato**: `from: 'file'` (columna del archivo), `'form'` (un valor para todas las filas, se pide una vez) o `'either'` (del archivo si trae la columna; si no, del formulario). También su `key` (crear o actualizar; no se repite en un archivo), el encabezado que lo identifica y el pie con la **suma de control**. La app solo escribe `review` (qué haría) y `apply` (hacerlo); SpreadBase valida antes, en ambos, lo que valida una hoja. `importRoutes([...])` monta lista, esquema, lookups de la vista previa, `review` y `apply` (cuerpo JSON: `{ rows, fields, fileName, checksum, force }`). En el cliente, **`<SheetImport url>`**: a la izquierda el formato y **solo los datos que el archivo no trae**, lo leído y lo que dijo el servidor; a la derecha la **vista previa**, una hoja local donde se suelta un Excel o CSV (se lee en el navegador; `exceljs` se carga al usarlo), se pega desde una hoja de cálculo o se escribe, y se corrige. La tabla se encuentra sola (`locateTable`, core: encabezado donde esté, por etiqueta o alias sin acentos, columnas de más se ignoran) y cada valor se interpreta con el tipo de su columna, como al pegar (las fechas de Excel son días UTC). **Revisar** marca en la celda lo que encontró el servidor (`GridController.setExternalErrors`; corregir la celda quita la marca) y editar pide revisar otra vez; lo que la app frena y se puede forzar (el guardarraíl de un corte) se aplica con confirmación. Un libro con varias hojas (instrucciones primero) se lee en la hoja que más columnas del formato reconoce; una columna que el archivo no trae toma su valor por omisión. Los `lookup` pueden resolver por otros campos además del nombre (`resolveBy`: la clave «YADI» → Yadira), también al pegar en una hoja. `ImportState` es el estado sin interfaz. Ejemplo `/imports` (contactos a la hoja básica); pruebas IMP-A1…IMP-A8 y IMP-1…IMP-4 | ✅ |
| **SB-33** | **Ordenar y filtrar desde el encabezado, como Excel** (2026-09-30). Cada columna que el servidor sabe filtrar trae un menú ⌄ en su encabezado: **ordenar** (ascendente o descendente), **filtrar por condición** según el tipo —texto: es igual, no es igual, contiene, no contiene, empieza con, termina con; número y fecha: `=`, `≠`, `>`, `>=`, `<`, `<=`, entre; todas: vacía, no vacía— y **filtrar por valores** (lista con casillas, buscador y la cuenta de cada valor, como Excel: con los demás filtros aplicados). Uno por columna; entre columnas, Y. Viajan en `?where=[{ field, op, value, value2, values }]` (JSON) y `?sort=`; los filtros fijos (SB-28) siguen aparte y se suman. La regla es una sola, `matchesFilter` de core: la fuente en memoria la usa tal cual y `postgresSource` la traduce a SQL con el mismo resultado (texto sin acentos ni mayúsculas, `%` y `_` literales, «no es igual» y «no contiene» incluyen vacías, la fecha-hora se compara por día, texto vacío = vacío). `GET /values/:field` da los valores distintos (hasta 1 000, con `truncated`; en un `lookup`, con nombres). El motor rechaza (400) un operador que no aplica al tipo o sin valor; contraseñas nunca. En el cliente: `Sheet(url, { sort })` fija el orden inicial; la consulta de la persona se recuerda en la pestaña (`sessionStorage`); el panel **Filtros** los dice en palabras y los quita; la barra cuenta los activos. Filtrar recarga desde el inicio sin perder cambios pendientes (G-9). Solo con servidor: una hoja local no ofrece el menú. Junto con él, `hidden: true` también en la columna del **servidor**: la fila la trae y se filtra por ella (`filters: { contract_id }`), pero no se pinta; el cliente la muestra con `hidden: false`. Pruebas: `tests/postgres/filtros.test.ts` (memoria y Postgres contra la misma regla) y FC-1…FC-5 en navegador | ✅ |
| **SB-32** | **Un registro como formulario guardable: la ficha** (2026-09-30). `new RecordForm(sheet, id, { fields?, exclude?, columns? })` lee el registro por la lista filtrada por id (trae los nombres y fotos de sus `lookup`) y arma un `FormState` con las columnas **editables** de la hoja: los mismos editores y reglas (`Field`). `save()` es un lote de la hoja con solo lo cambiado, la versión leída y `base`: la misma concurrencia que la hoja (mismo campo → `conflict`, con `reload()` u `overwrite()`; otro campo → se combina). Los errores del servidor de un campo aparecen en ese campo (`FormState.setServerError`); los demás, en `saveError`. `dirty`, `reset()`, `savedCount`. `Sheet.client()` da el cliente HTTP de la hoja a piezas fuera del grid. §4.3; ejemplo `/ficha`; pruebas FR-1…FR-5 | ✅ |
| **SB-31** | **Ajustes de la hoja para vistas filtradas y ventanas** (2026-09-30). `columns: { campo: { hidden: true } }` saca una columna de la vista (la que ya dice el contexto: el cliente, en la Ficha de ese cliente). Los **filtros fijos** (SB-28) ahora también son valores de las filas nuevas (`GridConfig.fixedValues`): una alta en la hoja filtrada nace dentro del filtro aunque su columna esté oculta. `actions: [{ …, variant: 'primary' }]`: el botón por fila con el color de acento, como la acción principal de la página. Los editores de celda se montan dentro de un `<dialog>` abierto: `Field` funciona en una ventana modal. Pruebas AC-7, AC-8 y `columns.test.ts` | ✅ |
| **SB-30** | **Subir archivos; columna de archivo** (2026-09-30). `upload: { storage, maxSize?, accept?, allow? }` en columnas `image` y el tipo nuevo `FILE`. El destino es configurable: `diskStorage({ dir, publicUrl })` (carpeta del servidor) o uno propio con `save(file, ctx) → url` (un bucket). `POST /upload/:field` (en `sheetRouter`, o `sheetUpload(sheet)` junto a rutas a mano) recibe los bytes tal cual y devuelve la URL; la celda la guarda con el lote, como cualquier cambio. El **valor sigue siendo texto** (la URL): el archivo se guarda en `<carpeta aleatoria>/<nombre limpio>` y la celda muestra el nombre, que es el final de la URL. Seguridad del motor: tipo real por contenido, tamaño máximo, nombre aleatorio, SVG y HTML nunca; `serve()` con `nosniff`, CSP y descarga para lo que no es imagen, PDF o texto. §4.5; pruebas UP-1…UP-7 y AR-1…AR-5 | ✅ |
| **SB-29** | **Miniatura antes del texto: foto, iniciales o ícono** (2026-09-29). Opción `avatar: { image?, initials?, icon?, shape? }` en columnas `text` y `lookup`. Orden de respaldo: la foto; si no hay o el enlace no carga, las iniciales (si `initials`); si no, el ícono; si no, uno genérico (persona si es redonda, edificio si es cuadrada). En un `lookup` la foto es del registro elegido: el servidor la manda por id en `Page.images` junto a `labels`; en texto, de otro campo de la misma fila. Iniciales sin formas de sociedad ni artículos («Transportes del Norte SA de CV» → «TN») y con un color estable por texto (8 tonos del tema). Íconos de lucide por nombre, extensibles con `registerIcons`. Es presentación: el valor, lo que se copia, busca y guarda sigue siendo el texto o el id; nada de HTML de los datos. §4.4; pruebas AV-1…AV-7 | ✅ |
| **SB-28** | **Filtros fijos de una hoja** (2026-09-29): `new Sheet(url, { filters: { customer_id: id } })` manda esos filtros en cada lectura de filas y de posición, como los filtros por columna del protocolo. Muestra una parte del recurso —el estado de cuenta de un cliente— con la misma hoja del servidor. El borrador local es de esa parte (su id lleva los filtros). Es una vista, no un permiso. Ejemplo `/basic?status=inactive`; prueba AC-7. Con él, `FormState.set(campo, valor, etiqueta)` para un `lookup` que llega ya elegido | ✅ |
| **SB-27** | **Escribir en la hoja desde fuera** (2026-09-29): `grid.commands.setValues([{ rowKey, field, value }])`, para los botones propios de la barra (SB-24) y las páginas que reparten, limpian o rellenan. Pasa por el mismo camino que teclear: el tipo interpreta el valor, se valida, queda como cambio pendiente y **un solo ⌘Z** lo deshace; con la hoja montada, la repinta (antes, `setCellValueByKey` cambiaba el dato pero la celda seguía mostrando el valor viejo). Ejemplo: «Límite en cero» en `/basic`; prueba AC-6 | ✅ |
| **SB-26** | **Kit de contrato** (2026-09-29): paquete `@spreadbase/testing` con `sheetContract()`, que una app corre contra cada hoja suya: cinco casos por HTTP (mismo campo, otro campo, eliminar lo editado, reintento idempotente, escritura externa) que prueban que su conexión al motor conserva la concurrencia. La suite completa sigue siendo de SpreadBase; la app no la repite. §7.1 | ✅ |
| **SB-25** | **Formularios con las columnas y los editores de la hoja** (2026-09-29). `Field` y `FormState` se exportan como `Toolbar`: un formulario lee las columnas del esquema de una hoja (o de una lista propia), y cada campo usa el tipo de celda completo —`parse`, `format`, `validate` y el **mismo editor**, anclado al campo, que hace de anfitrión como jspreadsheet—. Así una fecha o un registro se eligen y se validan igual en la hoja y en un alta. Ajustes por columna solo en el formulario con `columns` (p. ej. `readOnly: false` para capturar en el alta lo que la hoja ya no deja cambiar). §4.3 | ✅ |

---

## 3. Paquetes

| Paquete | Lo instala | Contiene | Se extrae de (OpenCollect) |
|---|---|---|---|
| **`@spreadbase/server`** | El backend | `SpreadBase` (motor: lectura, posición, lote con la regla por campo, `merge`/`strict`, idempotencia, eventos); fuentes (`memorySource`, `postgresSource`); helpers HTTP (`parseListQuery`, `parseBatch`, errores tipados, `sheetRouter()`) | `backend/src/modules/sandbox/sandbox.service.ts` sin los datos de casos; `common/idempotency.ts`, `common/errors.ts` |
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
	batch    = async (req, res) => {
		const { result, replayed } = await this.service.portfolio.batch(parseBatch(req.body), {
			idempotencyKey: req.get('Idempotency-Key'),   // SB-18: la idempotencia la lleva el motor
			context: { user: req.user }                    // llega a los handlers
		});
		if (replayed) res.set('Idempotent-Replayed', 'true');
		res.json(result);
	};
}
```

**Rutas**: las de la app, con sus middlewares.

```ts
// cases.routes.ts
router.get('/portfolio/schema', c.schema);
router.get('/portfolio', c.list);
router.get('/portfolio/:id/position', c.position);
router.get('/portfolio/:id', c.get);
router.post('/portfolio/batch', c.batch);
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
| Quickstart, ejemplo básico, herramientas internas | `sheetRouter()` |
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

**Qué guarda `sheet`:** el esquema recibido (`sheet.schema`) y, cuando ya lo
tiene, el controlador de la hoja (`sheet.grid`): la ventana de filas cargadas,
los cambios pendientes, el historial, el borrador en IndexedDB, los conflictos
y el estado del guardado. El componente solo lo dibuja. Tenerlo fuera del
componente es lo que permite escucharlo (`sheet.grid?.rowSummary`,
`sheet.grid?.hasPendingChanges`), guardar desde otro botón
(`sheet.grid?.commands.save()`) o montar una barra propia (`<Toolbar>`).

Crear un `Sheet` no hace peticiones: `<SpreadBase>` llama a `sheet.connect()`
al montarse. Así se puede crear en el `<script>` de una página con SSR. Si
falla, `sheet.error` dice por qué y el componente ofrece reintentar.

**Lo que solo existe en el cliente** se agrega al crearlo: anchos, el buscador
de un `remote-select`, editores propios.

```ts
new Sheet('/api/cases/portfolio', {
	columns: { customer_name: { width: 260 }, customer_id: { search: searchCustomers } }
});
```

**Sin servidor** (fuente local; la página «Sin servidor» de los ejemplos):
la definición se escribe en el front.

```ts
new Sheet({ id: 'charges', columns, dataSource: { load: loadCharges, save: saveCharges } });
```

**Límite de validación:** las reglas declarativas viajan con el esquema y el
front las aplica igual que el back mientras se edita (obligatorio, mínimo y
máximo, longitud, opciones, patrón). Una regla escrita como **función** en el
backend («pagado ≤ importe») no viaja por HTTP: su error aparece al guardar,
salvo que el dev la repita en el `Sheet`.

### 4.3 Formularios con las columnas de la hoja (SB-25)

Un alta con asistente, un filtro, un diálogo: lo que no es una hoja pero elige
las mismas cosas. `Field` y `FormState` se usan fuera de la hoja igual que
`Toolbar`: se importan y se ponen donde haga falta.

```svelte
<script lang="ts">
	import { Field, FormState, Sheet } from '@spreadbase/client';

	// Las columnas salen del esquema de la hoja, con sus búsquedas conectadas.
	const form = new FormState(new Sheet('/api/contracts/sheet'), {
		customer_id: null, start_date: null, payment_frequency: 'mensual'
	}, {
		// Ajustes solo aquí: el cliente es de solo lectura en la hoja, no en el alta.
		columns: { customer_id: { readOnly: false, required: true } }
	});
</script>

<Field {form} name="customer_id" />   <!-- la mini tabla de la celda -->
<Field {form} name="start_date" />    <!-- el calendario de la celda -->
<button onclick={() => (form.touchAll(), form.valid && next())}>Siguiente</button>
```

- **Los campos del formulario** son las claves del segundo argumento; la hoja
  puede tener más columnas. También acepta una lista de `ColumnDef` escrita en
  el cliente, sin servidor.
- **El control es el de la celda.** En los tipos con editor propio (fecha,
  fecha-hora, lista, `lookup`, imagen, contraseña) `Field` abre ese mismo
  editor anclado al campo: el campo hace de anfitrión, como jspreadsheet en la
  hoja (`closeEditor(celda, guardar)`), así que no hay una segunda versión del
  calendario ni de la mini tabla. Texto y número son un `input` interpretado
  con el `parse` del tipo; la casilla, un `checkbox`.
- **Las reglas son las del tipo** (`validate`): obligatorio, patrón, rango,
  «no corresponde a ningún registro». El error aparece al dejar el campo o con
  `form.touchAll()`; `form.valid` las junta. El servidor sigue siendo la
  autoridad al guardar.
- Estilo con daisyUI (`fieldset`, `input`, `label`), como los demás componentes.
- Un `lookup` con `avatar` muestra en el campo la foto, iniciales o ícono del
  elegido, como la celda (SB-29). `form.set(campo, id, nombre, foto)` para uno
  que llega ya elegido.

Ejemplo: `/form` (alta de producto sobre la hoja de Postgres).

**La ficha de un registro (SB-32).** Para editar uno que ya existe, con la
concurrencia de la hoja:

```svelte
<script lang="ts">
	const record = new RecordForm(new Sheet('/api/customers/sheet'), id, { exclude: ['assigned_user_id'] });
</script>

{#if record.form}
	{#each record.fields as name (name)}<Field form={record.form} {name} />{/each}
	{#if record.conflict}Otra persona cambió {record.conflict.join(', ')}… <button onclick={() => record.overwrite()}>Guardar lo mío</button>{/if}
	<button disabled={!record.dirty} onclick={() => record.reset()}>Descartar</button>
	<button disabled={!record.dirty || record.saving} onclick={() => record.save()}>Guardar</button>
{/if}
```

Ejemplo: `/ficha?id=c_00001` (un contacto de la hoja básica).

### 4.4 Miniaturas en celdas (SB-29)

Una persona se reconoce por su foto, una empresa por sus iniciales. La columna
lo declara en el servidor, en la misma hoja:

```ts
// La foto del asesor elegido (lookup); sin foto o rota, sus iniciales.
assigned_user_id: { type: types.LOOKUP, label: 'Asesor', lookup: users, avatar: { image: 'avatar_url', initials: true } },
// Las iniciales de la empresa, cuadradas y con su color: «TN».
name: { type: types.TEXT, label: 'Cliente', avatar: { initials: true, shape: 'square' } },
// Solo ícono.
issuer: { type: types.TEXT, label: 'Emisora', avatar: { icon: 'landmark', shape: 'square' } },
```

| Opción | Qué hace |
|---|---|
| `image` | Campo con la URL. En `lookup`, del registro elegido (lo manda el servidor en `Page.images`; el popover lo toma de la fila elegida). En `text`, de la misma fila. Solo `http(s)://`, `/…` o `data:image/`. |
| `initials` | Hasta dos iniciales, sin `SA`, `CV`, `SAPI`, `de`, `del`… Color estable por texto (`--dg-avatar-1…8`). |
| `icon` | Nombre de un ícono: `user`, `user-round`, `users`, `building`, `store`, `truck`, `bot`, `landmark`, `mail`, `phone`, `file-text`. Más con `registerIcons({ tractor: Tractor })` en el cliente. |
| `shape` | `round` (default, personas) o `square` (empresas). |

- **Respaldo:** foto → iniciales → ícono → genérico (persona o edificio).
- **Dónde va:** en las hojas que **eligen** el registro (un `lookup`: el asesor
  de un cliente, el cliente de un contrato), junto al nombre. En la hoja
  **dueña** de la imagen (Usuarios, Clientes), la imagen va en su propia
  columna `image`, a la izquierda del nombre y ahí se cambia; el nombre no la
  repite.
- **Solo presentación.** Las iniciales van en un atributo pintado con CSS: el
  texto de la celda, lo copiado, la búsqueda y lo guardado no cambian.
- **Edición:** el texto con miniatura se edita dentro de la celda, como el
  nativo (Enter confirma, Esc descarta). En `Field` sigue siendo un `input`.
- **Tema:** `--dg-avatar-size`, `--dg-avatar-fg`, `--dg-avatar-icon-bg/fg` y
  `--dg-avatar-1…8`; `theme-daisyui.css` los mezcla con los colores del tema.

Ejemplos: «Cliente» en `/cases` (iniciales) y «Responsable» en `/postgres` (foto).

### 4.5 Archivos e imágenes subidos (SB-30)

El destino se declara una vez; la columna lo usa con `upload`:

```ts
import { diskStorage, types } from '@spreadbase/server';

// Una carpeta del servidor. Mañana, un bucket con el mismo `save(file, ctx) → url`.
const docs = diskStorage({ dir: './uploads/docs', publicUrl: 'https://api.midominio.mx/uploads/docs' });

columns: {
	logo_url: { type: types.IMAGE, label: 'Logo', upload: { storage: logos, maxSize: '2mb' } },
	contract_file: {
		type: types.FILE,
		label: 'Contrato firmado',
		upload: { storage: docs, maxSize: '10mb', accept: ['application/pdf'], allow: (ctx) => ctx.user?.role !== 'lectura' }
	}
}

// Servir lo guardado; los documentos privados, detrás de la sesión de la app.
app.use('/uploads/docs', requireAuth, docs.serve());
```

- **Ruta:** `sheetRouter` ya trae `POST /upload/:field`. Con rutas escritas a
  mano, `router.use(sheetUpload(sheet))`. **Sin la ruta montada, el esquema no
  anuncia `upload`** y el cliente no muestra «Subir»: nunca un botón que acaba
  en 404.
- **Celda de archivo:** ícono por tipo, el nombre y ↗ para abrirlo. Copiar da
  la URL (pegarla en otra fila es el mismo archivo).
- **Editor** (imagen y archivo, también en `Field`): pegar una URL, **Subir**,
  arrastrar o pegar el archivo. Al subir, la URL queda en la celda, editada, y
  se guarda con **Guardar**; deshacer, borrador y conflictos no cambian.
- **El valor es la URL.** El archivo se guarda como
  `<carpeta aleatoria>/<nombre limpio>`: nadie adivina la ruta de otro, dos
  nombres iguales no chocan y la celda muestra el nombre sin guardarlo aparte.
- **Seguridad (del motor, no de cada app):** el tipo real se revisa por el
  contenido (un HTML renombrado a `.png` no pasa y un PNG llamado `.pdf` se
  guarda como `.png`); tamaño máximo cortado al leer; SVG y HTML nunca;
  `allow(ctx)` para permisos. `serve()` pone `nosniff`, una CSP sin scripts y
  descarga lo que no es imagen, PDF o texto.
- **Tipos por omisión:** `image`, PNG, JPEG, WebP y GIF; `file`, además PDF y
  XML. Se reconocen también CSV, texto, zip y los de Office.
- **Pendiente:** varios archivos por celda y borrar los que nadie usa (se sube
  y luego se descarta el cambio).

Ejemplos: «Contrato» en `/cases`, «Foto» en `/postgres` y en `/form`.

---

## 5. Protocolo

### 5.1 Rutas bajo la base de la hoja

| Método | Ruta | Respuesta |
|---|---|---|
| `GET` | `/schema` | Columnas (tipo, reglas declarativas, pistas visuales), `idField`, `allowInsert`, `allowDelete`, `policy` |
| `GET` | `/?offset&limit&sort=campo:asc\|desc&search=&where=[…]&<campo>=a,b` | `{ rows, total, offset, limit, version }`. Orden **siempre con desempate por id**. `limit` ≤ 500. `where`: filtros por columna en JSON (SB-33) |
| `GET` | `/values/:field?where=[…]&<campo>=a,b` | `{ values: [{ value, count }], truncated, labels? }`: valores distintos de la columna en la consulta, vacías primero (SB-33) |
| `GET` | `/:id` | Una fila, con `rowVersion` |
| `GET` | `/:id/position?…` | `{ id, position, total }` dentro de la misma consulta; `position: null` si la consulta la excluye |
| `POST` | `/batch` | Lote de guardado (§5.2). Acepta `Idempotency-Key` |
| `GET` | `/lookup/:field?q&offset&limit` | Filas del recurso de una columna `lookup`, paginadas: `{ rows, total, offset, limit }` (SB-21) |
| `POST` | `/lookup/:field/resolve` | `{ texts }` → `{ matches }`: texto pegado → filas que coinciden (SB-21) |
| `GET` | `<imports>/`, `/:format/schema` | Formatos de importación y su esquema: columnas con `aliases` y `from`, `key`, `header`, `footer` (SB-34) |
| `POST` | `<imports>/:format/review`, `/:format/apply` | `{ rows, fields, fileName?, checksum?, force? }` → `{ ok, applied, summary, issues: [{ row, field, level, message }], blocked }` (SB-34) |
| `POST` | `/upload/:field` | Bytes del archivo (nombre en `X-File-Name`) → `201 { url, name, type, size }`. Solo columnas con `upload` (SB-30) |

Con columnas `lookup`, cada página trae además `labels`: el nombre de cada id
del tramo (`03-lookup.md` §4); si la columna lleva `avatar.image`, también
`images`: la URL de la foto de cada id (SB-29).

Paginación por **offset**, no por cursor: permite saltar a una posición (ir a
una fila desde el panel de cambios). Se revisa si el volumen crece un orden de
magnitud.

### 5.2 Lote de guardado

```jsonc
// Petición
{
	"creates": [{ "key": "tmp_m0", "values": { "customer_rfc": "…" } }],
	"updates": [{
		"id": "case_002344",
		"rowVersion": "9c1e…",                                        // testigo opaco que leyó (SB-4)
		"changes": { "stage_code": { "from": "early", "to": "judicial" } },   // solo lo que tocó
		"base": { "customer_name": "…", "handler_id": "usr_2" }       // lo que leyó en las escribibles que NO tocó (SB-16)
	}],
	"deletes": [{ "id": "case_000008", "rowVersion": "41b0…" }]
}

// Respuesta 200 — éxito parcial
{
	"created":   [{ "key": "tmp_m0", "row": { … } }],
	"updated":   [{ "id": "case_002344", "rowVersion": "e77a…", … }],
	"deleted":   ["case_000008"],
	"notices":   [{ "id": "case_002344", "fields": ["handler_id"] }],
	"conflicts": [{ "op": "update", "id": "case_000900", "reason": "field_conflict",
	                "fields": [{ "field": "stage_code", "from": "early", "yours": "judicial", "remote": "late" }],
	                "remote": { … } }]
}
```

Reglas (probadas en OpenCollect, SB-5):

- **Atajo:** si el `rowVersion` actual es el que leyó el cliente, nadie tocó la
  fila: se aplica sin comparar.
- **Por cada campo que la petición cambia:** valor actual = `from` → se
  aplica; distinto → `field_conflict`, **salvo que el valor actual ya sea el
  que pide el cliente** (`to`, SB-17). La misma regla aplica el cliente al
  recargar. La comparación es normalizada por tipo (`1500` = `"1500.00"`).
- **Cambios ajenos en otros campos** —los de `base` cuyo valor actual ya es
  otro—, según la política de la hoja, fijada en el servidor: `merge` los
  conserva y los informa en `notices`; `strict` rechaza la fila con
  `version_mismatch`.
- **Eliminar lo que otro editó** es siempre conflicto (el `rowVersion` no
  coincide). Eliminar lo que otro ya eliminó se reporta como eliminado. Editar
  lo que otro eliminó: `not_found`.
- **Un conflicto no bloquea el resto del lote.** Un lote mal formado (campo
  inexistente, de solo lectura o valor inválido) se rechaza entero con 400. Un
  error de un handler de dominio deshace el lote entero (SB-20).
- **Idempotencia (SB-18):** la misma llave devuelve la misma respuesta sin
  reaplicar (`Idempotent-Replayed: true`); la misma llave con otro cuerpo, 422.
  Un error no se guarda: se puede reintentar.

### 5.3 Fuente de datos (SB-2, SB-4, SB-19)

```ts
// packages/server/src/source.ts — cada método puede devolver el valor o una promesa
interface SheetSource {
	attach?(definition: SheetDefinition): void;          // conoce las columnas
	list(q: ListQuery): Page;                             // orden y filtros; desempate por id
	position(id: string, q: ListQuery): { position: number | null; total: number };
	get(id: string): Row | undefined;                     // con su rowVersion
	insert(values): Row;                                  // escritura directa, si no hay handlers
	update(id: string, values): Row;                      // devuelve la fila con su nuevo rowVersion
	remove(id: string): void;

	// Opcional: lo que aporta una base transaccional
	transaction?<T>(fn: (tx: SheetTx) => Promise<T>): Promise<T>;
	idempotency?: IdempotencyStore;                       // si no, el motor guarda en memoria
}

interface SheetTx extends SheetSource {
	lock(ids: string[]): Promise<void>;                   // SELECT … FOR UPDATE, en orden de id
	db: unknown;                                          // la conexión: los handlers escriben con ella
}
```

Existen `memorySource` (contador de versión; sin transacción: el motor aplica
los lotes de uno en uno) y `postgresSource` (huella de contenido, transacción,
bloqueo e idempotencia en la base). Cómo conviven fuente, transacción y
handlers, con un ejemplo en un proyecto anfitrión en JavaScript:
`02-fuentes-transacciones-handlers.md`.

**La tabla del usuario no necesita nada especial** (SB-4): ni columna de
versión, ni trigger, ni tabla de cambios. Si ya tiene una columna de versión o
de fecha de modificación, se puede usar en lugar de la huella, por
rendimiento.

### 5.4 Eventos (SB-8)

Cada lote aplicado emite, por fila, `{ sheet, op, id, fields, rowVersion }` a
quien se suscriba con `sheet.subscribe(fn)`, **después** de confirmar la
transacción. Hoy no lo consume nadie; es el enganche para tiempo real.

---

## 6. Estructura del repo

```
SpreadBase/
├── packages/
│   ├── core/          @spreadbase/core
│   ├── server/        @spreadbase/server
│   └── client/        @spreadbase/client
├── examples/          un servidor y una app para todos los ejemplos (SB-11)
│   ├── backend/       base común (src/app.ts) + src/examples/{basic,postgres,cases}
│   └── frontend/      índice + una página por ejemplo (basic, postgres, cases, local)
├── tests/             E2E por módulo contra los ejemplos, y fuentes contra una base real (§7)
└── docs/
```

El ejemplo de **casos** está en capas como un módulo de OpenCollect
(`cases.routes → cases.controller → cases.service`), con las rutas escritas a
mano. El **básico** usa el atajo `sheetRouter()`. El de **Postgres** es un
backend JS con la estructura de Aggy (orquestador, `core/api/<módulo>`). Entre
los tres cubren las formas del §4.1.

**Estilos del cliente.** Los componentes solo usan clases de Tailwind/daisyUI y
sus propios CSS. La app declara `@source` hacia `@spreadbase/client/src` para
que Tailwind genere esas clases, e importa `@spreadbase/client/theme-daisyui.css`
para que la hoja tome los colores del tema.

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
| `tests/protocol/` | Las reglas del §5: lectura, lote, concurrencia por campo, idempotencia. 23 casos: con `merge` pasan 22 y se omite 1; con `strict`, 20 y se omiten 3 |
| `tests/grid/` | Navegador: los 32 escenarios de su README (básicas, ventana, borrador, concurrencia A/B y red), más el recorrido con y sin servidor; L-1 a L-5 (lookup) y T-1 a T-5 (contraseña y casilla) sobre el ejemplo de Postgres |
| `tests/postgres/` | `postgresSource` (23), columnas lookup (15), contraseña y booleano (11) y orden (4) contra una base real |
| `packages/client/src/…test.ts` | Propiedades del historial: deshacer una acción ≙ repetir todo sin ella |
| `tests/contract/` | El kit de contrato (SB-26) contra la hoja de casos (memoria) y la de productos (Postgres, escritura externa por SQL): 10 casos |

### 7.1 Qué garantiza SpreadBase y qué prueba la app (2026-09-29)

La concurrencia —conflicto por campo, `merge`/`strict`, bloqueo en la
transacción, idempotencia— es del motor y se prueba **aquí, una vez**
(`protocol/`, `grid/concurrencia`, `postgres/source`). Una app que usa
SpreadBase **no repite esa suite** por módulo.

Lo que la app sí prueba en cada hoja es **su conexión** al motor, porque ahí
puede romper la garantía sin tocar la librería: una vista sin una columna
editable, una `versionColumn` que un handler o un proceso externo no actualiza,
un handler que escribe fuera de `ctx.tx`, rutas que no pasan
`Idempotency-Key`. Para eso está el **kit de contrato** (`@spreadbase/testing`,
SB-26): la app lo llama una vez por hoja y registra cinco casos por HTTP.

```ts
import { edit, sheetContract } from '@spreadbase/testing';

sheetContract({
	name: 'clientes',
	url: `${API}/api/customers/sheet`,          // la misma URL que new Sheet(url)
	reset: () => post('/api/customers/dev/reset'),
	edits: [edit.text('name'), edit.toggle('active')],
	external: (id, field) => sql(`UPDATE customers SET ${field} = … WHERE id = $1`, [id])
});
```

| Caso | Si falla, la hoja… |
|---|---|
| K-1 mismo campo → `field_conflict` y no pisa | no detecta versiones (huella o `versionColumn`) |
| K-2 otro campo → se combina con aviso (`strict`: se rechaza) | su vista no trae una columna editable |
| K-3 eliminar lo editado → conflicto (si admite bajas) | sus bajas no respetan la versión |
| K-4 reintento con la misma llave → no duplica; otra petición con la llave → 422 | sus rutas no pasan `Idempotency-Key` |
| K-5 otro proceso escribió por fuera → conflicto (si se da `external`) | lo que escribe fuera no mueve la versión |

`edit.text`, `edit.toggle`, `edit.option` y `edit.lookup` generan valores
válidos según el tipo de la columna (tomado del esquema); `edit.custom`, lo
demás. Con un solo campo editable (una hoja casi de solo lectura), K-2 se
omite. El kit se prueba contra los ejemplos en `tests/contract/`.

Una hoja con fuente local (`dataSource: { load, save }`) no tiene concurrencia:
cada navegador tiene su copia.

---

## 8. Plan y estado

| # | Paso | Estado |
|---|---|---|
| 1 | Base del repo (workspaces, TypeScript, Vitest) | ✅ |
| 2 | Copia probada de OpenCollect como punto de partida | ✅ |
| 3 | Commit del punto de partida | ✅ |
| 4 | `core`: tipos de columna y del protocolo, normalización y validación | ✅ |
| 5 | `server`: `SpreadBase`, `memorySource`, `parseListQuery`/`parseBatch`, `sheetRouter()`. Ejemplo de casos en capas. Protocolo en verde con `merge` y `strict` | ✅ |
| 6 | `client`: `Sheet` + `<SpreadBase>` cargando `/schema`. Páginas con y sin servidor. Propiedad del historial y recorrido en navegador en verde | ✅ |
| 7 | Ejemplo básico (verificado en navegador: esquema, validación por patrón, guardado) | ✅ |
| 8 | Retirar la copia temporal, `apps/demo` y el código anterior de `packages/` | ✅ |
| 9 | E2E de navegador en `tests/grid/`: los 32 escenarios (§7) | ✅ |
| 10 | OpenCollect consume los paquetes y borra su copia; segundo consumidor (SB-15). **Primer módulo hecho:** `users` (`/settings/users`), instalado por ruta local, con contraseña, casilla y reglas de dominio en handlers. `/cases` sigue con la copia anterior | 🟡 |
| 11 | `postgresSource` (SB-2, SB-4, SB-18, SB-19): 23 pruebas contra una base real y el ejemplo Postgres verificado en navegador | ✅ |
| 12 | Colaboración en tiempo real (SB-8) | ⬜ |
| 13 | Ejemplos en un solo servidor y una sola app (SB-11) | ✅ |
| 14 | Columna `lookup` (SB-21): protocolo, motor, popover con mini tabla paginada, pegado en tres pasos; 15 pruebas del motor y 5 de navegador | ✅ |
| 15 | Ejemplo de Postgres con un campo de cada tipo: texto, número, select, lookup, imagen, fecha y fecha-hora | ✅ |
| 16 | Tipos `PASSWORD` (SB-22) y `BOOLEAN`; hoja de usuarios en el ejemplo de Postgres; 11 pruebas del motor y T-1 a T-5 en navegador | ✅ |
| 17 | Orden por defecto de la hoja (`defaultSort`) y `collation` en `postgresSource` para ordenar texto en español (`es-x-icu`); 4 pruebas contra la base | ✅ |
| 18 | Columnas del cliente y acciones por fila (SB-23): `columns` (parche o función, columnas solo del cliente) y `actions`; 9 pruebas unitarias y AC-1 a AC-3 en navegador sobre `/basic` | ✅ |
| 19 | Barra en tres secciones con botones propios (SB-24) y sin desborde horizontal; AC-4 y AC-5 en navegador sobre `/basic` | ✅ |
| 21 | Kit de contrato `@spreadbase/testing` (SB-26), probado contra casos y productos (`tests/contract/`) | ✅ |
| 23 | Importar (SB-34): `importFormat`/`importRoutes`, `<SheetImport>` con vista previa editable, avisos del servidor en la celda; ejemplo `/imports`, 8 pruebas sin navegador y 4 en navegador | ✅ |
| 22 | Ordenar y filtrar desde el encabezado (SB-33): `where` en el protocolo, memoria y Postgres con la misma regla, `GET /values/:field`, menú de columna y panel Filtros; 10 pruebas contra la base y FC-1…FC-5 en navegador | ✅ |
| 20 | Formularios con las columnas de la hoja: `Field` y `FormState` (SB-25), ejemplo `/form`, F-1…F-5 en navegador (`tests/grid/form.test.ts`) | ✅ |

### Pendientes conocidos

- **Validación en dos implementaciones (SB-1 a medias).** Las reglas son una
  sola —viajan en el esquema—, pero las aplican dos códigos: `validateValue`
  de `core` en el servidor y los tipos de celda de `client` (`cellTypes.ts`,
  heredado de OpenCollect) en el navegador. Unificarlos exige tocar el grid
  probado; se hará con las pruebas del navegador completas.
- **`client/types.ts` repite tipos del protocolo** (`BatchRequest`,
  `BatchResponse`…) en lugar de importarlos de `core`.
- **Supabase:** `postgresSource` está probado contra Postgres 16 en Docker. Falta
  correr las mismas pruebas contra el proyecto de Supabase: hace falta su
  cadena de conexión (`DATABASE_URL`), no solo la llave de la API.
- **Nombres heredados:** las clases CSS siguen con prefijo `oc-` (`oc-grid`,
  `oc-cell-dirty`) y las pruebas dependen de ellas. Renombrar a `sb-` es un
  cambio mecánico que conviene hacer antes de publicar.
- **Tipos solo de cliente:** `action` (botón por fila) y `remote-select`
  existen en el cliente pero no en `core`: el servidor no los declara ni los
  valida. `remote-select` queda sustituido por `lookup` (SB-21).
- **Fecha-hora sin zona:** `postgresSource` la lee como `AAAA-MM-DD HH:mm`, el
  formato del cliente, en la zona de la sesión de la base. Leer otro formato
  hacía que `from` y `base` no coincidieran con lo guardado (conflictos y
  avisos falsos); con `timestamptz`, la hoja trabaja en la zona de la conexión.
- **Instalación por ruta local:** mientras no se publique, un proyecto consume
  los paquetes con `file:../../SpreadBase/packages/*`. En Vite hace falta
  `resolve.dedupe: ['svelte']` (una sola copia de Svelte) y permitir la carpeta
  en `server.fs.allow`; en Tailwind, `@source` hacia `node_modules/@spreadbase/client/src`.
- **Idempotencia en memoria** (`memorySource`): vale para un proceso. Con
  Postgres ya va en la base, en la misma transacción que el lote.
