# 05 — Agent-based import assistant (SB-36)

> How the assistant is built on the server side: it turns any file (PDF,
> photos, Excel, text, zip) into rows of an SB-34 format, attaches it wherever
> the app says, or discards it; plus the HTTP contract that the client-side
> assistant consumes.

**Created:** 2026-10-08 · **Status:** 🟢 server (agent, run, routes, example) and client (`<ImportAssistant>`, `ImportAssistantState`) with the example page `/import-assistant`. v2 redesign (§7): **phase A done** (2026-10-09: what you see); **phase B done** (2026-10-09: the pluggable brain, §9). Second review (§8): **A2, S and T done** (2026-10-09, §8.7). Third (§10): **tabs per destination, import per destination, live progress and a brain aware of the stagings** (2026-10-09).

First consumer: Aggy Legacy (spec `CHEV7H`). Earlier pieces: `mongoSource`
(02 §4.3) and the P/X extraction (`packages/server/src/extraction/`).

---

## 1. What belongs to SpreadBase and what belongs to the app

Same principle as the source (SB-2): **the LLM, storage, run persistence and
the queue belong to the app**. SpreadBase defines the interfaces, the flow,
the tools and the routes, and ships a version of each piece to get started.

| Piece | Interface | Default (SpreadBase) | In Aggy |
|---|---|---|---|
| Model | `ImportLLM` (`generateStructured`, `chat`) | — (without `chat`, the agent works with rules) | Gemini adapter |
| Files | `ImportFileStorage` = `FileStorage` (SB-30) + `read` (+ `remove`) | `diskStorage` (already has `read`/`remove`), `memoryFileStorage` | GCS |
| Runs | `ImportRunStore` | `memoryRunStore` | Mongo |
| Queue | `ImportRunner` | `inProcessRunner({ concurrencia })` | Worker from `core/queues/` |
| Destinations | SB-34 formats, the app's `attach`, discard | — | One format per DataTable, `folder` field |
| Notifications | `onEvent` | — | Socket.IO, WhatsApp |

## 2. The agent

```ts
import { importAgent, importAssistantRoutes, inProcessRunner, memoryRunStore, diskStorage } from '@spreadbase/server';

const agent = importAgent({
	llm,                                   // the app's ImportLLM
	model: 'gemini-3.8-flash',             // passed to the adapter
	prompt: 'Los planes vienen del boletín mensual de GM…',   // appended to the base prompt
	destinations: [
		{ tipo: 'filas', formato: planesGmf, modos: ['upsert', 'replace'], modo: 'replace', actuales: planesSheet },
		{ tipo: 'adjuntar', id: 'fichas', label: 'Ficha técnica', attach: async ({ destino, archivo, derivados, contexto }) => { … } },
		{ tipo: 'descartar' }
	],
	context: async (run) => 'La tabla tiene 57 planes de septiembre…',   // extra context per run
	tools: [consultarRightLink],           // the app's tools
	runs: memoryRunStore(),
	runner: inProcessRunner({ concurrencia: 2 }),
	storage: diskStorage({ dir: 'uploads/imports', publicUrl: '/uploads/imports' }),
	limits: { maxArchivoMB: 50, maxLoteMB: 200, retencionDias: 30 },  // defaults
	owner: (ctx) => ctx.userId,            // who owns each run
	onEvent: (e) => io.to(e.corrida).emit('import', e)
});

router.use('/imports/assistant', importAssistantRoutes(agent, { context: (req) => ({ userId: req.user.id, accountId: req.account.id }) }));
```

### 2.1 `ImportLLM`

```ts
interface ImportLLM {
	// Method X: a response that matches a JSON Schema (per page).
	generateStructured(input: { instrucciones; imagenes: (Buffer | string)[]; texto?; schema; modelo? }): Promise<unknown>;
	// Agent loop: one turn with tools. Optional.
	chat?(input: { sistema: string; mensajes: LLMMensaje[]; tools: LLMTool[]; modelo?: string }): Promise<LLMRespuesta>;
}

type LLMParte = { tipo: 'texto'; texto } | { tipo: 'imagen'; datos: Buffer | string; mime? };
type LLMMensaje =
	| { rol: 'usuario'; partes: LLMParte[] }                       // text and images (vision)
	| { rol: 'agente'; texto?; llamadas?: LLMLlamada[]; meta? }     // what the model answered
	| { rol: 'tool'; id; nombre; resultado: unknown; imagenes?: Buffer[] };
interface LLMTool { nombre; descripcion; parametros: JsonSchema }
interface LLMLlamada { id?; nombre; args: Record<string, unknown> }
interface LLMRespuesta { texto?; llamadas?: LLMLlamada[]; meta?: unknown }
```

Decisions:

- **Provider-neutral.** Messages with their own roles (`usuario`, `agente`,
  `tool`) and text or image parts: each adapter translates them (Gemini:
  `user`/`model`, `functionCall`/`functionResponse`; OpenAI/Anthropic, just as
  direct). The example ships a minimal Gemini adapter using `fetch`.
- **SpreadBase keeps the history** and sends it in full on every turn: the
  adapter keeps no state.
- **The `id` of each call** is set by the adapter if the provider gives one;
  otherwise the agent generates it (`t1`, `t2`…) and the tool response echoes it.
- **Opaque `meta`** (2026-10-08, when testing with real Gemini): whatever the
  provider requires to be sent back as-is on the next turn. Gemini 3 rejects
  (`400 … missing a thought_signature`) a history whose `functionCall`s lack
  their `thoughtSignature`. The adapter puts the raw parts in
  `respuesta.meta`, the agent stores them in the `agente` message and the
  adapter sends them again.
- **`chat` is optional.** Without it (or without an LLM), the agent analyzes
  with rules: P, the table in which the most format columns are recognized
  (`locateTable`), mapping by headers, and `review`. With only
  `generateStructured`, images are read with X and follow the same path.

### 2.2 Phases

**Analyze** (`POST /analyze`, in the queue, per file):

1. The agent presents the file to the model: name, type, folder, destination,
   the **person's instruction for that file** (if any); a cheap index from
   method P (blocks per page with their headers) or the image itself.
2. The loop runs up to `maxIteraciones` (12): the model calls tools and gets
   their results. It ends with `terminar` or when it answers without calls.
3. If rows were left for a format, the agent runs `review` and stores the
   problems in the file. Before that, it merges rows that are **identical in
   everything** (the bulletin repeats tables across pages) and leaves the
   notice «N filas duplicadas idénticas se unieron»; if two rows share the key
   but differ, the error («Repetido: igual que la fila N») is rewritten with
   both rows and how they differ («Misma llave que la fila 3 pero difieren en
   Precio de lista (346500 ≠ 350000)»).
4. **The chat always reports**: the agent adds a message with the file's
   verdict, built without an LLM from its analysis, rows, errors and
   destination («planes.csv: 211 filas, 0 errores, listo para reemplazar» /
   «… 12 con error en Precio Final; ábrelo para verlos»). When the import
   finishes, a summary with one line per file.

**Chat** (`POST /chat`, synchronous): the model sees the status of each file
and the same tools (with an explicit `archivo`) plus `analizar` (redo a file).
**Before analyzing** (run `nueva`, files `pendiente`), the message is always
appended to the run's instructions, which the analysis reads; with a model, it
also answers (it knows it should not work on files yet); without one,
«Anotado: lo tomo en cuenta al analizar». Afterwards, without `chat`, the
message is appended to the run's instructions.

**Import** (`POST /import`, in the queue, per file):

| Destination | What happens | Result |
|---|---|---|
| `filas` · `replace` | `review`; **any error blocks it** (replacing with incomplete data would delete valid rows); otherwise, `apply` with all rows | `ok` or `error` |
| `filas` · `upsert` | `review`; `apply` only with the rows without errors; the bad ones stay in the run with their error | `ok`, `parcial` or `error` |
| `adjuntar` | the app's `attach({ destino, archivo, filas, derivados, corrida, contexto })` | `ok` (1) |
| `descartar` | nothing | `ok` (0) |
| no destination | nothing | `error` |

`apply` receives the mode in `ctx.context.modo` (`'upsert' | 'replace'`),
along with `corrida` and `archivo`: the format decides how to do the upsert
by identity or the atomic replace.

### 2.3 Base tools

| Tool | What it does |
|---|---|
| `leerDestino({ formato? })` | The destinations, or the columns of a format (type, required, aliases, options, key) |
| `extraerDeterminista({ archivo?, paginas? })` | Method P: blocks with their first rows (fewer rows if the document is large) |
| `extraerConLLM({ archivo?, paginas?, formato? })` | Method X on rendered pages or the image (max. `maxPaginasX`, 30) |
| `compararExtracciones({ archivo? })` | P against X, cell by cell, on the pages read with X |
| `verBloque({ metodo, bloque, desde, hasta })` | The rows of a block, in chunks of 100 |
| `mapearTabla({ formato, metodo, bloques, columnas?, fijos? })` | Blocks → format rows: headers by name or alias; values with their column's type (`$319,100` → 319100, `($60,000)` → −60000, `16.09%` → 16.09, `DD/MM/AAAA` → ISO) |
| `proponerFilas({ formato, modo?, desdeMapeo? \| filas?, agregar?, campos? })` | Writes the rows into the run and sets the destination |
| `editarFilas({ quitar?, quitarSi?, cambiar?, agregar? })` | Fixes what was proposed |
| `revisar()` | The format's `review`: problems per row and field |
| `leerFilasActuales({ formato, buscar?, limite? })` | What the destination table already has (via the `actuales` sheet or a function) |
| `crearDerivado({ nombre, contenido, tipo? })` | A derived file (e.g. `ficha.md`) to attach alongside the original |
| `fijarDestino({ destino })` · `terminar({ analisis, destino? })` | Choose the destination; close the analysis with the text for the Análisis column |

Every tool accepts `archivo` (id or name). A tool error goes back to the model
as `{ error }`; the loop continues. **The destination set by the person is not
changed**: tools that try to change it respond with the reason.

### 2.4 Limits and files

- Defaults: 50 MB per file, 200 MB per run, 30 days of retention, types
  `pdf png jpg jpeg webp heic xlsx csv txt json md docx zip`.
- The real type is checked from the content (`sniffType` from SB-30); HTML and
  SVG never.
- **Zip**: the client expands it (with its folder); the server opens it as a
  fallback, by hand with `node:zlib` (stored or deflate; no encryption or
  zip64), with a cap on the uncompressed size. Each file inside becomes a file
  of the run, with its path in `carpeta`.
- **.docx**: its text (`word/document.xml`) as a text block.
- In storage, the name is sanitized (`planes-octubre.csv`); the person is
  shown the original.

### 2.5 The run and concurrency

The run is a document (types in `@spreadbase/core`, `ImportRun`) with a
`version` that increases on every change. `ImportRunStore.guardar(run, versionLeida)`
only saves if nobody got there first; otherwise, the agent re-reads and
reapplies its change. That way, several files being analyzed at once, the chat
and the person setting destinations don't overwrite each other. With Mongo:
`replaceOne({ _id, version: versionLeida }, run)`.

Each file's rows live inside the run (for Mongo, watch out for the 16 MB per
document limit with files of tens of thousands of rows: the store can keep
them separately).

**App queue:** `encolar(trabajo)` puts `{ tipo: 'analizar' | 'importar',
corrida, archivo }` in its queue and its worker calls `agente.procesar(trabajo)`.
The in-process queue receives that `procesar` via `iniciar`.

---

## 3. HTTP contract (`importAssistantRoutes`)

All JSON except the upload (raw bytes, as in SB-30). Errors with the usual
shape: `{ error: { code, message } }`.

| Method and route | Body | Response |
|---|---|---|
| `GET /config` | — | `ImportAssistantConfig`: `{ destinos, limites, bienvenida }` (`bienvenida`: the first chat message, without an LLM; the app sets its own with the `bienvenida` option) |
| `GET /runs` | `?origen=` | `ImportRunView[]` of the requester (by `owner`); with `origen`, the open ones started from that table (to resume) |
| `POST /runs` | `{ instrucciones?, origen? }` | `201 ImportRunView` (`origen` is stored in `contexto.origen`) |
| `GET /runs/:run` | — | `ImportRunView` |
| `PATCH /runs/:run` | `{ instrucciones }` | `ImportRunView` (compatibility only: since v2 the general instructions arrive through the chat) |
| `POST /runs/:run/files` | bytes; headers `X-File-Name` and `X-Folder` (URI-encoded) | `201 ImportRunFileView[]` (several if it was a zip) |
| `DELETE /runs/:run/files/:file` | — | `ImportRunView` |
| `PUT /runs/:run/files/:file/destination` | `{ destino: ImportDestination \| null }` | `ImportRunView` (`null` releases the destination) |
| `PUT /runs/:run/files/:file/instruction` | `{ instruccion: string \| null }` | `ImportRunView` (instruction for that file; `null` removes it) |
| `GET /runs/:run/files/:file/rows` | — | `ImportFileRows`: `{ archivo, schema, filas, issues, resumen }` |
| `PUT /runs/:run/files/:file/rows` | `{ filas }` | `ImportFileRows` (corrected by the person and reviewed again; a file already imported or in error goes back to `analizado` to retry it) |
| `POST /runs/:run/analyze` | `{ archivos? }` | `202 ImportRunView` (files `en_cola`) |
| `POST /runs/:run/chat` | `{ texto }` | `{ mensaje, corrida }` (before analyzing, the text is appended to `instrucciones`) |
| `POST /runs/:run/import` | `{ staging?: [{ destino, resumen }], destinos?: string[] }` | `202 ImportRunView`. With `staging`, those destinations were already saved to their sheet: their files are marked imported without `apply`, and those that went to an unmatched column, in error. With `destinos` (§10), only the files that feed those stagings; the run goes back to `lista` while others remain (`importacion: { destinos, archivos }` on the run) |
| `GET /runs/:run/staging?destino=&modo=` | — | `ImportChangeSet` (§8.3): the destination table with the changes from the whole run |
| `PUT /runs/:run/staging` | `ImportStagingEdit`: `{ destino, cambios?, error? }` | `ImportChangeSet` (the person's edits are stored in `corrida.staging`; the agent reports `error` in the chat). Notifies the brain with `staging_editado` and what changed (grouped: `esperaEdicionMs`, 2 s) |

Specific errors: `413 file_too_large` / `batch_too_large`, `415
unsupported_type`, `409 run_closed` (uploading to an imported run), `409
still_analyzing` (importing before analysis finishes), `404` (another person's
run or a nonexistent one).

### 3.1 Types (in `@spreadbase/core`)

```ts
type ImportDestination =
	| { tipo: 'filas'; formato: string; modo: 'upsert' | 'replace' }
	| { tipo: 'adjuntar'; adjunto: string; tabla?; fila?; campo?; … }   // the rest is defined by the app
	| { tipo: 'descartar'; motivo? };

interface ImportRunView {
	id; contexto; propietario; instrucciones;
	estado: 'nueva' | 'analizando' | 'lista' | 'importando' | 'terminada';
	archivos: ImportRunFileView[];
	chat: { id; rol: 'usuario' | 'agente' | 'sistema'; texto; fecha }[];
	version; creada; actualizada; expira;
}

interface ImportRunFileView {
	id; nombre; tipo /* real MIME */; carpeta /* path or null */; url; tamano;
	estado: 'pendiente' | 'en_cola' | 'analizando' | 'analizado' | 'importando' | 'importado' | 'error';
	analisis /* Análisis column */; destino; destinoFijadoPorUsuario;
	instruccion /* from the person, for this file, or null */;
	campos /* data from the format's form */; resumen /* summary from the review */;
	totalFilas; totalErrores /* rows with errors */; totalAvisos;
	derivados: { nombre; tipo }[];
	resultado: { status: 'ok' | 'parcial' | 'error'; ok; error; mensaje?; resumen? } | null;
	error /* failure of the analysis or the import */;
}

interface ImportRunEvent {   // onEvent
	corrida; tipo: 'corrida' | 'archivo' | 'chat'; estado?; archivo?; mensaje?; resultado?;
	totales?: { ok; error; archivos };   // when the import finishes
}
```

### 3.2 How the client assistant uses it

| Wizard step | Calls |
|---|---|
| Open the assistant (moment 0) | `GET /config` (destinations, limits and welcome) → `POST /runs` (the chat already has a run) |
| ① Files (drop on the `target` or in the assistant; folders and zips expanded in the browser) | `POST /files` per file (with `X-Folder`) |
| Destination in the files sheet (set or correct it) | `PUT /files/:file/destination` (options from `GET /config`) |
| Instruction in the files sheet | `PUT /files/:file/instruction` (when the cell is confirmed) |
| General instructions | `POST /chat` before analyzing (the server stores them in the run) |
| ② Analysis | `POST /analyze`; refresh `GET /runs/:run` (or the app's socket) until `lista` |
| Chat | `POST /chat` |
| File detail (staging sheet with errors per cell) | `GET /files/:file/rows`; «Guardar correcciones»: `PUT /files/:file/rows` and, if it had already been imported and is now error-free, `POST /import` |
| ③ Import (the window can be closed) | `POST /import`; refresh until `terminada` |
| ④ Result | each file's `resultado`; Detail for those left in error |

---

---

## 4. The client: `<ImportAssistant>` and `ImportAssistantState`

```svelte
<!-- Shortcut: the sheet receives files; when the assistant closes, it reloads. -->
<SpreadBase {sheet} fill importAssistant={{ url: '/api/imports/assistant', origen: 'Planes GMF', aviso: 'te avisamos en el panel' }} bind:importOpen />
<button class="link" onclick={() => (importOpen = true)}>o elige archivos</button>

<!-- Or standalone, pointing at any container. -->
<div id="tabla-planes">…</div>
<ImportAssistant url="/api/imports/assistant" target="tabla-planes" origen="Planes GMF" bind:open onclose={recargarTabla} />
```

| Prop | What it is |
|---|---|
| `url` | The base of `importAssistantRoutes` |
| `headers` | Headers for every request (`Authorization`) |
| `target` | id or `HTMLElement` that receives files: while dragging, an overlay covers 100 % of the container; on drop, the assistant opens with those files uploading. Without `target`, it only opens with `open` |
| `dropHint` | Text of that overlay. Default: «Suelta para importar a {origen}» |
| `open` (bindable) | Open or closed (a modal `<dialog>`: focus trapped; Escape closes unless you are in a sheet, where it cancels the cell). Default: open without `target`, closed with it |
| `origen` | The source table, in the subtitle and in the overlay |
| `aviso` | How the app notifies when done («te avisamos en el panel y por WhatsApp») |
| `run` | Reopen an existing run |
| `onclose` | It was closed; the import, if started, continues on the server |
| `assistant` (bindable) | The `ImportAssistantState`, to read it from outside |

In `<SpreadBase>` and `<SpreadsheetGrid>`, **`legend`** (default `true`): `legend={false}` removes the bottom
legend («Celda editada sin guardar», «Fila nueva», «Valor inválido», «Fila eliminada» and the row
window); work notices («Resolviendo nombres…», «Cargando siguientes…») are still shown. The
assistant removes it in the files sheet and in each staging; other sheets don't change.

`ImportAssistantState` (§10) adds: `tab` (`'archivos'` or a destination's format), `stagings` (the sheets
open per destination), `destinationTabs` (tabs with files, counts, `trabajando`, `importado`),
`stagingOf(archivo)`, `openStaging(destino, { highlight, fresh })`, `highlightFile(destino, archivo)`,
`refreshSummaries()` and `importStaging(confirmado, destinos | null)`. In `GridController`:
`highlightRows(claves)` (highlights rows without touching data or changes) and `commands.revealRow(clave)`.

In `<SpreadBase>`: `importAssistant={{ url, origen, aviso, dropHint, headers, run, onclose, onassistant }}`
uses the sheet itself as `target` and reloads it on close; `bind:importOpen`
opens it from a link of your own.

**Layout** (phase A of §7, full screen since §10). The dialog takes up **the
whole screen** (`w-screen h-dvh`, no margins or corners) in two columns from
the moment it opens: the content on the left, in **tabs** (Archivos and one per
destination table, §10), and the **chat on the right, always visible** (≈ 1/3,
`min-w-80`), in every tab. Below `lg`, the chat is one more tab. The chat:
daisyUI bubbles (`chat-start`/`chat-end`) with author and time, the **welcome**
from `GET /config` as the first message (without an LLM), «pensando…» while it
answers and a fixed input at the bottom (Enter sends, Shift+Enter inserts a
line break). What is typed before analyzing becomes the run's instructions;
there is no longer a comments textarea.

**The four steps** (the step comes from the run's status; the arrows let you
go back to an earlier one):

1. **Files.** With no files, the drop zone fills the whole left panel
   («Elegir carpeta», «Elegir archivos», the limits from `GET
   /config`); with files it shrinks to a strip and the **files sheet** fills
   the panel. Dropping files on the panel also adds them. Folders are read
   with the native API (`webkitGetAsEntry` on drop, `webkitdirectory` when
   choosing) and zips are opened in the browser with `jszip` (if it can't,
   the zip is uploaded as-is and the server opens it). Each file uploads as
   soon as it arrives.
2. **Analysis.** The same sheet with the agent's Estado, Análisis, Destino,
   Filas and Errores; the agent leaves a verdict per file in the chat.
   Footer: «← Archivos» and «Importar →».
3. **Importing.** «Importando en segundo plano. Puedes cerrar esta ventana:
   {aviso}.»; each file's result in Estado. Footer: «Cerrar (sigue en
   segundo plano)».
4. **Result.** Cards for imported items (rows and attachments) and those in
   error; the import summary in the chat. Footer: «← Volver al análisis» and «Listo».

**The files sheet** is a local `Sheet` (in memory), in the **Archivos** tab:
Documento and Staging (actions) · Icono (thumbnail of the image or a label
with the extension) · Nombre · Tipo · Carpeta · Estado (with an icon: animated
spinner while queued, analyzing or importing, plus live progress) · Análisis ·
Destino · Instrucción · Filas · Errores · Abrir (· Quitar in step 1). Only
**Destino** (select with «Automático» and the options from `/config`, one per
mode of each format) and **Instrucción** are editable, in steps 1 and 2; when
the cell is confirmed, `PUT …/destination` or `PUT …/instruction` is called.
Normal row height; Errores are shown in red; Icono and Nombre stay pinned
while scrolling.

**A file's detail** («Abrir») replaces the whole left panel, with breadcrumbs
«Archivos › nombre»: the full analysis and, if the file goes to rows, its
**staging sheet** (local `Sheet`, editable, with row insertion and deletion)
with errors in the cell (red), warnings (amber), the reason in the tooltip and
a «Problemas» column pinned on the left; columns with errors come first and
general notices («2 filas duplicadas idénticas se unieron») go on top.
«Guardar correcciones» → `PUT …/rows`; if the file had already been through
an import attempt and is now error-free, it is imported again. After a partial
`upsert` the sheet only brings the rejected rows. A file without rows (attach,
discard) shows its preview. If the agent changes the file (finishes its
analysis, «excluye contado»), the detail is re-read.

While analyzing or importing, the state re-reads the run every second
(`pollMs`); an app with a socket can call `assistant.refrescar()` when an
`ImportRunEvent` arrives. `ImportAssistantState` is the same state without a
UI (like `ImportState` from SB-34), for anyone who wants to render it their
own way; `init()` creates the run on open and `reset()` starts another one
(the assistant does it on its own if files are dropped on an already imported
run). Only Tailwind/daisyUI classes: it takes the app's theme.

## 5. Example and tests

- Example: the `/import-assistant` page (the «Planes GMF» table with the
  `importAssistant` shortcut: you drop onto it; «o elige archivos» opens it) against `examples/backend/src/examples/import-assistant/` at
  `/api/import-assistant`: a «Planes GMF» format over an in-memory sheet
  (`/api/import-assistant/planes`), an `adjuntar` destination that only logs
  (`/fichas`), and discard. Scripted model by default (no network); Gemini with
  `IMPORT_ASSISTANT_LLM=gemini` and `GEMINI_API_KEY`.
- Tests: `tests/assistant/` (agent with rules and with a scripted model, HTTP
  routes, the real bulletin with `EXTRACTION_PDF`), `tests/mongo/asistente.test.ts`
  (end to end over `mongoSource`), `tests/protocol/asistente.test.ts`
  (the example running: welcome, instructions via the chat, identical
  duplicates, verdicts) and `tests/grid/asistente.test.ts` (the assistant in
  the browser: drop on the table with its overlay, chat with welcome and no
  textarea, folder and zip, destination and instruction in the sheet, analysis
  and verdict, chat, arrows, staging with the error in the cell and no
  overlapping panel, import, fix and retry, chat in a tab on a small screen).

## 6. Pending

- Automatic retention: `agente.purgar()` exists; something still has to call
  it (an app cron).
- For Mongo, keep a run's rows separately if a file brings tens of thousands.
- Large PDF: today the model receives P's full index; an index by batches of
  pages for documents with hundreds.

---

## 7. v2 redesign (proposal, 2026-10-09)

> Comes from Sergio's test with the real bulletin (8 observations). It is
> implemented in two phases. **Phase A (done, 2026-10-09): everything you
> see**, on top of the current agent. **Phase B (pending): a more capable,
> pluggable brain** (§8.6, §9). Whatever here contradicts §2–§4 wins; §3 and
> §4 already describe phase A.

### 7.0 Phase A: what was done (2026-10-09)

| # | Item | Status |
|---|---|---|
| 1 | Direct drop on the table: `target` + `dropHint` in `<ImportAssistant>`, overlay over 100 % of the container, `importAssistant` shortcut (and `bind:importOpen`) in `<SpreadBase>`; the example without a button, with «o elige archivos» | ✅ |
| 2 | Two columns from moment 0 (chat always visible, `min-w-80`), dialog `w-[min(96vw,1400px)] h-[90vh]`, chat in a tab below `lg`, bubbles with author and time, «pensando…», fixed input | ✅ |
| 3 | Welcome without an LLM in `GET /config` (`bienvenida`, configurable with the option of the same name) | ✅ |
| 4 | No textarea: what is typed in the chat before analyzing is appended to `instrucciones` (the analysis already read them); the run is created on open | ✅ |
| 5 | Drop zone at 100 % of the left panel with no files; a strip with files | ✅ |
| 6 | Files sheet (local `Sheet`) with editable Destino and Instrucción → `PUT …/destination` and `PUT …/instruction` | ✅ |
| 7 | Detail = staging sheet over the whole left panel, breadcrumbs, errors (red) and warnings (amber) in the cell with tooltip, «Problemas» column, «Guardar correcciones»; without the 100 px red panel. Errors from the final result are shown in the same sheet | ✅ (per-cell amber is new in `GridController.setExternalErrors({ level: 'warning' })`) |
| 8 | Identical duplicates collapsed in the agent's `review` with a notice; same key but different: an error naming both rows and how they differ | ✅ |
| 9 | The chat always reports: a verdict per file when its analysis finishes and a summary per file when the import finishes, without an LLM | ✅ |

Left for **phase B**: a pluggable brain (one thread per run with the
analysis, the import and the chat as turns of the same agent; system turns
per event and a proactive agent), `GET
/runs/:run/events` (SSE) with chat streaming and progress in Estado, `POST
/runs/:run/stop` and the «Detener» button, the diff against the current table
before publishing, `ImportRunView.etapa` and `ImportStagingView`, and the
agent's explanation with both rows side by side and which one to keep (today
the error message already names both rows and their differences).

### 7.1 What changes, item by item

| # | Observation | Change |
|---|---|---|
| 1 | Drag & drop directly on the table, without an «Importar» button | `target` prop (id or element): the component becomes the drop receiver for that container and opens the assistant on drop. Shortcut: `<SpreadBase importAssistant={{ url }} />` |
| 2 | The drop zone must fill everything | While dragging, an overlay over 100 % of the `target` (`absolute inset-0`); inside the assistant, the zone fills the whole left panel while there are no files |
| 3 | Remove the comments textarea | Gone. General instructions go in the chat; the agent's first message explains what it is for. `PATCH /runs/:run { instrucciones }` remains only for compatibility |
| 4 | Files table as a SpreadBase sheet | The file list is a local `Sheet` (in-memory source): Icono · Nombre · Tipo · Carpeta · Estado · Análisis · Destino ✎ · Instrucción ✎ · Filas · Errores. Only Destino (select) and Instrucción (text) are editable; normal row height, the full Análisis in the detail panel |
| 5 | The assistant must be the smartest element | A single agent per run, with all the context and proactive (§7.2) |
| 6 | Errors in the same table; replace shouldn't produce those errors | Staging per file (§7.3): errors are marked cells of the staging sheet, not a separate panel; the chat always reports. Identical duplicates are collapsed (§7.4) |
| 7 | Chat visible from moment 0, good look & feel | Fixed two-column layout: content on the left (≈ 2/3) and chat on the right (≈ 1/3, `min-w-80`), from the moment it opens. On small screens, the chat is a tab |
| 8 | Red panel overlapping with a 100 px sheet: unacceptable | It disappears. A file's detail replaces the whole left panel (full-height staging sheet, with breadcrumbs «Archivos › planes.pdf») |

### 7.2 The agent: one brain per run

Today there are two loops that don't see each other (per-file analysis and chat). In v2:

- **One conversation per run.** The analysis of each file, the import and the
  chat are turns of the same agent, with conversation memory (the last turns
  in full, earlier ones summarized).
- **Full context on every turn**, built by `context(run)`:
  - files with their status, destination (and whether the person set it) and instruction;
  - wizard stage;
  - progress of each queued job;
  - totals and errors of the staging per file, with a sample;
  - results of earlier imports;
  - what the destination table has today: count and summary (`summarizeData`).
- **Proactive.** Run events come in as system turns and the agent decides
  whether to speak:
  - file uploaded;
  - analysis finished;
  - `review` with problems;
  - import finished or failed.

  When an analysis finishes it always emits a one-line verdict per file
  («211 filas, 0 errores, listo para reemplazar» / «tomé la guía de
  administración, ¿la descarto?») and a concrete question if something is ambiguous.
- **Answers any question** about the run, the data or the format (it has the
  read tools in addition to the editing ones).
- **Iterative correction:** the person says «quita las filas de Montana LCCN» or
  «el precio final es lista menos descuento, no bonificación»; the agent edits
  the staging (`editarFilas`), runs `revisar` and reports the before and after.
- **Investigates before reporting.** If `review` fails en masse on a column,
  the agent looks for the cause before saying «no cuadra»: another section of
  the document, another table on the same page or a wrongly mapped header.
  Prompt rule: distinguish sections of the bulletin (salesperson guide versus
  administration guide).
- **Budget and control** (from the engine): caps on turns, time, tokens and
  vision pages per file; `AbortSignal` from the «Detener» button.
  Plus live events (user channel: chat text streamed; layer channel:
  «leyendo página 4/12…» in the Estado column).
- **First message** (moment 0, no LLM, fixed configurable text): what it can
  do, that it accepts instructions in the chat («los planes de octubre
  reemplazan a los de septiembre», «ignora las páginas de seminuevos») and
  which destinations exist.

### 7.3 Staging: how it works

Answer to «¿cómo funciona el staging?»:

1. **Each file with a `filas` destination has its own staging sheet**: the
   rows proposed by the agent, with the format's schema, stored in the run by
   `ImportRunStore`. With Mongo they can go in a separate collection
   `import_staging { corrida, archivo, filas }` so as not to hit the 16 MB
   limit. The real table **is not touched**.
2. **Review runs on the staging.** The SB-34 format's `review` on every
   change, whether by the agent or by the person editing the sheet. Problems
   are recorded per row and field and painted in the cell (red = error,
   amber = warning, reason in the tooltip and in a «Problemas» column).
3. **The person and the agent edit the same sheet.** What the person changes
   in a cell reaches the agent as an event; what the agent changes is visible
   instantly.
4. **Publish = `apply`.** Only when the file has no errors (`replace`) or with
   the error-free rows (`upsert`). Before publishing, the agent shows the diff
   against the current table (`leerFilasActuales`): N new, N changed, N that
   disappear with `replace`. The person confirms.
5. **After publishing**, the staging stays in the run as a record (30 days)
   and the Resultado column links to it.

That is why, with `replace`, there must be no errors at the end: the block
happens **before**, in the staging, visible and fixable right there, not as a
surprise at import time.

### 7.4 «Versión: repetido igual a fila N»

It is the format's unique-key rule within the same file (two rows with the
same key). It matters with `replace` because the table is rebuilt from what
the file brings: two rows with the same key leave it ambiguous which one stays.
In v2:

- **Identical in everything:** they are collapsed in the staging without an
  error, with a notice «3 filas duplicadas idénticas se unieron» (the bulletin
  repeats tables across pages).
- **Same key but different:** still an error, and the agent explains it with
  both rows side by side and proposes which one to keep.

### 7.5 Client API

```svelte
<!-- Option A: shortcut on the sheet -->
<SpreadBase sheet={planes} importAssistant={{ url: '/api/imports/assistant', origen: 'Planes GMF', onclose: recargar }} />

<!-- Option B: standalone component pointing at any container -->
<div id="tabla-planes"> … </div>
<ImportAssistant url="/api/imports/assistant" target="tabla-planes" origen="Planes GMF" onclose={recargar} />
```

| New prop | What it is |
|---|---|
| `target` | id or `HTMLElement` that receives the drop; without `target`, the assistant only opens with `open` |
| `dropHint` | Text of the overlay while dragging («Suelta para importar a Planes GMF») |

`open` still exists to open it from a button of your own. The `<dialog>`
becomes almost full screen (`w-[min(96vw,1400px)] h-[90vh]`).

### 7.6 Changes per layer

| Layer | Files | Change |
|---|---|---|
| core | `importAssistant.ts` | `ImportRunView.etapa`, `ImportStagingView` (rows + issues + diff), agent events (`texto parcial`, `progreso`) |
| server | `importAgent/agent.ts`, `tools.ts`, `routes.ts` | Pluggable agent (`ImportBrain`); a single thread per run; system turns per event; `GET /runs/:run/events` (SSE); `POST /runs/:run/stop`; staging and diff; collapse identical duplicates |
| client | `ImportAssistant.svelte`, `ImportAssistantState.svelte.ts`, `SpreadBase.svelte` | `target`/drop overlay; two-column layout; files sheet and staging sheet as local `Sheet`s; chat with streaming; no textarea or red panel; `importAssistant` prop on `SpreadBase` |
| example | `examples/frontend/src/routes/import-assistant/+page.svelte` | No button: drop on the table |
| tests | `tests/grid/asistente.test.ts`, `tests/assistant/*` | Drop on the `target`, chat visible on open, edit destination/instruction in the sheet, staging with errors in cells, correction via chat, identical duplicates collapsed, diff before publishing, stop |

### 7.7 Order

1. Server: pluggable agent + staging + SSE.
3. Client: layout, `target`, sheets.
4. E2E tests.
5. Test with the real October bulletin (golden of 57 rows).

---

## 8. Sergio's second review (2026-10-09): staging = the destination table with the changes

> Comes from testing phase A with the real MY26/MY27 bulletin. **Replaces §7.3** (staging per file)
> and sets the order: **A2 → S → T**, with **B** (the agent) in parallel.

### 8.1 What the staging is

**A copy of the destination table with the complete data up to that moment and all of the import's
changes applied**, combining all the files of the run. It is not a list of rows per file.

- **It looks like the real sheet**, with its schema, types and formatting, and the changes marked as
  **pending** with the usual states: edited cell, new row, deleted row. Those changes appear in the
  **change-tracking panel** (`ChangesPanel`).
- **The person can edit the staging** like any sheet.
- **«Importar» applies the changes as they are** to the table. It is the usual save: a batch with its
  validation and its conflicts.
- **Errors go in the cell** (the sheet's external errors, red or amber) and the chat summarizes them.

Example:
- **Planes GMF table:** `paquete | precio de lista | imagen | archivos (carpeta) | fichaTecnica`.
- **Dropped:**
  - a folder of photos named after units;
  - a folder of technical sheets in PDF.
- **The staging ends up like this:**
  ```
  paquete | precio de lista | imagen          | archivos (folder)           | fichaTecnica
  A       | 885000          | <thumbnail>     | files/FichaTecnica.pdf      | «full content in md or JSON»
  ```
  Each changed cell is marked as pending and ready to apply.

### 8.2 Rules for the agent (they apply to phase B and to the current agent)

- **Its job is to extract correctly and build the staging. It never discards a file because of its content.**
  «Descartar» is the person's decision (or a destination the person set).
- **When in doubt it asks, and always with concrete evidence.**
  - It names which pages, which block and which rows, and shows 2 or 3 sample rows side by side.
  - Correct example: «las páginas 9–14 son la *Guía para administración* (Bonificación) y las 2–7, la
    *Guía para vendedor* (Descuento cliente). Para AVEO HB LS el descuento es −$60,000 en una y
    −$45,000 en la otra. ¿Uso la de vendedor?».
  - Forbidden: «datos contradictorios» without saying which.
- **Several files on the same rows:**
  - a photo or a PDF is **matched with the row** by unit name, model or version, and fills its
    column (`IMAGE`, `FILE`, `FOLDER`, text);
  - they don't create new rows unless the person asks;
  - whatever doesn't match is listed in the chat with the reason.
- **The analysis in the «Análisis» column and what the chat says must match and be concrete.**

### 8.3 Staging contract (shared by S and B)

In `@spreadbase/core` (`importAssistant.ts`):

```ts
/** Where a value came from: for «why did you put this?» and to jump to the document. */
interface ImportOrigin { archivo: string; pagina?: number; bloque?: string; fila?: number; nota?: string }

type ImportChange =
	| { op: 'insert'; key: string; valores: Record<string, unknown>; origen: ImportOrigin[] }
	| { op: 'update'; key: string; id?: string; campos: Record<string, { antes: unknown; despues: unknown; origen: ImportOrigin[] }> }
	| { op: 'delete'; key: string; id?: string; motivo: string };   // only with replace or if the person asks
// `id` (added in S, 2026-10-09): the row's id in the destination sheet (`idField`), to apply the
// change in the real `Sheet`. `key` is still the format's key (or the destination's `llave`).

interface ImportChangeSet {
	destino: string;                    // format / table id
	modo: 'upsert' | 'replace';
	base: { version?: unknown; filas: number };  // the destination table when it was computed
	cambios: ImportChange[];
	problemas: { key: string; campo?: string; nivel: 'error' | 'aviso'; mensaje: string }[];
	sinEmparejar: { archivo: string; motivo: string }[];
	resumen: { insert: number; update: number; delete: number; errores: number; avisos: number };
}
```

- **Routes:**
  - `GET /runs/:run/staging?destino=` → `ImportChangeSet`, computed against the current rows of
    the destination table by key;
  - `PUT /runs/:run/staging` with the person's edits;
  - the agent writes with `proponerCambios` / `editarCambios` (phase B) or, in the meantime, the
    server turns each file's proposed rows into a single merged `ImportChangeSet`.
- **The client**: opens the destination's **real** `Sheet` (the sheet URL comes from `GET /config` per
  destination), applies `cambios` to it as pending, paints `problemas` as external errors and shows
  the changes panel. «Importar» = `sheet.save()` and then `POST /runs/:run/import` marks the run.
  `adjuntar` destinations still go through their `attach`.

### 8.3.1 Replace versus upsert in the staging (confirmed by Sergio, 2026-10-09)

Only the staging changes; importing is always saving the sheet as it is. The comparison is **by key**
against the current table:

| Row | Replace | Upsert |
|---|---|---|
| Exists and comes with changes | `update`: yellow, only the cells that change | same |
| Exists and comes identical | no mark | no mark |
| New key | `insert`: green | same |
| Exists and isn't in the files | `delete`: deleted (struck through) | untouched, no mark |

Everything is not deleted and reinserted: that way you see what really changed and the ids are kept,
and with them lookups, references and history. The final result is the same.

- **Key change** = `delete` + `insert`. If the agent detects that it is the same unit (version
  rename), it says so in the chat and proposes treating it as an `update`.
- **Replace with deletions asks for confirmation** before importing, with the count and the list: «se
  eliminarán N filas: …».

### 8.4 UI fixes (A2)

1. **The «Importar archivos» button comes back** alongside the drop on the table. If that person has
   an open run from that source (`GET /runs`), the assistant **resumes it where it left off**:
   step, files and chat.
2. **Actions at the start, on the left**, in the files sheet. There are two:
   - **Ver documento**: the file's preview, as today;
   - **Ver staging**: the destination table with the changes (§8.1).

### 8.5 New types (T)

- **`FILE`**: an uploaded file (SB-30); cell with icon, name and size; click opens or downloads.
- **`FOLDER`**: several files; cell with count and list.

The canonical value, the rules, uploading from the cell and their place in `postgresSource` and
`mongoSource` are defined in `docs/04-tipos-de-columna.md` (new SB). The plans example adds
`imagen`, `archivos` and `fichaTecnica` to test them.

### 8.6 Where the agent lives (B)

`packages/server` is the open source library and **does not depend** on an agent engine or on a
single-provider SDK. The agent becomes **pluggable**:

- the library defines the interface of the assistant's brain and ships the current agent as the
  default version;
- a more capable implementation is provided by the app that uses SpreadBase, outside the library (§9).

---

### 8.7 What was done in A2, S and T (2026-10-09)

**A2 (UI).**
- `<SpreadBase importAssistant>` puts **«Importar archivos»** back in the toolbar (`button: false`
  removes it); the drop on the table and its overlay remain.
- On open, `ImportAssistantState` (option `origen`) requests `GET /runs?origen=` and **resumes** the
  person's most recent unfinished run on that table (step, files and chat; «Retomada» badge); if
  there is none, it creates one with `origen`. **«Empezar de cero»** in the header creates a new empty one (`startOver()`).
- In the files sheet, **at the start and on the left**, two actions: **Ver documento** (the file over
  the whole panel: image, PDF or «ábrelo en otra pestaña») and **Ver staging**. The «Abrir» column and the
  old per-file rows view (staging per file, «Guardar correcciones») were removed from the component; the
  `…/files/:file/rows` routes remain on the server and `openDetail`/`retry` in the state, for compatibility.
- **Live** (requested after phase B): the state listens to `GET /runs/:run/events` with `fetch` (it carries
  the headers) and reconnects; chat text arrives in parts (live bubble), progress goes to the
  Estado column («Analizando… usando verPaginas…») and to the chat status, and a `corrida` event re-reads
  the run. **«Detener»** in the chat header (while thinking or analyzing) → `POST /stop`.

**S (real staging).**
- Core: `ImportOrigin`, `ImportChange`, `ImportChangeSet` (§8.3) plus `ImportStagingState`
  (`corrida.staging[destino]`: the person's `cambios` with their `firma`, and `publicado` with the summary and
  what didn't match) and `ImportStagingEdit`. **Contract change:** `update` and `delete` carry `id?` (the
  row's id in the sheet). `ImportDestinationOption` adds `sheetUrl?` (rows) and `columna?` (attach).
- Server (`importAgent/stagingCorrida.ts`): merges the proposed rows of all files with a `filas`
  destination for that format (`calcularStaging` from `brain/staging.ts`), compares by the destination's
  key (`llave` in the declaration, or the format's) against the current rows (`actuales`), and produces
  `insert`, `update` (only the fields that change, `antes`/`despues`/`origen`) and, only with `replace`
  and if the files bring rows, `delete`; identical rows produce no change; `problemas` comes from each
  `review` (by key and field). It adds the brain's changes (`cambiosDelCerebro`: content-based matches and
  `proponerCambios`) and the files that go to a column (T). If the brain builds its whole staging
  (`stagingDelCerebro`), its own is used. Edits saved with `PUT` hold as long as the `firma` of what the
  files propose doesn't change.
- `GET /config` gives `sheetUrl` per destination (absolute or relative to the routes' base).
- Client: «Ver staging» creates the destination's **real** `Sheet` (no local draft) and, on load, applies
  the changes to it with `GridController.stageChanges` (new: fetches by id the rows outside the window; a
  single history action): yellow update only on the cells that change, green insert, struck-through
  delete; `problemas` as warnings in the cell (red/amber) and those without a row on top; `sinEmparejar` as
  warnings; and it opens the **changes panel**. What the person edits is sent with `PUT` (600 ms).
- **«Importar»** opens the staging if needed; with cells in error it doesn't continue; a `replace` with
  deletions asks for **confirmation with the count and the list** («Se eliminará 1 fila de Planes GMF: …»,
  Cancelar / «Eliminar N e importar»); then it **saves the sheet** (`grid.save()`: the usual batch, with its
  validation and conflicts) and `POST /import { staging }` marks the run and processes the `adjuntar` ones. A
  server rejection goes back **to the cell** (new in `GridController`: the `details` of a
  `validation_error` are marked in their cell) and **to the chat** (`PUT /staging { error }`).
- Steps: «Importando» unchanged; «Resultado» counts new, updated and deleted (+ attachments); the chat
  adds «Planes GMF: 1 nueva, 1 actualizada, 1 eliminada.»; each file says «Guardado con el staging».
- Example: the Planes GMF sheet is the real destination (`sheetUrl: 'planes'`, `llave` = the plan's identity,
  insertions and deletions allowed, the list + discount = final rule also on save), it starts with 3 plans
  «de septiembre» and has `POST /planes/dev/reset` (test only).

**T (`FILE` and `FOLDER` types, SB-38).** See `04-tipos-de-columna.md` §3. The plans sheet adds `imagen`
(`IMAGE`), `archivos` (`FOLDER`) and `fichaTecnica` (long text, viewer with «Formatear JSON»). `adjuntar`
destinations with `columna` (`imagen`, `archivos`, `ficha`): **deterministic matching** by the file (or
folder) name against `modelo`/`version`/`paquete`, the whole unit receives the file; `destino.fila`
wins if present; whatever doesn't match or is ambiguous goes to `sinEmparejar` (a warning in the staging) and,
on import, that file ends up in error with the reason.

**Tests.** `tests/protocol/asistente.test.ts` (S-1…S-4, T-1…T-3: 2 files merged, update only with
changed fields, identical rows unmarked, delete only in replace, upsert without delete, problems by key,
PUT/GET of edits and their invalidation, import marking without applying, error to the chat, matches);
`tests/grid/asistente.test.ts` (AI-4 button and resume, actions on the left and document; AI-5 real staging
in replace with yellow/green/struck-through, changes panel, editing, confirmation, save error in the
cell and the chat, save as-is; AI-6 matching in the staging; AI-7 live and «Detener»; AI-1
updated); `tests/grid/archivos.test.ts` (AR-1, AR-6, AR-7); `tests/postgres/archivos.test.ts` and
`tests/mongo/archivos.test.ts`.

**Pending.** The staging of several destinations is saved one after another (each one opens its sheet); the
format's rule (`review`) in upsert no longer publishes «only the good ones»: with errors nothing is imported until
those rows are fixed or removed; the changes panel takes up almost half of the left panel on
1366 px screens; ~~no `staging_editado` event is sent to the brain from `PUT /staging`~~ (closed in §10).

## 9. Pluggable assistant brain (phase B, 2026-10-09)

The library doesn't ship a provider's brain: it defines the interface and the usual agent as the default
version. An app can plug in its own (for example, from its own service) with `importAgent({ brain })`.

### 9.1 What was implemented

**In the library** (`packages/server`, without depending on any model provider):
- `importAgent/brain/types.ts`: `ImportBrain` (`manejar(evento, host)`, `cambiosExtra?`, `staging?`,
  `detener?`, `olvidar?`), `ImportBrainEvent` (`archivos_subidos`, `analizar`, `chat`, `staging_editado`,
  `importacion_terminada`), `ImportBrainHost` (up-to-date run, `signal` from «Detener», base tools,
  schema and key, current rows, `stagingActual`, P, pages to PNG, `decir`, `emitir`, and the usual
  agent in `basico`) and `ImportLiveEvent` (text in parts, progress, tools, cost, stopped, run
  events).
- `importAgent/brain/basic.ts`: `cerebroBasico()`, the usual agent behind the interface (without
  `brain`, the agent does the same).
- `importAgent/brain/staging.ts`: `calcularStaging` (pure: the files' rows + extra changes against the
  current table by key, §8.3.1) and `llavePorOmision`; `stagingCorrida.ts` (S) uses it too.
- `agent.ts` (localized hook): `importAgent({ brain })`; analysis and chat go through
  `brain.manejar`; uploads, edits and finished imports are notified to it without waiting; `suscribir`,
  `detener`, `host(id)`, `stagingDelCerebro`, `cambiosDelCerebro`. With a brain, the chat verdict
  carries the Análisis text (rule 5).
- `routes.ts`: `GET /runs/:run/events` (SSE: `texto`, `texto_fin`, `progreso`, `herramienta`, `costo`,
  `detenido`, `corrida`) and `POST /runs/:run/stop` (`{ detenido }`).

### 9.2 How to test it

```sh
npm run back        # the example, with the usual agent
npm test -- assistant
```

## 10. Sergio's third review (2026-10-09): tabs per destination

> Comes from using the assistant with the real bulletin and the Claude brain. Whatever here contradicts §4 and §8.7
> wins; §3 and §4 already describe it.

### 10.1 What was done

| # | Request | What was done |
|---|---|---|
| 0 | Full-screen window | `modal-box` with `w-screen h-dvh max-w-none max-h-none rounded-none`: 100vw × 100vh without margins; at 390 px the tabs scroll internally and the files sheet doesn't pin columns (pinned ones would hide Estado) |
| 1 | «Archivos» tab, the initial one | With a house icon: the drop zone, the files sheet, «Ver documento» and the steps (result included) |
| 2 | One tab per destination with staging | One per `filas` destination table (with `sheetUrl`) as soon as an analyzed file feeds it: rows of its format or attachments to one of its columns. Table name + badges `+new ~updated −deleted` and errors (from the open sheet, with the person's edits, or from `GET /staging`); «importada» once it was saved. Inside, the real `Sheet` with the pending changes and the changes panel. The sheet **stays alive** when switching tabs (edits are not lost) and is re-requested on its own if its files change (or with «Recalcular») |
| 2 | «Ver en staging» | The files sheet action (formerly «Ver staging») opens its destination's tab and **highlights the rows that came from that file** (via `ImportChange.origen`; rows identical to the table are not a change and are not highlighted), scrolls the sheet to the first one and says «N filas resaltadas de «archivo»» (with ✕ to clear it). «Ver documento» remains |
| 3 | Import per staging and globally | Each tab has «Importar {tabla}»: saves only that sheet and `POST /import { staging, destinos: [tabla] }`. «Importar todo» (footer) carries a badge with the number of tables to import and, on hover (or keyboard focus), a tooltip with each table and its counts. Same rules: with errors it doesn't continue; replace with deletions asks to confirm with count and list; import = save the sheet with the normal batch + `POST /import` |
| 4 | Sign of life | Estado cell with an icon: animated spinner (SVG) on `en_cola`, `analizando` and `importando`, and the SSE progress text («Analizando… leyendo el documento…»); check or error when done. Spinner on the Archivos tab while something is working and on each destination's tab while it recalculates. The basic agent now also emits `progreso` per file (before, only the brain did): «empezando…», «Leyendo «x.csv»», «Mapeando 1 tabla a Planes GMF», «Revisando 3 filas», «guardando 3 filas…»; with a model, one per tool |
| 5 | No legend inside the assistant | `legend={false}` in `SpreadsheetGrid`/`SpreadBase` (default `true`) |
| 6 | The agent knows the stagings | Each brain turn includes «Stagings»: per table, mode, current rows, counts, errors and warnings with examples, `sinEmparejar`, which files feed it and whether it was already imported (`describirStaging`, in the library); and «Ya importado». `verStaging` accepts the format or the table name and also returns `tabla`, `archivos` and `importado`. The prompt has a STAGINGS section. The basic agent receives them in the chat's system prompt. `PUT /staging` sends `staging_editado` with what changed («aveo… · Seguro Gratis: vacío → «1 año»») and how it ended up; consecutive edits are grouped (server 2 s; the brain merges those that arrive together in one turn). `importacion_terminada` carries `destinos` and the chat reports it per destination («Importé Planes GMF: … Falta 1 archivo por importar: notas.txt.») |

### 10.2 Contract

- `POST /runs/:run/import` accepts `destinos?: string[]` (formats). A destination that doesn't exist or
  `destinos` that isn't a list of strings: 400. No files to import in those destinations: 400 («No hay
  archivos por importar en Planes GMF»).
- `ImportRun.importacion?: { destinos: string[] | null; archivos: string[] }` (type in core; no changes
  to exports): the last import. When the phase closes, the run becomes `terminada` if all files have a
  result; otherwise, `lista`.
- `ImportBrainEvent` `importacion_terminada` adds `destinos?`. `ImportAgentOptions.esperaEdicionMs`.
- `ImportAgent`: `avisarCerebro(id, evento)` becomes public (used by `PUT /staging`), `stagingDeArchivo`,
  `etiquetaFormato`, `describirStagings(run)`, `conCerebro`, `esperaEdicionMs`; `obtener(id, null)` reads
  without checking the owner (the brain's internal read).
- Library: `describirStaging(set, { label, archivos, columnas, publicado, importado })`.

### 10.3 Fixes that came up along the way

- **The brain didn't see the staging when there was an owner** (`owner`, as in the example):
  `host.stagingActual` requested the run without the person's context and got a 404, so the context said
  «no se pudo calcular» and `verStaging` failed. Now the internal read doesn't check the owner.
- **Claude with no credit was taken as an answer**: the SDK returns `success` with `is_error` («Credit balance is
  too low»); the driver took it as model text and the file ended up «Sin destino». Now it is an
  error with that reason.
- A text cell's thumbnail (`avatar.image`) was lost if its field wasn't a column
  (`toGridRow` only copied columns) and if jspreadsheet passed the row as text.

### 10.4 Tests

- `tests/grid/asistente.test.ts`: AI-8 (full screen at 1366 × 900, no legend inside and with a legend on
  the page's sheet, tabs, spinner and live progress in Estado and in the tabs, badge and tooltip
  of «Importar todo», «Ver en staging» highlights each file's row, import only Planes GMF with
  confirmation, the run stays `lista` and the chat says so, «Importar todo» closes); AI-9 (390 × 844:
  full screen, tabs, staging with its button, chat). AI-1, AI-4, AI-5 and AI-6 up to date.
- `tests/protocol/asistente.test.ts` S-5: import a single destination.
- `tests/assistant/agente.test.ts`: per-file progress of the basic agent and `describirStagings`.
- The example analyzes slowly (0.7 s per step) a file with «lento» in its name, to see the progress.

### 10.5 Pending

- Several destinations with staging: the UI and the server already handle them (one tab and one button per table;
  «Importar todo» saves them one after another), but the example has only one: a second example
  destination and its test are still missing.
- The changes panel still takes up almost half of the staging at 1366 px.

