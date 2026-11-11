# 05 — Asistente de importación con agente (SB-36)

> Cómo se arma, del lado del servidor, el asistente que convierte cualquier
> archivo (PDF, fotos, Excel, texto, zip) en filas de un formato SB-34, lo
> adjunta donde diga la app o lo descarta; y el contrato HTTP que consume el
> asistente del cliente.

**Creado:** 2026-10-08 · **Estado:** 🟢 servidor (agente, corrida, rutas, ejemplo) y cliente (`<ImportAssistant>`, `ImportAssistantState`) con la página de ejemplo `/import-assistant`. Rediseño v2 (§7): **fase A hecha** (2026-10-09: lo que se ve); **fase B hecha** (2026-10-09: el cerebro enchufable, §9). Segunda revisión (§8): **A2, S y T hechas** (2026-10-09, §8.7). Tercera (§10): **pestañas por destino, importar por destino, progreso en vivo y cerebro consciente de los stagings** (2026-10-09).

Primer consumidor: Aggy Legacy (spec `CHEV7H`). Piezas previas: `mongoSource`
(02 §4.3) y la extracción P/X (`packages/server/src/extraction/`).

---

## 1. Qué es de SpreadBase y qué es de la app

Mismo principio que la fuente (SB-2): **el LLM, el almacenamiento, la
persistencia de la corrida y la cola son de la app**. SpreadBase define las
interfaces, el flujo, las tools y las rutas, y trae una versión de cada pieza
para empezar.

| Pieza | Interfaz | Por omisión (SpreadBase) | En Aggy |
|---|---|---|---|
| Modelo | `ImportLLM` (`generateStructured`, `chat`) | — (sin `chat`, el agente trabaja con reglas) | Adaptador Gemini |
| Archivos | `ImportFileStorage` = `FileStorage` (SB-30) + `read` (+ `remove`) | `diskStorage` (ya trae `read`/`remove`), `memoryFileStorage` | GCS |
| Corridas | `ImportRunStore` | `memoryRunStore` | Mongo |
| Cola | `ImportRunner` | `inProcessRunner({ concurrencia })` | Worker de `core/queues/` |
| Destinos | formatos SB-34, `attach` de la app, descartar | — | Formato por DataTable, campo `folder` |
| Avisos | `onEvent` | — | Socket.IO, WhatsApp |

## 2. El agente

```ts
import { importAgent, importAssistantRoutes, inProcessRunner, memoryRunStore, diskStorage } from '@spreadbase/server';

const agent = importAgent({
	llm,                                   // ImportLLM de la app
	model: 'gemini-3.8-flash',             // se le pasa al adaptador
	prompt: 'Los planes vienen del boletín mensual de GM…',   // se suma al prompt base
	destinations: [
		{ tipo: 'filas', formato: planesGmf, modos: ['upsert', 'replace'], modo: 'replace', actuales: planesSheet },
		{ tipo: 'adjuntar', id: 'fichas', label: 'Ficha técnica', attach: async ({ destino, archivo, derivados, contexto }) => { … } },
		{ tipo: 'descartar' }
	],
	context: async (run) => 'La tabla tiene 57 planes de septiembre…',   // más contexto por corrida
	tools: [consultarRightLink],           // tools de la app
	runs: memoryRunStore(),
	runner: inProcessRunner({ concurrencia: 2 }),
	storage: diskStorage({ dir: 'uploads/imports', publicUrl: '/uploads/imports' }),
	limits: { maxArchivoMB: 50, maxLoteMB: 200, retencionDias: 30 },  // defaults
	owner: (ctx) => ctx.userId,            // de quién es cada corrida
	onEvent: (e) => io.to(e.corrida).emit('import', e)
});

router.use('/imports/assistant', importAssistantRoutes(agent, { context: (req) => ({ userId: req.user.id, accountId: req.account.id }) }));
```

### 2.1 `ImportLLM`

```ts
interface ImportLLM {
	// Método X: una respuesta que cumple un JSON Schema (por página).
	generateStructured(input: { instrucciones; imagenes: (Buffer | string)[]; texto?; schema; modelo? }): Promise<unknown>;
	// Bucle del agente: una vuelta con tools. Opcional.
	chat?(input: { sistema: string; mensajes: LLMMensaje[]; tools: LLMTool[]; modelo?: string }): Promise<LLMRespuesta>;
}

type LLMParte = { tipo: 'texto'; texto } | { tipo: 'imagen'; datos: Buffer | string; mime? };
type LLMMensaje =
	| { rol: 'usuario'; partes: LLMParte[] }                       // texto e imágenes (visión)
	| { rol: 'agente'; texto?; llamadas?: LLMLlamada[]; meta? }     // lo que respondió el modelo
	| { rol: 'tool'; id; nombre; resultado: unknown; imagenes?: Buffer[] };
interface LLMTool { nombre; descripcion; parametros: JsonSchema }
interface LLMLlamada { id?; nombre; args: Record<string, unknown> }
interface LLMRespuesta { texto?; llamadas?: LLMLlamada[]; meta?: unknown }
```

Decisiones:

- **Neutral al proveedor.** Mensajes con roles propios (`usuario`, `agente`,
  `tool`) y partes de texto o imagen: cada adaptador los traduce (Gemini:
  `user`/`model`, `functionCall`/`functionResponse`; OpenAI/Anthropic, igual de
  directo). El ejemplo trae un adaptador mínimo de Gemini con `fetch`.
- **El historial lo lleva SpreadBase** y se manda completo en cada vuelta: el
  adaptador no guarda estado.
- **`id` de cada llamada** lo pone el adaptador si el proveedor lo da; si no,
  el agente lo genera (`t1`, `t2`…) y la respuesta de la tool lo repite.
- **`meta` opaco** (2026-10-08, al probar con Gemini real): lo que el
  proveedor exige de vuelta tal cual en la siguiente vuelta. Gemini 3 rechaza
  (`400 … missing a thought_signature`) un historial cuyas `functionCall` no
  traen su `thoughtSignature`. El adaptador pone las partes crudas en
  `respuesta.meta`, el agente las guarda en el mensaje `agente` y el adaptador
  las reenvía.
- **`chat` es opcional.** Sin él (o sin LLM), el agente analiza con reglas: P,
  la tabla que más columnas del formato reconoce (`locateTable`), mapeo por
  encabezados y `review`. Con solo `generateStructured`, las imágenes se leen
  con X y siguen el mismo camino.

### 2.2 Fases

**Analizar** (`POST /analyze`, en la cola, por archivo):

1. El agente presenta el archivo al modelo: nombre, tipo, carpeta, destino, la
   **instrucción de la persona para ese archivo** (si la hay); un
   índice barato del método P (bloques por página con sus encabezados) o la
   imagen misma.
2. El bucle corre hasta `maxIteraciones` (12): el modelo llama tools y recibe
   sus resultados. Termina con `terminar` o cuando responde sin llamadas.
3. Si quedaron filas para un formato, el agente corre `review` y guarda los
   problemas en el archivo. Antes, une las filas **idénticas en todo** (el
   boletín repite tablas entre páginas) y deja el aviso «N filas duplicadas
   idénticas se unieron»; si dos filas comparten la llave pero difieren, el
   error («Repetido: igual que la fila N») se reescribe con las dos filas y en
   qué difieren («Misma llave que la fila 3 pero difieren en Precio de lista
   (346500 ≠ 350000)»).
4. **El chat siempre reporta**: el agente agrega un mensaje con el veredicto
   del archivo, armado sin LLM con su análisis, filas, errores y destino
   («planes.csv: 211 filas, 0 errores, listo para reemplazar» / «… 12 con
   error en Precio Final; ábrelo para verlos»). Al terminar de importar, un
   resumen con una línea por archivo.

**Chat** (`POST /chat`, síncrono): el modelo ve el estado de cada archivo y las
mismas tools (con `archivo` explícito) más `analizar` (rehacer un archivo).
**Antes de analizar** (corrida `nueva`, archivos `pendiente`), el mensaje se
suma siempre a las instrucciones de la corrida, que el análisis lee; con
modelo, además contesta (sabe que aún no debe trabajar archivos); sin él,
«Anotado: lo tomo en cuenta al analizar». Después, sin `chat`, el mensaje se
suma a las instrucciones de la corrida.

**Importar** (`POST /import`, en la cola, por archivo):

| Destino | Qué pasa | Resultado |
|---|---|---|
| `filas` · `replace` | `review`; **cualquier error lo bloquea** (reemplazar con datos incompletos borraría filas válidas); si no, `apply` con todas | `ok` o `error` |
| `filas` · `upsert` | `review`; `apply` solo con las filas sin error; las malas se quedan en la corrida con su error | `ok`, `parcial` o `error` |
| `adjuntar` | `attach({ destino, archivo, filas, derivados, corrida, contexto })` de la app | `ok` (1) |
| `descartar` | nada | `ok` (0) |
| sin destino | nada | `error` |

`apply` recibe el modo en `ctx.context.modo` (`'upsert' | 'replace'`), junto
con `corrida` y `archivo`: el formato decide cómo hacer el upsert por
identidad o el replace atómico.

### 2.3 Tools base

| Tool | Qué hace |
|---|---|
| `leerDestino({ formato? })` | Los destinos, o las columnas de un formato (tipo, obligatoria, alias, opciones, llave) |
| `extraerDeterminista({ archivo?, paginas? })` | Método P: bloques con sus primeras filas (menos filas si el documento es grande) |
| `extraerConLLM({ archivo?, paginas?, formato? })` | Método X sobre páginas dibujadas o la imagen (máx. `maxPaginasX`, 30) |
| `compararExtracciones({ archivo? })` | P contra X, celda por celda, en las páginas leídas con X |
| `verBloque({ metodo, bloque, desde, hasta })` | Las filas de un bloque, por tramos de 100 |
| `mapearTabla({ formato, metodo, bloques, columnas?, fijos? })` | Bloques → filas del formato: encabezados por nombre o alias; valores con el tipo de su columna (`$319,100` → 319100, `($60,000)` → −60000, `16.09%` → 16.09, `DD/MM/AAAA` → ISO) |
| `proponerFilas({ formato, modo?, desdeMapeo? \| filas?, agregar?, campos? })` | Escribe las filas en la corrida y deja el destino |
| `editarFilas({ quitar?, quitarSi?, cambiar?, agregar? })` | Corrige lo propuesto |
| `revisar()` | `review` del formato: problemas por fila y campo |
| `leerFilasActuales({ formato, buscar?, limite? })` | Lo que ya hay en la tabla destino (por la hoja `actuales` o una función) |
| `crearDerivado({ nombre, contenido, tipo? })` | Un archivo derivado (ej. `ficha.md`) para adjuntar junto al original |
| `fijarDestino({ destino })` · `terminar({ analisis, destino? })` | Elegir destino; cerrar el análisis con el texto de la columna Análisis |

Toda tool acepta `archivo` (id o nombre). Un error de una tool vuelve al modelo
como `{ error }`; el bucle sigue. **El destino que fijó la persona no se
cambia**: las tools que lo intentan responden con el motivo.

### 2.4 Límites y archivos

- Por omisión: 50 MB por archivo, 200 MB por corrida, 30 días de retención,
  tipos `pdf png jpg jpeg webp heic xlsx csv txt json md docx zip`.
- El tipo real se revisa por el contenido (`sniffType` de SB-30); HTML y SVG
  nunca.
- **Zip**: el cliente lo expande (con su carpeta); el servidor lo abre como
  respaldo, a mano con `node:zlib` (almacenado o deflate; sin cifrado ni
  zip64), con tope de lo descomprimido. Cada archivo de adentro es uno de la
  corrida, con su ruta en `carpeta`.
- **.docx**: su texto (`word/document.xml`) como bloque de texto.
- En el almacenamiento, el nombre va limpio (`planes-octubre.csv`); a la
  persona se le muestra el original.

### 2.5 La corrida y la concurrencia

La corrida es un documento (tipos en `@spreadbase/core`, `ImportRun`) con una
`version` que sube en cada cambio. `ImportRunStore.guardar(run, versionLeida)`
solo guarda si nadie se adelantó; si no, el agente vuelve a leer y reaplica su
cambio. Así, varios archivos que se analizan a la vez, el chat y la persona
fijando destinos no se pisan. Con Mongo: `replaceOne({ _id, version: versionLeida }, run)`.

Las filas de cada archivo viven dentro de la corrida (para Mongo, ojo con los
16 MB por documento en archivos de decenas de miles de filas: el almacén puede
separarlas).

**Cola de la app:** `encolar(trabajo)` mete `{ tipo: 'analizar' | 'importar',
corrida, archivo }` en su cola y su worker llama `agente.procesar(trabajo)`.
La cola en proceso recibe ese `procesar` con `iniciar`.

---

## 3. Contrato HTTP (`importAssistantRoutes`)

Todo JSON salvo la subida (bytes tal cual, como SB-30). Errores con la forma de
siempre: `{ error: { code, message } }`.

| Método y ruta | Cuerpo | Respuesta |
|---|---|---|
| `GET /config` | — | `ImportAssistantConfig`: `{ destinos, limites, bienvenida }` (`bienvenida`: el primer mensaje del chat, sin LLM; la app pone el suyo con la opción `bienvenida`) |
| `GET /runs` | `?origen=` | `ImportRunView[]` de quien pide (por `owner`); con `origen`, las abiertas desde esa tabla (para retomar) |
| `POST /runs` | `{ instrucciones?, origen? }` | `201 ImportRunView` (`origen` queda en `contexto.origen`) |
| `GET /runs/:run` | — | `ImportRunView` |
| `PATCH /runs/:run` | `{ instrucciones }` | `ImportRunView` (solo por compatibilidad: desde v2 las instrucciones generales llegan por el chat) |
| `POST /runs/:run/files` | bytes; cabeceras `X-File-Name` y `X-Folder` (URI-encoded) | `201 ImportRunFileView[]` (varios si era zip) |
| `DELETE /runs/:run/files/:file` | — | `ImportRunView` |
| `PUT /runs/:run/files/:file/destination` | `{ destino: ImportDestination \| null }` | `ImportRunView` (`null` suelta el destino) |
| `PUT /runs/:run/files/:file/instruction` | `{ instruccion: string \| null }` | `ImportRunView` (instrucción para ese archivo; `null` la quita) |
| `GET /runs/:run/files/:file/rows` | — | `ImportFileRows`: `{ archivo, schema, filas, issues, resumen }` |
| `PUT /runs/:run/files/:file/rows` | `{ filas }` | `ImportFileRows` (corregidas por la persona y revisadas otra vez; un archivo ya importado o con error vuelve a `analizado` para reintentarlo) |
| `POST /runs/:run/analyze` | `{ archivos? }` | `202 ImportRunView` (archivos `en_cola`) |
| `POST /runs/:run/chat` | `{ texto }` | `{ mensaje, corrida }` (antes de analizar, el texto se suma a `instrucciones`) |
| `POST /runs/:run/import` | `{ staging?: [{ destino, resumen }], destinos?: string[] }` | `202 ImportRunView`. Con `staging`, esos destinos ya se guardaron en su hoja: sus archivos quedan importados sin `apply` y los que iban a una columna sin emparejar, en error. Con `destinos` (§10), solo los archivos que alimentan esos stagings; la corrida vuelve a `lista` mientras falten otros (`importacion: { destinos, archivos }` en la corrida) |
| `GET /runs/:run/staging?destino=&modo=` | — | `ImportChangeSet` (§8.3): la tabla destino con los cambios de toda la corrida |
| `PUT /runs/:run/staging` | `ImportStagingEdit`: `{ destino, cambios?, error? }` | `ImportChangeSet` (las ediciones de la persona se guardan en `corrida.staging`; `error` lo dice el agente en el chat). Le avisa al cerebro `staging_editado` con qué cambió (agrupado: `esperaEdicionMs`, 2 s) |

Errores propios: `413 file_too_large` / `batch_too_large`, `415
unsupported_type`, `409 run_closed` (subir a una corrida importada), `409
still_analyzing` (importar antes de terminar de analizar), `404` (corrida de
otra persona o inexistente).

### 3.1 Tipos (en `@spreadbase/core`)

```ts
type ImportDestination =
	| { tipo: 'filas'; formato: string; modo: 'upsert' | 'replace' }
	| { tipo: 'adjuntar'; adjunto: string; tabla?; fila?; campo?; … }   // lo demás lo define la app
	| { tipo: 'descartar'; motivo? };

interface ImportRunView {
	id; contexto; propietario; instrucciones;
	estado: 'nueva' | 'analizando' | 'lista' | 'importando' | 'terminada';
	archivos: ImportRunFileView[];
	chat: { id; rol: 'usuario' | 'agente' | 'sistema'; texto; fecha }[];
	version; creada; actualizada; expira;
}

interface ImportRunFileView {
	id; nombre; tipo /* MIME real */; carpeta /* ruta o null */; url; tamano;
	estado: 'pendiente' | 'en_cola' | 'analizando' | 'analizado' | 'importando' | 'importado' | 'error';
	analisis /* columna Análisis */; destino; destinoFijadoPorUsuario;
	instruccion /* de la persona, para este archivo, o null */;
	campos /* datos del formulario del formato */; resumen /* summary del review */;
	totalFilas; totalErrores /* filas con error */; totalAvisos;
	derivados: { nombre; tipo }[];
	resultado: { status: 'ok' | 'parcial' | 'error'; ok; error; mensaje?; resumen? } | null;
	error /* fallo del análisis o de la importación */;
}

interface ImportRunEvent {   // onEvent
	corrida; tipo: 'corrida' | 'archivo' | 'chat'; estado?; archivo?; mensaje?; resultado?;
	totales?: { ok; error; archivos };   // al terminar de importar
}
```

### 3.2 Cómo lo usa el asistente del cliente

| Paso del wizard | Llamadas |
|---|---|
| Abrir el asistente (momento 0) | `GET /config` (destinos, límites y bienvenida) → `POST /runs` (el chat ya tiene corrida) |
| ① Archivos (drop sobre el `target` o en el asistente; carpetas y zip expandidos en el navegador) | `POST /files` por archivo (con `X-Folder`) |
| Destino en la hoja de archivos (fijarlo o corregirlo) | `PUT /files/:file/destination` (opciones de `GET /config`) |
| Instrucción en la hoja de archivos | `PUT /files/:file/instruction` (al confirmar la celda) |
| Instrucciones generales | `POST /chat` antes de analizar (el servidor las guarda en la corrida) |
| ② Análisis | `POST /analyze`; refrescar `GET /runs/:run` (o el socket de la app) hasta `lista` |
| Chat | `POST /chat` |
| Detalle de un archivo (hoja de staging con los errores por celda) | `GET /files/:file/rows`; «Guardar correcciones»: `PUT /files/:file/rows` y, si ya se había importado y quedó sin errores, `POST /import` |
| ③ Importar (la ventana se puede cerrar) | `POST /import`; refrescar hasta `terminada` |
| ④ Resultado | `resultado` de cada archivo; Detalle de los que quedaron con error |

---

---

## 4. El cliente: `<ImportAssistant>` y `ImportAssistantState`

```svelte
<!-- Atajo: la hoja recibe archivos; al cerrar el asistente, se recarga. -->
<SpreadBase {sheet} fill importAssistant={{ url: '/api/imports/assistant', origen: 'Planes GMF', aviso: 'te avisamos en el panel' }} bind:importOpen />
<button class="link" onclick={() => (importOpen = true)}>o elige archivos</button>

<!-- O suelto, apuntando a cualquier contenedor. -->
<div id="tabla-planes">…</div>
<ImportAssistant url="/api/imports/assistant" target="tabla-planes" origen="Planes GMF" bind:open onclose={recargarTabla} />
```

| Prop | Qué es |
|---|---|
| `url` | La base de `importAssistantRoutes` |
| `headers` | Cabeceras de cada petición (`Authorization`) |
| `target` | id o `HTMLElement` que recibe archivos: al arrastrar, una capa cubre el 100 % del contenedor; al soltar, se abre el asistente con esos archivos subiendo. Sin `target`, solo se abre con `open` |
| `dropHint` | Texto de esa capa. Default: «Suelta para importar a {origen}» |
| `open` (bindable) | Abierta o cerrada (un `<dialog>` modal: foco atrapado; Escape cierra salvo que se esté en una hoja, donde cancela la celda). Default: abierta sin `target`, cerrada con él |
| `origen` | La tabla de origen, en el subtítulo y en la capa |
| `aviso` | Cómo avisa la app al terminar («te avisamos en el panel y por WhatsApp») |
| `run` | Volver a abrir una corrida existente |
| `onclose` | Se cerró; la importación, si empezó, sigue en el servidor |
| `assistant` (bindable) | El `ImportAssistantState`, para leerlo desde fuera |

En `<SpreadBase>` y `<SpreadsheetGrid>`, **`legend`** (default `true`): `legend={false}` quita la leyenda
inferior («Celda editada sin guardar», «Fila nueva», «Valor inválido», «Fila eliminada» y la ventana de
filas); los avisos de trabajo («Resolviendo nombres…», «Cargando siguientes…») se siguen viendo. El
asistente la quita en la hoja de archivos y en cada staging; las demás hojas no cambian.

`ImportAssistantState` (§10) suma: `tab` (`'archivos'` o el formato de un destino), `stagings` (las hojas
abiertas por destino), `destinationTabs` (pestañas con archivos, conteos, `trabajando`, `importado`),
`stagingOf(archivo)`, `openStaging(destino, { highlight, fresh })`, `highlightFile(destino, archivo)`,
`refreshSummaries()` e `importStaging(confirmado, destinos | null)`. En `GridController`:
`highlightRows(claves)` (resalta filas sin tocar datos ni cambios) y `commands.revealRow(clave)`.

En `<SpreadBase>`: `importAssistant={{ url, origen, aviso, dropHint, headers, run, onclose, onassistant }}`
usa la propia hoja como `target` y la recarga al cerrar; `bind:importOpen` lo
abre desde un enlace propio.

**Layout** (fase A de §7, pantalla completa desde §10). El diálogo ocupa **toda
la pantalla** (`w-screen h-dvh`, sin márgenes ni esquinas) en dos columnas desde
que abre: el contenido a la izquierda, en **pestañas** (Archivos y una por tabla
destino, §10), y el **chat a la derecha, siempre visible** (≈ 1/3, `min-w-80`),
en todas las pestañas. Debajo de `lg`, el chat es una pestaña más. El chat: burbujas de daisyUI (`chat-start`/`chat-end`) con autor y
hora, la **bienvenida** de `GET /config` como primer mensaje (sin LLM),
«pensando…» mientras responde e input fijo abajo (Enter envía, Mayús+Enter
salta de línea). Lo que se escribe antes de analizar son las instrucciones de
la corrida; ya no hay textarea de comentarios.

**Los cuatro pasos** (el paso sale del estado de la corrida; las flechas dejan
volver a uno anterior):

1. **Archivos.** Sin archivos, la zona para soltar ocupa todo el panel
   izquierdo («Elegir carpeta», «Elegir archivos», los límites de `GET
   /config`); con archivos se reduce a una franja y la **hoja de archivos**
   ocupa el panel. Soltar archivos sobre el panel también los agrega. Las
   carpetas se leen con la API nativa (`webkitGetAsEntry` al soltar,
   `webkitdirectory` al elegir) y los zips se abren en el navegador con
   `jszip` (si no puede, el zip sube tal cual y lo abre el servidor). Cada
   archivo sube al llegar.
2. **Análisis.** La misma hoja con Estado, Análisis, Destino, Filas y Errores
   del agente; el agente deja en el chat un veredicto por archivo. Pie:
   «← Archivos» e «Importar →».
3. **Importando.** «Importando en segundo plano. Puedes cerrar esta ventana:
   {aviso}.»; el resultado de cada archivo en Estado. Pie: «Cerrar (sigue en
   segundo plano)».
4. **Resultado.** Tarjetas de importados (filas y adjuntos) y con error; el
   resumen de la importación en el chat. Pie: «← Volver al análisis» y «Listo».

**La hoja de archivos** es una `Sheet` local (en memoria), en la pestaña
**Archivos**: Documento y Staging (acciones) · Icono (miniatura de
la imagen o etiqueta con la extensión) · Nombre · Tipo · Carpeta · Estado (con
un ícono: spinner animado en cola, analizando o importando, y el progreso en vivo) ·
Análisis · Destino · Instrucción · Filas · Errores · Abrir (· Quitar en el
paso 1). Solo **Destino** (select con «Automático» y las opciones de `/config`,
uno por modo de cada formato) e **Instrucción** se editan, en los pasos 1 y 2;
al confirmar la celda se llama a `PUT …/destination` o `PUT …/instruction`.
Altura de fila normal; los Errores van en rojo; Icono y Nombre quedan fijos al
desplazarse.

**El detalle de un archivo** («Abrir») reemplaza el panel izquierdo completo,
con migas «Archivos › nombre»: el análisis completo y, si el archivo va a
filas, su **hoja de staging** (`Sheet` local, editable, con alta y baja de
filas) con los errores en la celda (rojo), los avisos (ámbar), el motivo en el
tooltip y una columna «Problemas» fija a la izquierda; las columnas con error
van primero y los avisos generales («2 filas duplicadas idénticas se unieron»)
arriba. «Guardar correcciones» → `PUT …/rows`; si el archivo ya se había
intentado importar y quedó sin errores, se vuelve a importar. Tras un `upsert`
parcial la hoja trae solo las filas rechazadas. Un archivo sin filas (adjuntar,
descartar) muestra su vista previa. Si el agente cambia el archivo (termina su
análisis, «excluye contado»), el detalle se vuelve a leer.

Mientras analiza o importa, el estado vuelve a leer la corrida cada segundo
(`pollMs`); una app con socket puede llamar `assistant.refrescar()` cuando le
llegue un `ImportRunEvent`. `ImportAssistantState` es el mismo estado sin
interfaz (como `ImportState` de SB-34), para quien quiera dibujarlo a su
manera; `init()` crea la corrida al abrir y `reset()` empieza otra (el
asistente lo hace solo si se sueltan archivos sobre una corrida ya
importada). Solo clases de Tailwind/daisyUI: toma el tema de la app.

## 5. Ejemplo y pruebas

- Ejemplo: la página `/import-assistant` (la tabla «Planes GMF» con el atajo
  `importAssistant`: se suelta sobre ella; «o elige archivos» lo abre) contra `examples/backend/src/examples/import-assistant/` en
  `/api/import-assistant`: formato «Planes GMF» sobre una hoja en memoria
  (`/api/import-assistant/planes`), un destino `adjuntar` que solo registra
  (`/fichas`) y descartar. Modelo de guion por omisión (sin red); Gemini con
  `IMPORT_ASSISTANT_LLM=gemini` y `GEMINI_API_KEY`.
- Pruebas: `tests/assistant/` (agente con reglas y con modelo de guion, rutas
  HTTP, boletín real con `EXTRACTION_PDF`), `tests/mongo/asistente.test.ts`
  (de punta a punta sobre `mongoSource`), `tests/protocol/asistente.test.ts`
  (el ejemplo encendido: bienvenida, instrucciones por el chat, duplicados
  idénticos, veredictos) y `tests/grid/asistente.test.ts` (el asistente en el
  navegador: drop sobre la tabla con su capa, chat con bienvenida y sin
  textarea, carpeta y zip, destino e instrucción en la hoja, análisis y
  veredicto, chat, flechas, staging con el error en la celda y sin panel
  encimado, importar, corregir y reintentar, chat en pestaña en pantalla
  chica).

## 6. Pendiente

- Retención automática: `agente.purgar()` existe; falta quién la llame (un
  cron de la app).
- Para Mongo, separar las filas de la corrida si un archivo trae decenas de
  miles.
- PDF grande: hoy el modelo recibe el índice completo de P; un índice por
  lotes de páginas para documentos de cientos.

---

## 7. Rediseño v2 (propuesta, 2026-10-09)

> Sale de la prueba de Sergio con el boletín real (8 observaciones). Se
> implementa en dos fases. **Fase A (hecha, 2026-10-09): todo lo que se ve**,
> sobre el agente actual. **Fase B (pendiente): un cerebro más
> capaz, enchufable** (§8.6, §9). Lo que aquí
> contradice a §2–§4 gana; §3 y §4 ya describen la fase A.

### 7.0 Fase A: qué quedó (2026-10-09)

| # | Punto | Estado |
|---|---|---|
| 1 | Drop directo sobre la tabla: `target` + `dropHint` en `<ImportAssistant>`, capa sobre el 100 % del contenedor, atajo `importAssistant` (y `bind:importOpen`) en `<SpreadBase>`; el ejemplo sin botón, con «o elige archivos» | ✅ |
| 2 | Dos columnas desde el momento 0 (chat siempre visible, `min-w-80`), diálogo `w-[min(96vw,1400px)] h-[90vh]`, chat en pestaña bajo `lg`, burbujas con autor y hora, «pensando…», input fijo | ✅ |
| 3 | Bienvenida sin LLM en `GET /config` (`bienvenida`, configurable con la opción del mismo nombre) | ✅ |
| 4 | Sin textarea: lo que se escribe en el chat antes de analizar se suma a `instrucciones` (el análisis ya las leía); la corrida se crea al abrir | ✅ |
| 5 | Zona de drop al 100 % del panel izquierdo sin archivos; franja con archivos | ✅ |
| 6 | Hoja de archivos (`Sheet` local) con Destino e Instrucción editables → `PUT …/destination` y `PUT …/instruction` | ✅ |
| 7 | Detalle = hoja de staging en todo el panel izquierdo, migas, errores (rojo) y avisos (ámbar) en la celda con tooltip, columna «Problemas», «Guardar correcciones»; sin el panel rojo de 100 px. Los errores del resultado final se ven en la misma hoja | ✅ (el ámbar por celda es nuevo en `GridController.setExternalErrors({ level: 'warning' })`) |
| 8 | Duplicados idénticos colapsados en el `review` del agente con aviso; misma llave pero distintas: error que nombra las dos filas y en qué difieren | ✅ |
| 9 | El chat siempre reporta: un veredicto por archivo al terminar su análisis y un resumen por archivo al terminar la importación, sin LLM | ✅ |

Queda para la **fase B**: un cerebro enchufable (un hilo
por corrida con el análisis, la importación y el chat como turnos del mismo
agente; turnos de sistema por evento y agente proactivo), `GET
/runs/:run/events` (SSE) con streaming del chat y progreso en Estado, `POST
/runs/:run/stop` y el botón «Detener», el diff contra la tabla actual antes de
publicar, `ImportRunView.etapa` e `ImportStagingView`, y la explicación del
agente con las dos filas lado a lado y cuál conservar (hoy el mensaje del
error ya nombra las dos filas y sus diferencias).

### 7.1 Qué cambia, punto por punto

| # | Observación | Cambio |
|---|---|---|
| 1 | Drag & drop directo sobre la tabla, sin botón «Importar» | Prop `target` (id o elemento): el componente se vuelve receptor de drop de ese contenedor y abre el asistente al soltar. Atajo: `<SpreadBase importAssistant={{ url }} />` |
| 2 | La zona de drop debe ocupar todo | Al arrastrar, una capa sobre el 100 % del `target` (`absolute inset-0`); dentro del asistente, la zona ocupa todo el panel izquierdo mientras no haya archivos |
| 3 | Quitar el textarea de comentarios | Fuera. Las instrucciones generales van en el chat; el primer mensaje del agente explica para qué sirve. `PATCH /runs/:run { instrucciones }` queda solo por compatibilidad |
| 4 | Tabla de archivos como hoja SpreadBase | La lista de archivos es una `Sheet` local (fuente en memoria): Icono · Nombre · Tipo · Carpeta · Estado · Análisis · Destino ✎ · Instrucción ✎ · Filas · Errores. Solo Destino (select) e Instrucción (texto) son editables; altura de fila normal, el Análisis completo en el panel de detalle |
| 5 | El asistente debe ser el elemento más inteligente | Un solo agente por corrida, con todo el contexto y proactivo (§7.2) |
| 6 | Errores en la misma tabla; replace no debería dar esos errores | Staging por archivo (§7.3): los errores son celdas marcadas de la hoja de staging, no un panel aparte; el chat siempre reporta. Duplicados idénticos se colapsan (§7.4) |
| 7 | Chat visible desde el momento 0, buen look & feel | Layout fijo de dos columnas: contenido a la izquierda (≈ 2/3) y chat a la derecha (≈ 1/3, `min-w-80`), desde que abre. En pantallas chicas, el chat es una pestaña |
| 8 | Panel rojo encimado con una hoja de 100 px: inaceptable | Desaparece. El detalle de un archivo reemplaza el panel izquierdo completo (hoja de staging a toda altura, con migas «Archivos › planes.pdf») |

### 7.2 El agente: un cerebro por corrida

Hoy hay dos bucles que no se ven entre sí (análisis por archivo y chat). En v2:

- **Una conversación por corrida.** El análisis de cada archivo, la
  importación y el chat son turnos del mismo agente, con memoria de
  conversación (los últimos turnos completos, los anteriores resumidos).
- **Contexto completo en cada turno**, armado por `context(run)`:
  - archivos con su estado, destino (y si lo fijó la persona) e instrucción;
  - etapa del wizard;
  - progreso de cada trabajo en cola;
  - totales y errores del staging por archivo, con muestra;
  - resultado de importaciones anteriores;
  - qué hay hoy en la tabla destino: conteo y resumen (`summarizeData`).
- **Proactivo.** Los eventos de la corrida entran como turnos de sistema y el
  agente decide si habla:
  - archivo subido;
  - análisis terminado;
  - `review` con problemas;
  - importación terminada o fallida.

  Al terminar un análisis siempre emite un veredicto de una línea por archivo
  («211 filas, 0 errores, listo para reemplazar» / «tomé la guía de
  administración, ¿la descarto?») y una pregunta concreta si algo es ambiguo.
- **Responde cualquier pregunta** sobre la corrida, los datos o el formato
  (tiene las tools de lectura además de las de edición).
- **Corrección iterativa:** la persona dice «quita las filas de Montana LCCN» o
  «el precio final es lista menos descuento, no bonificación»; el agente
  edita el staging (`editarFilas`), corre `revisar` y reporta el antes y el
  después.
- **Investiga antes de reportar.** Si `review` falla en masa en una columna, el
  agente busca la causa antes de decir «no cuadra»: otra sección del
  documento, otra tabla de la misma página o un encabezado mal mapeado. Regla
  de prompt: distinguir secciones del boletín (guía de vendedor contra guía de
  administración).
- **Presupuesto y control** (del engine): tope de vueltas, tiempo, tokens y
  páginas por visión por archivo; `AbortSignal` desde el botón «Detener».
  Además, eventos en vivo (canal de usuario: texto del chat por streaming;
  canal de capas: «leyendo página 4/12…» en la columna Estado).
- **Primer mensaje** (momento 0, sin LLM, texto fijo configurable): qué puede
  hacer, que acepta instrucciones en el chat («los planes de octubre
  reemplazan a los de septiembre», «ignora las páginas de seminuevos») y qué
  destinos hay.

### 7.3 Staging: cómo funciona

Respuesta a «¿cómo funciona el staging?»:

1. **Cada archivo con destino `filas` tiene su hoja de staging**: las filas
   propuestas por el agente, con el schema del formato, guardadas en la
   corrida por `ImportRunStore`. Con Mongo pueden ir en una colección aparte
   `import_staging { corrida, archivo, filas }` para no topar los 16 MB. La
   tabla real **no se toca**.
2. **La revisión corre sobre el staging.** `review` del formato SB-34 en cada
   cambio, ya sea del agente o de la persona editando la hoja. Los problemas
   quedan por fila y campo y se pintan en la celda (rojo = error, ámbar =
   aviso, motivo en el tooltip y en una columna «Problemas»).
3. **La persona y el agente editan la misma hoja.** Lo que la persona cambia
   en la celda le llega al agente como evento; lo que el agente cambia se ve
   al instante.
4. **Publicar = `apply`.** Solo cuando el archivo está sin errores (`replace`)
   o con las filas sin error (`upsert`). Antes de publicar, el agente muestra
   el diff contra la tabla actual (`leerFilasActuales`): N nuevas, N
   cambiadas, N que desaparecen con `replace`. La persona confirma.
5. **Tras publicar**, el staging queda en la corrida como registro (30 días)
   y la columna Resultado lo enlaza.

Por eso, con `replace` no debe haber errores al final: el bloqueo pasa
**antes**, en el staging, visible y corregible ahí mismo, no como sorpresa al
importar.

### 7.4 «Versión: repetido igual a fila N»

Es la regla de llave única del formato dentro del mismo archivo (dos filas con
la misma llave). Importa con `replace` porque la tabla se reconstruye con lo
que trae el archivo: dos filas con la misma llave dejan ambigua cuál queda.
En v2:

- **Idénticas en todo:** se colapsan en el staging sin error, con un aviso
  «3 filas duplicadas idénticas se unieron» (el boletín repite tablas entre
  páginas).
- **Misma llave pero distintas:** siguen como error, y el agente lo explica
  con las dos filas lado a lado y propone cuál conservar.

### 7.5 API del cliente

```svelte
<!-- Opción A: atajo en la hoja -->
<SpreadBase sheet={planes} importAssistant={{ url: '/api/imports/assistant', origen: 'Planes GMF', onclose: recargar }} />

<!-- Opción B: componente suelto apuntando a cualquier contenedor -->
<div id="tabla-planes"> … </div>
<ImportAssistant url="/api/imports/assistant" target="tabla-planes" origen="Planes GMF" onclose={recargar} />
```

| Prop nueva | Qué es |
|---|---|
| `target` | id o `HTMLElement` que recibe el drop; sin `target`, el asistente solo se abre con `open` |
| `dropHint` | Texto de la capa al arrastrar («Suelta para importar a Planes GMF») |

`open` sigue existiendo para abrirlo desde un botón propio. El `<dialog>`
pasa a casi pantalla completa (`w-[min(96vw,1400px)] h-[90vh]`).

### 7.6 Cambios por capa

| Capa | Archivos | Cambio |
|---|---|---|
| core | `importAssistant.ts` | `ImportRunView.etapa`, `ImportStagingView` (filas + issues + diff), eventos de agente (`texto parcial`, `progreso`) |
| server | `importAgent/agent.ts`, `tools.ts`, `routes.ts` | Agente enchufable (`ImportBrain`); un solo hilo por corrida; turnos de sistema por evento; `GET /runs/:run/events` (SSE); `POST /runs/:run/stop`; staging y diff; colapsar duplicados idénticos |
| client | `ImportAssistant.svelte`, `ImportAssistantState.svelte.ts`, `SpreadBase.svelte` | `target`/capa de drop; layout de dos columnas; hoja de archivos y hoja de staging como `Sheet` locales; chat con streaming; sin textarea ni panel rojo; prop `importAssistant` en `SpreadBase` |
| ejemplo | `examples/frontend/src/routes/import-assistant/+page.svelte` | Sin botón: drop sobre la tabla |
| pruebas | `tests/grid/asistente.test.ts`, `tests/assistant/*` | Drop sobre el `target`, chat visible al abrir, editar destino/instrucción en la hoja, staging con errores en celda, corrección por chat, duplicados idénticos colapsados, diff antes de publicar, stop |

### 7.7 Orden

1. Servidor: agente enchufable + staging + SSE.
3. Cliente: layout, `target`, hojas.
4. Pruebas E2E.
5. Prueba con el boletín real de octubre (golden de 57 filas).

---

## 8. Segunda revisión de Sergio (2026-10-09): staging = la tabla destino con los cambios

> Sale de probar la fase A con el boletín MY26/MY27 real. **Reemplaza §7.3** (staging por archivo)
> y fija el orden: **A2 → S → T**, con **B** (el agente) en paralelo.

### 8.1 Qué es el staging

**Una copia de la tabla destino con la data completa hasta ese momento y todos los cambios de la
importación aplicados**, juntando todos los archivos de la corrida. No es una lista de filas por
archivo.

- **Se ve como la hoja real**, con su schema, tipos y formato, y los cambios marcados como
  **pendientes** con los mismos estados de siempre: celda editada, fila nueva, fila eliminada. Esos
  cambios aparecen en el **panel de control de cambios** (`ChangesPanel`).
- **La persona puede editar el staging** como cualquier hoja.
- **«Importar» aplica los cambios tal cual** a la tabla. Es el guardado de siempre: un batch con su
  validación y sus conflictos.
- **Los errores van en la celda** (errores externos de la hoja, rojo o ámbar) y el chat los resume.

Ejemplo:
- **Tabla Planes GMF:** `paquete | precio de lista | imagen | archivos (carpeta) | fichaTecnica`.
- **Se sueltan:**
  - una carpeta de fotos con nombres de unidades;
  - una carpeta de fichas técnicas en PDF.
- **El staging queda así:**
  ```
  paquete | precio de lista | imagen          | archivos (carpeta)          | fichaTecnica
  A       | 885000          | <miniatura>     | files/FichaTecnica.pdf      | «contenido completo en md o JSON»
  ```
  Cada celda cambiada está marcada como pendiente y lista para aplicar.

### 8.2 Reglas para el agente (valen para la fase B y para el agente actual)

- **Su trabajo es extraer bien y armar el staging. Nunca descarta un archivo por su contenido.**
  «Descartar» es una decisión de la persona (o un destino que la persona fijó).
- **Ante ambigüedad pregunta, y siempre con evidencia concreta.**
  - Nombra qué páginas, qué bloque y qué filas, y muestra 2 o 3 filas de ejemplo lado a lado.
  - Ejemplo correcto: «las páginas 9–14 son la *Guía para administración* (Bonificación) y las 2–7, la
    *Guía para vendedor* (Descuento cliente). Para AVEO HB LS el descuento es −$60,000 en una y
    −$45,000 en la otra. ¿Uso la de vendedor?».
  - Prohibido: «datos contradictorios» sin decir cuáles.
- **Varios archivos sobre las mismas filas:**
  - una foto o un PDF se **emparejan con la fila** por nombre de unidad, modelo o versión, y llenan su
    columna (`IMAGE`, `FILE`, `FOLDER`, texto);
  - no crean filas nuevas salvo que la persona lo pida;
  - lo que no empareja queda listado en el chat con la razón.
- **El análisis de la columna «Análisis» y lo que dice el chat deben coincidir y ser concretos.**

### 8.3 Contrato del staging (lo comparten S y B)

En `@spreadbase/core` (`importAssistant.ts`):

```ts
/** De dónde salió un valor: para «¿por qué pusiste esto?» y para saltar al documento. */
interface ImportOrigin { archivo: string; pagina?: number; bloque?: string; fila?: number; nota?: string }

type ImportChange =
	| { op: 'insert'; key: string; valores: Record<string, unknown>; origen: ImportOrigin[] }
	| { op: 'update'; key: string; id?: string; campos: Record<string, { antes: unknown; despues: unknown; origen: ImportOrigin[] }> }
	| { op: 'delete'; key: string; id?: string; motivo: string };   // solo con replace o si la persona lo pide
// `id` (agregado en S, 2026-10-09): el id de la fila en la hoja destino (`idField`), para aplicar el
// cambio en la `Sheet` real. `key` sigue siendo la llave del formato (o la `llave` del destino).

interface ImportChangeSet {
	destino: string;                    // id del formato / tabla
	modo: 'upsert' | 'replace';
	base: { version?: unknown; filas: number };  // la tabla destino al calcularlo
	cambios: ImportChange[];
	problemas: { key: string; campo?: string; nivel: 'error' | 'aviso'; mensaje: string }[];
	sinEmparejar: { archivo: string; motivo: string }[];
	resumen: { insert: number; update: number; delete: number; errores: number; avisos: number };
}
```

- **Rutas:**
  - `GET /runs/:run/staging?destino=` → `ImportChangeSet`, calculado contra las filas actuales de
    la tabla destino por llave;
  - `PUT /runs/:run/staging` con las ediciones de la persona;
  - el agente escribe con `proponerCambios` / `editarCambios` (fase B) o, mientras tanto, el
    servidor convierte las filas propuestas de cada archivo en un `ImportChangeSet` unido.
- **El cliente**: abre la `Sheet` **real** del destino (la URL de la hoja la da `GET /config` por
  destino), le aplica `cambios` como pendientes, pinta `problemas` como errores externos y muestra
  el panel de cambios. «Importar» = `sheet.save()` y luego `POST /runs/:run/import` marca la corrida.
  Los destinos `adjuntar` siguen por su `attach`.

### 8.3.1 Replace contra upsert en el staging (confirmado por Sergio, 2026-10-09)

Solo cambia el staging; importar siempre es guardar la hoja tal cual. Se compara **por llave** contra la
tabla actual:

| Fila | Replace | Upsert |
|---|---|---|
| Existe y viene con cambios | `update`: amarilla, solo las celdas que cambian | igual |
| Existe y viene idéntica | sin marca | sin marca |
| Llave nueva | `insert`: verde | igual |
| Existe y no viene en los archivos | `delete`: eliminada (tachada) | intacta, sin marca |

No se borra todo para reinsertarlo: así se ve qué cambió de verdad y se conservan los ids, y con ellos
lookups, referencias e historial. El resultado final es el mismo.

- **Cambio de llave** = `delete` + `insert`. Si el agente detecta que es la misma unidad (renombre de
  versión), lo dice en el chat y propone tratarlo como `update`.
- **Replace con eliminaciones pide confirmación** antes de importar, con el conteo y la lista: «se
  eliminarán N filas: …».

### 8.4 Correcciones de interfaz (A2)

1. **Vuelve el botón «Importar archivos»** junto con el drop sobre la tabla. Si hay una corrida
   abierta de esa persona en ese origen (`GET /runs`), el asistente **la retoma donde se quedó**:
   paso, archivos y chat.
2. **Acciones al inicio, a la izquierda**, en la hoja de archivos. Son dos:
   - **Ver documento**: el preview del archivo, como hoy;
   - **Ver staging**: la tabla destino con los cambios (§8.1).

### 8.5 Tipos nuevos (T)

- **`FILE`**: un archivo subido (SB-30); celda con ícono, nombre y tamaño; clic abre o descarga.
- **`FOLDER`**: varios archivos; celda con conteo y lista.

El valor canónico, las reglas, la subida desde la celda y su lugar en `postgresSource` y
`mongoSource` se definen en `docs/04-tipos-de-columna.md` (SB nuevo). El ejemplo de planes suma
`imagen`, `archivos` y `fichaTecnica` para probarlos.

### 8.6 Dónde vive el agente (B)

`packages/server` es la librería open source y **no depende** de un motor de agentes ni de un SDK de
un solo proveedor. El agente se vuelve **enchufable**:

- la librería define la interfaz del cerebro del asistente y trae el agente actual como versión
  por omisión;
- una implementación más capaz la da la app que usa SpreadBase, fuera de la librería (§9).

---

### 8.7 Qué quedó de A2, S y T (2026-10-09)

**A2 (interfaz).**
- `<SpreadBase importAssistant>` vuelve a poner **«Importar archivos»** en la barra (`button: false` lo
  quita); el drop sobre la tabla y su capa siguen.
- Al abrir, `ImportAssistantState` (opción `origen`) pide `GET /runs?origen=` y **retoma** la corrida no
  terminada más reciente de esa persona en esa tabla (paso, archivos y chat; insignia «Retomada»); si no
  hay, crea una con `origen`. **«Empezar de cero»** en el encabezado crea otra vacía (`startOver()`).
- En la hoja de archivos, **al inicio y a la izquierda**, dos acciones: **Ver documento** (el archivo en
  todo el panel: imagen, PDF o «ábrelo en otra pestaña») y **Ver staging**. La columna «Abrir» y la vista
  vieja de filas por archivo (staging por archivo, «Guardar correcciones») se quitaron del componente; las
  rutas `…/files/:file/rows` siguen en el servidor y `openDetail`/`retry` en el estado, por compatibilidad.
- **En vivo** (pedido tras la fase B): el estado escucha `GET /runs/:run/events` con `fetch` (lleva las
  cabeceras) y se reconecta; el texto del chat llega por partes (burbuja en vivo), el progreso va a la
  columna Estado («Analizando… usando verPaginas…») y al estado del chat, y un evento `corrida` vuelve a
  leer la corrida. **«Detener»** en el encabezado del chat (mientras piensa o analiza) → `POST /stop`.

**S (staging real).**
- Core: `ImportOrigin`, `ImportChange`, `ImportChangeSet` (§8.3) y además `ImportStagingState`
  (`corrida.staging[destino]`: `cambios` de la persona con su `firma`, y `publicado` con el resumen y lo
  que no emparejó) e `ImportStagingEdit`. **Cambio al contrato:** `update` y `delete` llevan `id?` (el id
  de la fila en la hoja). `ImportDestinationOption` suma `sheetUrl?` (filas) y `columna?` (adjuntar).
- Servidor (`importAgent/stagingCorrida.ts`): une las filas propuestas de todos los archivos con destino
  `filas` a ese formato (`calcularStaging` de `brain/staging.ts`), compara por la llave del destino
  (`llave` en la declaración, o la del formato) contra las filas actuales (`actuales`), y produce `insert`,
  `update` (solo los campos que cambian, `antes`/`despues`/`origen`) y, solo con `replace` y si los
  archivos traen filas, `delete`; las idénticas no generan cambio; `problemas` sale de cada `review` (por
  llave y campo). Suma los cambios del cerebro (`cambiosDelCerebro`: emparejamientos por contenido y
  `proponerCambios`) y los archivos que van a una columna (T). Si el cerebro arma todo su staging
  (`stagingDelCerebro`), manda el suyo. Las ediciones guardadas con `PUT` valen mientras la `firma` de lo
  que proponen los archivos no cambie.
- `GET /config` da `sheetUrl` por destino (absoluta o relativa a la base de las rutas).
- Cliente: «Ver staging» crea la `Sheet` **real** del destino (sin borrador local) y, al cargar, le aplica
  los cambios con `GridController.stageChanges` (nuevo: pide por id las filas fuera de la ventana; una sola
  acción del historial): update amarillo solo en las celdas que cambian, insert verde, delete tachado; los
  `problemas` como avisos en la celda (rojo/ámbar) y los que no tienen fila arriba; `sinEmparejar` como
  avisos; y abre el **panel de cambios**. Lo que la persona edita se manda con `PUT` (600 ms).
- **«Importar»** abre el staging si hace falta; con celdas en error no sigue; un `replace` con
  eliminaciones pide **confirmación con el conteo y la lista** («Se eliminará 1 fila de Planes GMF: …»,
  Cancelar / «Eliminar N e importar»); luego **guarda la hoja** (`grid.save()`: el lote de siempre, con su
  validación y conflictos) y `POST /import { staging }` marca la corrida y procesa los `adjuntar`. Un
  rechazo del servidor vuelve **a la celda** (nuevo en `GridController`: los `details` de
  `validation_error` se marcan en su celda) y **al chat** (`PUT /staging { error }`).
- Pasos: «Importando» igual; «Resultado» cuenta nuevas, actualizadas y eliminadas (+ adjuntos); el chat
  agrega «Planes GMF: 1 nueva, 1 actualizada, 1 eliminada.»; cada archivo dice «Guardado con el staging».
- Ejemplo: la hoja Planes GMF es el destino real (`sheetUrl: 'planes'`, `llave` = identidad del plan,
  altas y bajas permitidas, la regla lista + descuento = final también al guardar), arranca con 3 planes
  «de septiembre» y tiene `POST /planes/dev/reset` (solo test).

**T (tipos `FILE` y `FOLDER`, SB-38).** Ver `04-tipos-de-columna.md` §3. La hoja de planes suma `imagen`
(`IMAGE`), `archivos` (`FOLDER`) y `fichaTecnica` (texto largo, visor con «Formatear JSON»). Destinos
`adjuntar` con `columna` (`imagen`, `archivos`, `ficha`): **emparejamiento determinista** por nombre del
archivo (o carpeta) contra `modelo`/`version`/`paquete`, toda la unidad recibe el archivo; `destino.fila`
manda si viene; lo que no empareja o es ambiguo va a `sinEmparejar` (aviso en el staging) y, al importar,
ese archivo queda en error con la razón.

**Pruebas.** `tests/protocol/asistente.test.ts` (S-1…S-4, T-1…T-3: 2 archivos unidos, update solo con
campos cambiados, idénticas sin marca, delete solo en replace, upsert sin delete, problemas por llave,
PUT/GET de ediciones y su invalidación, importar marcando sin aplicar, error al chat, emparejamientos);
`tests/grid/asistente.test.ts` (AI-4 botón y retomar, acciones a la izquierda y documento; AI-5 staging
real en replace con amarillo/verde/tachado, panel de cambios, editar, confirmación, error de guardado en la
celda y el chat, guardar tal cual; AI-6 emparejamiento en el staging; AI-7 en vivo y «Detener»; AI-1
actualizado); `tests/grid/archivos.test.ts` (AR-1, AR-6, AR-7); `tests/postgres/archivos.test.ts` y
`tests/mongo/archivos.test.ts`.

**Pendiente.** El staging de varios destinos se guarda uno tras otro (cada uno abre su hoja); la regla
del formato (`review`) en upsert ya no publica «solo las buenas»: con errores no se importa hasta
corregir o quitar esas filas; el panel de cambios ocupa casi la mitad del panel izquierdo en pantallas de
1366 px; ~~ningún evento `staging_editado` se le avisa al cerebro desde `PUT /staging`~~ (cerrado en §10).

## 9. Cerebro enchufable del asistente (fase B, 2026-10-09)

La librería no trae un cerebro de un proveedor: define la interfaz y el agente de siempre como versión por
omisión. Una app puede enchufar el suyo (por ejemplo, desde un servicio propio) con `importAgent({ brain })`.

### 9.1 Qué quedó implementado

**En la librería** (`packages/server`, sin depender de ningún proveedor de modelos):
- `importAgent/brain/types.ts`: `ImportBrain` (`manejar(evento, host)`, `cambiosExtra?`, `staging?`,
  `detener?`, `olvidar?`), `ImportBrainEvent` (`archivos_subidos`, `analizar`, `chat`, `staging_editado`,
  `importacion_terminada`), `ImportBrainHost` (corrida al día, `signal` de «Detener», tools base,
  esquema y llave, filas actuales, `stagingActual`, P, páginas a PNG, `decir`, `emitir`, y el agente de
  siempre en `basico`) e `ImportLiveEvent` (texto por partes, progreso, tools, costo, detenido, eventos de
  la corrida).
- `importAgent/brain/basic.ts`: `cerebroBasico()`, el agente de siempre detrás de la interfaz (sin
  `brain`, el agente hace lo mismo).
- `importAgent/brain/staging.ts`: `calcularStaging` (puro: filas de los archivos + cambios extra contra la
  tabla actual por llave, §8.3.1) y `llavePorOmision`; lo usa también `stagingCorrida.ts` (S).
- `agent.ts` (enganche localizado): `importAgent({ brain })`; el análisis y el chat pasan por
  `brain.manejar`; subidas, ediciones e importación terminada se le avisan sin esperar; `suscribir`,
  `detener`, `host(id)`, `stagingDelCerebro`, `cambiosDelCerebro`. Con cerebro, el veredicto del chat
  lleva el texto del Análisis (regla 5).
- `routes.ts`: `GET /runs/:run/events` (SSE: `texto`, `texto_fin`, `progreso`, `herramienta`, `costo`,
  `detenido`, `corrida`) y `POST /runs/:run/stop` (`{ detenido }`).

### 9.2 Cómo probarlo

```sh
npm run back        # el ejemplo, con el agente de siempre
npm test -- assistant
```

## 10. Tercera revisión de Sergio (2026-10-09): pestañas por destino

> Sale de usar el asistente con el boletín real y el cerebro de Claude. Lo que aquí contradice a §4 y §8.7
> gana; §3 y §4 ya lo describen.

### 10.1 Qué quedó

| # | Pedido | Qué quedó |
|---|---|---|
| 0 | Ventana a pantalla completa | `modal-box` con `w-screen h-dvh max-w-none max-h-none rounded-none`: 100vw × 100vh sin márgenes; a 390 px las pestañas se desplazan por dentro y la hoja de archivos no fija columnas (fijas no dejarían ver Estado) |
| 1 | Pestaña «Archivos», la inicial | Con ícono de casa: la zona para soltar, la hoja de archivos, «Ver documento» y los pasos (resultado incluido) |
| 2 | Una pestaña por destino con staging | Una por tabla destino `filas` (con `sheetUrl`) en cuanto un archivo analizado la alimenta: filas de su formato o adjuntos a una de sus columnas. Nombre de la tabla + insignias `+nuevas ~actualizadas −eliminadas` y errores (de la hoja abierta, con lo que editó la persona, o de `GET /staging`); «importada» cuando se guardó. Dentro, la `Sheet` real con los cambios pendientes y el panel de cambios. La hoja **sigue viva** al cambiar de pestaña (lo editado no se pierde) y se vuelve a pedir sola si cambian sus archivos (o con «Recalcular») |
| 2 | «Ver en staging» | La acción de la hoja de archivos (antes «Ver staging») abre la pestaña de su destino y **resalta las filas que salieron de ese archivo** (por `ImportChange.origen`; las idénticas a la tabla no son cambio y no se resaltan), lleva la hoja a la primera y dice «N filas resaltadas de «archivo»» (con ✕ para quitarlo). «Ver documento» sigue |
| 3 | Importar por staging y global | Cada pestaña trae «Importar {tabla}»: guarda solo esa hoja y `POST /import { staging, destinos: [tabla] }`. «Importar todo» (pie) lleva una insignia con el número de tablas por importar y, al pasar el cursor (o con el foco del teclado), un tooltip con cada tabla y sus conteos. Mismas reglas: con errores no sigue; replace con eliminaciones pide confirmar con conteo y lista; importar = guardar la hoja con el lote normal + `POST /import` |
| 4 | Señal de vida | Celda Estado con ícono: spinner animado (SVG) en `en_cola`, `analizando` e `importando`, y el texto de progreso del SSE («Analizando… leyendo el documento…»); check o error al terminar. Spinner en la pestaña Archivos mientras algo trabaja y en la de cada destino mientras se recalcula. El agente básico ahora también emite `progreso` por archivo (antes solo el cerebro): «empezando…», «Leyendo «x.csv»», «Mapeando 1 tabla a Planes GMF», «Revisando 3 filas», «guardando 3 filas…»; con modelo, uno por tool |
| 5 | Sin leyenda dentro del asistente | `legend={false}` en `SpreadsheetGrid`/`SpreadBase` (default `true`) |
| 6 | El agente conoce los stagings | Cada turno del cerebro trae «Stagings»: por tabla, modo, filas de hoy, conteos, errores y avisos con ejemplos, `sinEmparejar`, qué archivos lo alimentan y si ya se importó (`describirStaging`, en la librería); y «Ya importado». `verStaging` acepta el formato o el nombre de la tabla y devuelve también `tabla`, `archivos` e `importado`. El prompt tiene una sección STAGINGS. El agente básico los recibe en el sistema del chat. `PUT /staging` avisa `staging_editado` con qué cambió («aveo… · Seguro Gratis: vacío → «1 año»») y cómo quedó; las ediciones seguidas se agrupan (servidor 2 s; el cerebro une las que llegan juntas en un turno). `importacion_terminada` lleva `destinos` y el chat lo reporta por destino («Importé Planes GMF: … Falta 1 archivo por importar: notas.txt.») |

### 10.2 Contrato

- `POST /runs/:run/import` acepta `destinos?: string[]` (formatos). Un destino que no existe o `destinos`
  que no es lista de textos: 400. Sin archivos por importar en esos destinos: 400 («No hay archivos por
  importar en Planes GMF»).
- `ImportRun.importacion?: { destinos: string[] | null; archivos: string[] }` (tipo en core; sin cambios
  de exports): la última importación. Al cerrar la fase, la corrida queda `terminada` si todos los
  archivos tienen resultado; si no, `lista`.
- `ImportBrainEvent` `importacion_terminada` suma `destinos?`. `ImportAgentOptions.esperaEdicionMs`.
- `ImportAgent`: `avisarCerebro(id, evento)` pasa a público (lo usa `PUT /staging`), `stagingDeArchivo`,
  `etiquetaFormato`, `describirStagings(run)`, `conCerebro`, `esperaEdicionMs`; `obtener(id, null)` lee sin
  revisar el dueño (lectura interna del cerebro).
- Librería: `describirStaging(set, { label, archivos, columnas, publicado, importado })`.

### 10.3 Arreglos que salieron al hacerlo

- **El cerebro no veía el staging con dueño** (`owner`, como en el ejemplo): `host.stagingActual` pedía la
  corrida sin el contexto de la persona y daba 404, así que el contexto decía «no se pudo calcular» y
  `verStaging` fallaba. Ahora la lectura interna no revisa el dueño.
- **Claude sin saldo pasaba por respuesta**: el SDK devuelve `success` con `is_error` («Credit balance is
  too low»); el driver lo tomaba como texto del modelo y el archivo quedaba «Sin destino». Ahora es un
  error con ese motivo.
- La miniatura de una celda de texto (`avatar.image`) se perdía si su campo no era columna
  (`toGridRow` solo copiaba columnas) y si jspreadsheet pasaba la fila como texto.

### 10.4 Pruebas

- `tests/grid/asistente.test.ts`: AI-8 (pantalla completa a 1366 × 900, sin leyenda dentro y con leyenda en
  la hoja de la página, pestañas, spinner y progreso en vivo en Estado y en las pestañas, insignia y tooltip
  de «Importar todo», «Ver en staging» resalta la fila de cada archivo, importar solo Planes GMF con
  confirmación, la corrida queda `lista` y el chat lo dice, «Importar todo» cierra); AI-9 (390 × 844:
  pantalla completa, pestañas, staging con su botón, chat). AI-1, AI-4, AI-5 y AI-6 al día.
- `tests/protocol/asistente.test.ts` S-5: importar un solo destino.
- `tests/assistant/agente.test.ts`: progreso por archivo del agente básico y `describirStagings`.
- El ejemplo analiza despacio (0.7 s por paso) un archivo con «lento» en el nombre, para ver el progreso.

### 10.5 Pendiente

- Varios destinos con staging: la interfaz y el servidor ya los manejan (una pestaña y un botón por tabla;
  «Importar todo» los guarda uno tras otro), pero el ejemplo tiene uno solo: falta un segundo destino de
  ejemplo y su prueba.
- El panel de cambios sigue ocupando casi la mitad del staging a 1366 px.

