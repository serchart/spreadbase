# 01 — SpreadBase design

> Living document. Decisions agreed with the project owner,
> numbered SB-1…
> Source reference: `open-collect-crm/docs/07-anexo-datagrid-engine.md`
> (engine, remote data, batch protocol; decisions G-1…G-17).

**Created:** 2026-09-27 · **Revised:** 2026-09-27 · **Status:** 🟢 current

---

## 1. What it is and why it exists

An npm library, installable **in the backend and in the frontend**, to work
with a database table as if it were a spreadsheet: thousands of rows, editing,
inserts and deletes, undo and redo, a draft that survives a reload, and batch
saving that detects collisions between users.

**The promise:** whoever implements it deals **only with the business domain**
of their solution —what columns their sheet has, what rules they follow, where
they are read from and how they are written—. Everything else is done by
SpreadBase underneath:

- a windowed view over remote data, loaded in ranges (never all rows in the browser);
- a local draft in IndexedDB and reconciliation on reload;
- undo and redo history, also outside the visible area;
- a changes panel, validation on edit and on save;
- batch saving with per-field concurrency, notices, conflicts and idempotency;
- **later**: real-time collaboration —users connected in their own sessions,
  editing different cells at the same time, presence, a Redis layer—.

### Origin

It was born as the internal DataGrid of OpenCollect CRM. What was called
"sandbox" there —the backend module, the frontend playground and their tests—
mixed three things, and only one of them was about debt collection:

| Piece in OpenCollect | What it really is | In SpreadBase |
|---|---|---|
| Paged window, `locate`, batch with per-field concurrency, `rowVersion`, notices, idempotency | Protocol and engine: **generic** | Library core |
| The array of 50,000 rows in memory | Storage | A **source** (memory for demos and tests; Postgres for production) |
| Case columns, stages, owners, seed, rules | **Domain** | The only thing written by whoever uses it |
| `GridController` + `SpreadsheetGrid` + panels + IndexedDB | The client, already almost reusable | `Sheet` + `<SpreadBase>` |

The hard work —history, draft, conflicts, reconciliation— was already
generic. What was missing was pulling the domain out and giving it a name. It
was decided to do it **outside OpenCollect from the start**, as a library with
its own tests, and to make OpenCollect its first consumer.

---

## 2. Decisions

| # | Decision | Status |
|---|---|---|
| **SB-1** | **One schema, one validation.** The sheet is defined once and the same rule validates in the front (on edit) and in the back (on save). The validation code lives in `core` and both sides use it. Where the definition is written: SB-12 | ✅ |
| **SB-2** | **A data source, not an embedded database.** SpreadBase does not own the connection: it talks to a small interface (§5.3). Memory now; Postgres later. The connection belongs to the app | ✅ |
| **SB-3** | **Writing belongs to the domain.** Reading through a view or a query; writing through the `insertMany`/`updateMany`/`deleteMany` of the app's service, with its rules. SpreadBase wraps them with versions, concurrency, idempotency and the response. It never runs a direct `UPDATE` on a domain table. Reason: in the real case (OpenCollect's portfolio) data is read from a view with aggregates and writing the stage goes through the cases service; "one table = one grid" does not work | ✅ |
| **SB-4** | **Concurrency requires nothing in the user's table** (revised 2026-09-28). `rowVersion` is an **opaque** token set by the source: `memorySource` uses a counter; `postgresSource`, a **fingerprint (hash) of the writable columns** computed on read, or a version column if the table already has one. Any write changes the fingerprint, whether it comes from the sheet, a worker or a script. No triggers, no mandatory `row_version`, no change table | ✅ |
| **SB-5** | **The batch protocol is kept:** `{ from, to }` per field, `notices`, `conflicts`, `Idempotency-Key`, partial success. It is already proven (source annex §11.13–§11.14). Only extension: `base` in each edit (SB-16) | ✅ |
| **SB-6** | **Svelte-only client, for now.** The controller uses runes. Svelte 5 is a `peerDependency`. If React is ever requested, it is split out | ✅ |
| **SB-7** | **Styles: Tailwind + daisyUI as `peerDependencies`.** The app declares `@source` pointing to the library's CSS and inherits its theme. jspreadsheet, jsuites and lucide are regular dependencies | ✅ |
| **SB-8** | **Real time: designed now, built later.** Every applied batch emits an event `{ sheet, id, fields, rowVersion }`. Later that event feeds presence, other users' cursors and Redis. Meanwhile, nothing in the design may close that door | ✅ |
| **SB-9** | **Private repo, MIT license when published.** npm scope `@spreadbase` reserved | ✅ |
| **SB-10** | **Three packages: `server`, `client` and `core`** (§3). Whoever uses the library installs `server` in the back and `client` in the front; `core` comes as a dependency of both, like `socket.io-parser` with `socket.io` and `socket.io-client` | ✅ |
| **SB-11** | **One server and one app for all the examples** (revised 2026-09-28). `examples/backend` has the common base and one folder per example in `src/examples/`, mounted under `/api/<name>`; `examples/frontend` has an index and one page per example. Examples: basic (didactic), Postgres (JS backend in the Aggy style), cases (50,000 rows in layers, `mutate`/`reset`, latency; the E2E tests run against it) and serverless. A new example is a folder, not a server | ✅ |
| **SB-12** | **The definition is written in the backend by default and travels to the front.** The backend is the authority: it validates what gets saved. It serves the schema at `GET <base>/schema`; the front connects with `new Sheet(url)` and only adds what is visual or exclusive to the client. **Without a server** (local data or another source), the definition is written in the front. There is no file shared between front and back. Details in §4.2 | ✅ |
| **SB-13** | **In the backend, SpreadBase is used piece by piece, one per layer** (`routes → controller → service`, as in Aggy and OpenCollect): the engine is an object of the service, `core` and `server` provide helpers for the controller and the routes. `sheetRouter(sheet, { context })` mounts the five protocol routes; it is optional and does not break the layers, because the engine stays in the service. Details in §4.1 | ✅ |
| **SB-14** | **Start from proven code, not from reimplementations.** The packages were extracted from the faithful copy of OpenCollect (verified with E2E and in the browser) and the cases example (`examples/backend/src/examples/cases`) is that copy on top of the packages. What was previously in `packages/` and `apps/demo` was removed | ✅ |
| **SB-15** | **Validate the design with a second, different consumer** before considering it good (e.g. OpenCollect's charges ledger or users). If it works for two domains, the abstraction is right; until then nothing is generalized in advance | ✅ |
| **SB-16** | **`merge` notices are computed by the server from what the client sends.** Each edit carries `base`: the values the client read in the writable columns it did **not** touch. A `base` field whose current value is already different was changed by another user → notice. Writable columns only: a system change in a read-only column (the ledger's DPD) is not "another user". The SB-4 fingerprint is computed over the same columns | ✅ |
| **SB-17** | **Same field, same value, is not a conflict.** If someone else left the field at exactly the value the client asks for, it is applied without asking; the same on save as on reload | ✅ |
| **SB-18** | **Idempotency inside SpreadBase.** The engine receives the `Idempotency-Key` and stores key and response with the source, **in the same transaction as the batch**: either everything is committed or nothing is. In memory, a map; with Postgres, the `spreadbase_idempotency` table, which **the library creates** (`CREATE TABLE IF NOT EXISTS`). It replaces the `idempotent()` middleware | ✅ |
| **SB-19** | **The transaction comes from the source.** If the source has `transaction`, the engine runs the batch inside it: it locks the rows (`lock`), compares, applies and stores the idempotent response. Handlers receive the transaction in `ctx.tx` and write with it. Whoever uses the library does not configure it. Without a transaction (memory), the engine applies batches one at a time. Details: `02-fuentes-transacciones-handlers.md` | ✅ |
| **SB-20** | **A domain error aborts the whole batch.** If a handler throws, the transaction is rolled back and nothing is written; the client keeps its changes. Handling it per row, like a conflict, is left for when a real case asks for it | ✅ |
| **SB-21** | **`lookup` column: pick a record from another resource, configured on the server** (2026-09-28). `value` (the id) is stored and `display` is shown. The popover is a mini HTML table with the sheet's theme —not another jspreadsheet—, with a fixed header (none if there is a single column) and **paginated from the start**. The column declares `search` (paginated), `byIds` (names for each page and validation on save) and `resolve` (optional, for pasting). Pasting resolves in three steps —memory of what was copied, known names, a single request with the unique texts— and is applied as a single history step. SpreadBase only requires the shape of the `lookup` object; having it defined by the module that owns the resource and making the sheet a function with its dependencies is the recommended organization, not a requirement. Details: `03-lookup.md` | ✅ |
| **SB-22** | **Password as a column type; the engine applies the hash** (2026-09-28). The `PASSWORD` column declares `hash(plain, ctx)` (mandatory: without it the engine does not start). The stored value never leaves: the engine replaces it with an opaque marker (`pwd:…`, per row) in every row it returns, whatever the source; per-field concurrency works on the marker. Handlers and source only see the hash. It cannot be filtered or sorted on. In the client, empty means "do not change it" and it is never stored in the local draft. `BOOLEAN` (checkbox) comes in together with it. Details: `04-tipos-de-columna.md` | ✅ |
| **SB-23** | **Client columns on top of the server schema** (2026-09-28). The server defines the sheet (SB-12), but what belongs to the screen —what to do on click, a width, a title— is decided in the client: `new Sheet(url, { columns, actions })`. `columns[field]` is a **patch** merged over the server column, or a **function** that receives it and returns the final one; the field is never renamed. A field that is not in the schema is a **client-only** column (`at: 'start' \| 'end'`), always read-only: there is nowhere to save it. `actions` is a **shortcut**: each action is an `action` column at the beginning (`__action_0`…), to which the `columns` settings are then applied like to any other. Underneath it is a single pure function, `applyColumnOverrides` | ✅ |
| **SB-24** | **A toolbar in three sections, extensible** (2026-09-28). From left to right: **editing** (undo, clipboard, rows, reload, discard; icon only, what does not fit moves to ⋮), **actions** (Save and the page's own buttons, with text; never hidden) and **panels** (Filters, Groups, Changes; at the far right). Custom buttons are passed in `toolbar={{ actions: [{ label, icon, onclick, variant, disabled }] }}`; `variant` is `outline` by default, because the primary action of the view is usually Save. Also, the invisible rows that the toolbar and `PanelButton` use to measure their buttons go inside a clipped box: left loose, they overflowed and gave a horizontal scroll to the page containing the sheet | ✅ |
| **SB-41** | **Multiple-choice column: `MULTISELECT`** (2026-11-13). The value is a list of `options` values, without duplicates and in the order of `options`; empty is `null` (like `FOLDER`; `[]` reads as empty). Cell with one chip per option and «+N»; checkbox editor with search and keyboard; copy and paste as «BYD, Honda» (same parsing on import, `parseMultiSelect`). Filters by value are «contains any of», the values list counts the rows containing each option, and a row falls into every group of its options. `postgresSource` stores JSON in `jsonb` (recommended) or `text` (`text[]` not yet); `mongoSource`, an array. No `allowOther` yet. `04-tipos-de-columna.md` §4 | ✅ |
| **SB-40** | 🟡 **PROPOSAL / PENDING — does not exist yet.** **Formula columns in JS** (2026-11-13). A read-only column whose value is a function `(row) => value` written by whoever builds the sheet, with a declared result type. Runs in isolated workers (`isolated-vm`, the `aggy_isolated_runtime` model), never inside the server and never as user SQL. Recommendation: **materialized** into a real column when the row is saved (filter, sort and index in Postgres), plus **scheduled recompute** for time-dependent formulas and a **full recompute** when the formula changes. Full design in §4.6 (in English) | 🟡 Proposal |
| **SB-39** | **Icons taken from the data and actions with the row's text** (2026-11-11). Five pieces that an app (Aggy OS) solved with its own patches: **(1)** `avatar.iconField`: the **name** of a `registerIcons` icon comes from a field, along the same path as `image` —in `text`, from the same row; in `lookup`, from the chosen record: the server sends it by id in `Page.icons` together with `labels` and `images`, and the search mini table and `Field` take it the same way—. It is called `iconField` and not `icon` because `icon` is already the column's **fixed** icon and changing its meaning would break whoever uses it; the suffix says the value is a field. Fallback: photo → record icon → initials → fixed icon → generic; empty or unknown falls back to the usual. It is drawn as an SVG with `currentColor` (follows the theme). **(2)** `Option.icon`: an icon before the label in the cell and in the list of a `select`. **(3)** The list does not show the value on the right if it equals the label. **(4)** The `labels`/`images`/`icons` of a range (and the `labels` of `/values`) are stored by the controller in a single place (`rememberLabels`), so a hand-written `RemoteDataSource` delivers them just like `Sheet(url)`; before, only `Sheet` read them and the search of a `lookup` opened filtered by the id. **(5)** `ColumnAction.label` accepts `(row) => string` («#1042»); it is repainted when the row is edited. Example `/stages`; §4.4; tests IC-1…IC-11, `avatar.test.ts`, `remoteLabels.test.ts` and `protocol/api.read` | ✅ |
| **SB-38** | **Files as a cell value: `FILE` with `FileRef` and `FOLDER`; long text** (2026-10-09). The canonical value of a file is `{ url, name, type, size }` (`FileRef`, core). The legacy Spanish shape `{ url, nombre, tipo, tamano }` is still read (deprecated; removed in the next major). A bare URL (SB-30) is still valid and is shown by its name. `FOLDER` is a list of `FileRef`. They validate an `http(s)` URL/path and a name; `CellValue` accepts them and `sameValue` compares them as JSON with sorted keys (no false conflicts). Uploading in a `file` cell leaves the `FileRef` (clean name, real type and size from `POST /upload/:field`); in `folder`, «Subir» ("Upload") adds several, ✕ removes, ↗ opens or downloads. `postgresSource` stores them as JSON in `jsonb` or `text` and reads them as an object; `mongoSource`, as a subdocument or a list. A folder cannot be filtered. `text` with `multiline: true` is shown with its type (MD/JSON) and its first line and is edited in a large viewer with «Formatear JSON» ("Format JSON"). In the assistant (SB-36 §8), an `adjuntar` destination with `columna` puts the file in that column of the row it matches by name (or by `destino.fila`). `04-tipos-de-columna.md` §3 | ✅ |
| **SB-37** | **Reserved** (2026-10-08): the agent engine and the dedicated server live outside this repo, in a private project. The library does not depend on them. | — |
| **SB-34** | **Importing through a format** (2026-09-30). A **format** (`importFormat`, server) declares columns like a sheet —same types and rules, `lookup` included— with no table behind it, plus `aliases` (other headers it may come with: «Razón Social» = «Nombre fiscal», both meaning "legal name") and **where each piece of data comes from**: `from: 'file'` (a column of the file), `'form'` (one value for all rows, asked once) or `'either'` (from the file if it has the column; otherwise, from the form). Also its `key` (create or update; not repeated within a file), the header that identifies it and the footer with the **checksum**. The app only writes `review` (what it would do) and `apply` (do it); SpreadBase validates beforehand, in both, what a sheet validates. `importRoutes([...])` mounts the list, schema, preview lookups, `review` and `apply` (JSON body: `{ rows, fields, fileName, checksum, force }`). In the client, **`<SheetImport url>`**: on the left the format and **only the data the file does not have**, what was read and what the server said; on the right the **preview**, a local sheet where an Excel or CSV file is dropped (it is read in the browser; `exceljs` is loaded on use), pasted from a spreadsheet or typed, and corrected. The table is found automatically (`locateTable`, core: header wherever it is, by label or alias without accents, extra columns are ignored) and each value is interpreted with the type of its column, as when pasting (Excel dates are UTC days). **Review** marks in the cell what the server found (`GridController.setExternalErrors`; correcting the cell removes the mark) and editing asks for a new review; what the app blocks and can be forced (the guardrail of a cutoff) is applied with confirmation. A workbook with several sheets (instructions first) is read from the sheet where the most format columns are recognized; a column the file does not have takes its default value. `lookup` columns can resolve by other fields besides the name (`resolveBy`: the key «YADI» → Yadira), also when pasting into a sheet. `ImportState` is the state without UI. Example `/imports` (contacts into the basic sheet); tests IMP-A1…IMP-A8 and IMP-1…IMP-4 | ✅ |
| **SB-35** | **Huge tables in Postgres** (2026-10-03). With 10 million rows, `count(*)` on each page took half a second and an `OFFSET` of 5 million, six (measured in the Aggy demo). `postgresSource` now **estimates** the total with the planner (`EXPLAIN`) when it goes over `exactCountUpTo` (100,000; below that it counts exactly, as before; `count: 'exact' \| 'auto' \| 'estimate'`), and on reaching the end it corrects it with what is seen (an incomplete page is the end). Deep jumps (`offset` ≥ `deferredJoinFrom`, 2,000) use a **deferred join**: first the ids of the page, scanning only the index, and then their rows (6.2 s → 0.3–0.6 s at the middle of 10 M). No changes in the client or in the protocol. Tests in `tests/postgres/source.test.ts` ("large tables") | ✅ |
| **SB-36** | **Import assistant with an agent** (2026-10-08; v2 2026-10-09). Extends SB-34: a wizard (`<ImportAssistant>`) where files or folders of any type are dropped (PDF, photos, zip, Excel, text); a table of files (icon, name, type, folder, analysis, destination) that the user corrects; a chat with the agent; and per-file results with details of the rows in error. The **importer agent** (`importAgent`, server) is a configurable artifact —model, prompt, context, destinations, tools— that turns each file into rows of an **SB-34 format** and reuses `review` (the tests) and `apply` (upsert or replace); other destinations: attach the file to a row or discard it. Deterministic extraction (pdfjs, exceljs) and LLM extraction over the same pages, cross-checked cell by cell. Same principle as SB-2: **the LLM, the storage, the run persistence and the queue belong to the app** (`ImportLLM`, `FileStorage`, `ImportRunStore`, `ImportRunner`; in memory and in process by default); the run is stored and processed in the background. Includes `mongoSource`. First consumer: Aggy Legacy (spec `CHEV7H` of the CHEV7 group in `aggy_node_backend`) v2 redesign with staging over the destination sheet, tabs per destination and a pluggable brain: `05-asistente-importacion.md` §7–§10 | ✅ |
| **SB-33** | **Sort and filter from the header, like Excel** (2026-09-30). Every column the server can filter has a ⌄ menu in its header: **sort** (ascending or descending), **filter by condition** depending on the type —text: equals, does not equal, contains, does not contain, starts with, ends with; number and date: `=`, `≠`, `>`, `>=`, `<`, `<=`, between; all: empty, not empty— and **filter by values** (list with checkboxes, a search box and the count of each value, as in Excel: with the other filters applied). One per column; across columns, AND. They travel in `?where=[{ field, op, value, value2, values }]` (JSON) and `?sort=`; fixed filters (SB-28) stay separate and are added. There is a single rule, `matchesFilter` in core: the memory source uses it as is and `postgresSource` translates it to SQL with the same result (text without accents or case, `%` and `_` literal, "does not equal" and "does not contain" include empty cells, date-time is compared by day, empty text = empty). `GET /values/:field` gives the distinct values (up to 1,000, with `truncated`; in a `lookup`, with names). The engine rejects (400) an operator that does not apply to the type or has no value; passwords never. In the client: `Sheet(url, { sort })` sets the initial order; the person's query is remembered in the tab (`sessionStorage`); the **Filters** panel states them in words and removes them; the toolbar counts the active ones. Filtering reloads from the start without losing pending changes (G-9). Only with a server: a local sheet does not offer the menu. Along with it, `hidden: true` also on the **server** column: the row carries it and can be filtered by it (`filters: { contract_id }`), but it is not painted; the client shows it with `hidden: false`. Tests: `tests/postgres/filtros.test.ts` (memory and Postgres against the same rule) and FC-1…FC-5 in the browser | ✅ |
| **SB-32** | **A record as a savable form: the record form ("ficha")** (2026-09-30). `new RecordForm(sheet, id, { fields?, exclude?, columns? })` reads the record through the list filtered by id (it brings the names and photos of its `lookup` columns) and builds a `FormState` with the **editable** columns of the sheet: the same editors and rules (`Field`). `save()` is a sheet batch with only what changed, the version read and `base`: the same concurrency as the sheet (same field → `conflict`, with `reload()` or `overwrite()`; another field → merged). Server errors for a field appear on that field (`FormState.setServerError`); the rest, in `saveError`. `dirty`, `reset()`, `savedCount`. `Sheet.client()` gives the sheet's HTTP client to pieces outside the grid. §4.3; example `/ficha`; tests FR-1…FR-5 | ✅ |
| **SB-31** | **Sheet settings for filtered views and dialogs** (2026-09-30). `columns: { field: { hidden: true } }` removes a column from the view (the one the context already states: the customer, in that customer's record form). **Fixed filters** (SB-28) are now also values of new rows (`GridConfig.fixedValues`): a row inserted in the filtered sheet is born inside the filter even if its column is hidden. `actions: [{ …, variant: 'primary' }]`: the per-row button with the accent color, like the page's primary action. Cell editors are mounted inside an open `<dialog>`: `Field` works inside a modal window. Tests AC-7, AC-8 and `columns.test.ts` | ✅ |
| **SB-30** | **File uploads; file column** (2026-09-30). `upload: { storage, maxSize?, accept?, allow? }` on `image` columns and the new `FILE` type. The destination is configurable: `diskStorage({ dir, publicUrl })` (a server folder) or a custom one with `save(file, ctx) → url` (a bucket). `POST /upload/:field` (in `sheetRouter`, or `sheetUpload(sheet)` alongside hand-written routes) receives the bytes as they are and returns the URL; the cell stores it with the batch, like any change. The **value is still text** (the URL): the file is stored at `<random folder>/<clean name>` and the cell shows the name, which is the end of the URL. Engine security: real type by content, maximum size, random name, SVG and HTML never; `serve()` with `nosniff`, CSP and download for what is not an image, PDF or text. §4.5; tests UP-1…UP-7 and AR-1…AR-5 | ✅ |
| **SB-29** | **Thumbnail before the text: photo, initials or icon** (2026-09-29). Option `avatar: { image?, initials?, icon?, shape? }` on `text` and `lookup` columns. Fallback order: the photo; if there is none or the link does not load, the initials (if `initials`); otherwise, the icon; otherwise, a generic one (a person if round, a building if square). In a `lookup` the photo is the chosen record's: the server sends it by id in `Page.images` together with `labels`; in text, from another field of the same row. Initials without corporate forms or articles («Transportes del Norte SA de CV» → «TN») and with a stable color per text (8 theme tones). Lucide icons by name, extensible with `registerIcons`. It is presentation: the value, what is copied, searched and saved is still the text or the id; no HTML from the data. §4.4; tests AV-1…AV-7 | ✅ |
| **SB-28** | **Fixed filters for a sheet** (2026-09-29): `new Sheet(url, { filters: { customer_id: id } })` sends those filters on every read of rows and position, like the protocol's per-column filters. It shows a part of the resource —a customer's account statement— with the same server sheet. The local draft belongs to that part (its id includes the filters). It is a view, not a permission. Example `/basic?status=inactive`; test AC-7. With it, `FormState.set(field, value, label)` for a `lookup` that arrives already chosen | ✅ |
| **SB-27** | **Writing to the sheet from outside** (2026-09-29): `grid.commands.setValues([{ rowKey, field, value }])`, for the toolbar's custom buttons (SB-24) and for pages that distribute, clear or fill in values. It goes through the same path as typing: the type interprets the value, it is validated, it stays as a pending change and **a single ⌘Z** undoes it; with the sheet mounted, it repaints it (before, `setCellValueByKey` changed the data but the cell kept showing the old value). Example: «Límite en cero» ("Limit to zero") in `/basic`; test AC-6 | ✅ |
| **SB-26** | **Contract kit** (2026-09-29): package `@spreadbase/testing` with `sheetContract()`, which an app runs against each of its sheets: five cases over HTTP (same field, another field, deleting what was edited, idempotent retry, external write) that prove its connection to the engine preserves concurrency. The full suite still belongs to SpreadBase; the app does not repeat it. §7.1 | ✅ |
| **SB-25** | **Forms with the sheet's columns and editors** (2026-09-29). `Field` and `FormState` are exported like `Toolbar`: a form reads the columns from a sheet's schema (or from its own list), and each field uses the complete cell type —`parse`, `format`, `validate` and the **same editor**, anchored to the field, which acts as host the way jspreadsheet does—. That way a date or a record is picked and validated the same in the sheet and in a new-record form. Per-column settings only in the form with `columns` (e.g. `readOnly: false` to capture at creation what the sheet no longer lets you change). §4.3 | ✅ |

---

## 3. Packages

| Package | Installed by | Contains | Extracted from (OpenCollect) |
|---|---|---|---|
| **`@spreadbase/server`** | The backend | `SpreadBase` (engine: read, position, batch with the per-field rule, `merge`/`strict`, idempotency, events); sources (`memorySource`, `postgresSource`, `mongoSource`); file extraction and importer agent (SB-36: `extraerDeterminista`, `extraerConLLM`, `compararExtracciones`, `importAgent`, `importAssistantRoutes`); HTTP helpers (`parseListQuery`, `parseBatch`, typed errors, `sheetRouter()`) | `backend/src/modules/sandbox/sandbox.service.ts` without the cases data; `common/idempotency.ts`, `common/errors.ts` |
| **`@spreadbase/client`** | The frontend | `Sheet` (the controller: window, changes, history, draft, conflicts, saving); `<SpreadBase>` (the sheet, toolbar, panels); HTTP client for the protocol; CSS | `frontend/src/lib/components/datagrid/` in full; `lib/api/sandbox.ts` generalized to any URL |
| **`@spreadbase/core`** | Nobody by hand | Column and schema types, value normalization and validation, protocol types (batch, conflict, notice, page) | `sandbox.types.ts`; the validation part of `cellTypes.ts` and of `validateBatch` |

The packages are distributed as **TypeScript without a build** while they are
private: the `exports` point to `src/index.ts` (`tsx` in the back, Vite in the
front). To be revisited when publishing.

---

## 4. How it is used

### 4.1 Backend: in layers (SB-13)

Example with OpenCollect's portfolio. Each piece goes in the layer where the
rest of the module already lives.

**Service**: the engine is an object of the service; writing is done by the
service's own domain methods.

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
		source: postgresSource({ pool, view: 'v_portfolio' }),                       // reading
		handlers: { updateMany: (changes, ctx) => this.updateMany(changes, ctx) },  // writing (SB-3)
		policy: 'merge'
	});

	async updateMany(changes, ctx) {
		/* business rules for cases */
	}
}
```

**Controller**: helpers to read the request; the rest (user, logs, format)
belongs to the app.

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
			idempotencyKey: req.get('Idempotency-Key'),   // SB-18: the engine handles idempotency
			context: { user: req.user }                    // reaches the handlers
		});
		if (replayed) res.set('Idempotent-Replayed', 'true');
		res.json(result);
	};
}
```

**Routes**: the app's own, with its middlewares.

```ts
// cases.routes.ts
router.get('/portfolio/schema', c.schema);
router.get('/portfolio', c.list);
router.get('/portfolio/:id/position', c.position);
router.get('/portfolio/:id', c.get);
router.post('/portfolio/batch', c.batch);
```

**Shortcut: `sheetRouter()`.** It returns a `Router` with the five protocol
routes already wired: it is exactly the controller and routes above, already
written, and it guarantees they match what `new Sheet(url)` expects. It only
skips the controller layer; the engine stays in the service.

```ts
// quickstart: "that easy"
app.use('/api/contacts', sheetRouter(new SpreadBase({ id: 'contacts', columns, source: memorySource(rows) })));

// real module: behind authentication, passing the user to the batch
router.use('/portfolio', authenticate, sheetRouter(casesService.portfolio, {
	context: (req) => ({ user: req.user })
}));
```

| Situation | What to use |
|---|---|
| Quickstart, basic example, internal tools | `sheetRouter()` |
| Module with authentication common to all its routes | `sheetRouter()` behind the middleware, with `context` |
| Something different per route: permissions to read and to save, custom logs, extra routes | Hand-written controller and routes |

Rules for the pieces to fit together:

- **The routes are the contract with the client.** The base is free
  (`/api/cases/portfolio`), but under it there must be `/schema`, `/`,
  `/:id`, `/:id/position` and `/batch`: that is what `new Sheet(base)` calls.
- **Errors:** the engine throws typed errors with `status`, `code` and
  `details`. The response shape is `{ error: { code, message, details? } }`,
  the same one OpenCollect uses, so its handler serves them without translation.
- **`handlers` is optional:** if not given, the source itself writes
  (`memorySource` does). With Postgres and a real domain, they are always given (SB-3).

### 4.2 Frontend (SB-12)

**Normal use, against a server:** the front does not repeat the definition; it asks for it.

```svelte
<script lang="ts">
	import { Sheet, SpreadBase } from '@spreadbase/client';
	const sheet = new Sheet('/api/cases/portfolio');
</script>

<SpreadBase {sheet} fill />
```

**What `sheet` holds:** the received schema (`sheet.schema`) and, once it has
it, the sheet's controller (`sheet.grid`): the window of loaded rows, the
pending changes, the history, the draft in IndexedDB, the conflicts and the
save state. The component only draws it. Having it outside the component is
what makes it possible to listen to it (`sheet.grid?.rowSummary`,
`sheet.grid?.hasPendingChanges`), save from another button
(`sheet.grid?.commands.save()`) or mount a custom toolbar (`<Toolbar>`).

Creating a `Sheet` makes no requests: `<SpreadBase>` calls `sheet.connect()`
when it mounts. So it can be created in the `<script>` of a page with SSR. If
it fails, `sheet.error` says why and the component offers to retry.

**What only exists in the client** is added when creating it: widths, the
search of a `remote-select`, custom editors.

```ts
new Sheet('/api/cases/portfolio', {
	columns: { customer_name: { width: 260 }, customer_id: { search: searchCustomers } }
});
```

**Without a server** (local source; the «Sin servidor» ("Serverless") page of
the examples): the definition is written in the front.

```ts
new Sheet({ id: 'charges', columns, dataSource: { load: loadCharges, save: saveCharges } });
```

**Validation limit:** declarative rules travel with the schema and the front
applies them just like the back while editing (required, minimum and maximum,
length, options, pattern). A rule written as a **function** in the backend
("paid ≤ amount") does not travel over HTTP: its error appears on save, unless
the dev repeats it in the `Sheet`.

### 4.3 Forms with the sheet's columns (SB-25)

A creation wizard, a filter, a dialog: things that are not a sheet but pick
the same things. `Field` and `FormState` are used outside the sheet just like
`Toolbar`: they are imported and placed wherever needed.

```svelte
<script lang="ts">
	import { Field, FormState, Sheet } from '@spreadbase/client';

	// The columns come from the sheet's schema, with their searches wired up.
	const form = new FormState(new Sheet('/api/contracts/sheet'), {
		customer_id: null, start_date: null, payment_frequency: 'monthly'
	}, {
		// Settings only here: the customer is read-only in the sheet, not on creation.
		columns: { customer_id: { readOnly: false, required: true } }
	});
</script>

<Field {form} name="customer_id" />   <!-- the cell's mini table -->
<Field {form} name="start_date" />    <!-- the cell's calendar -->
<button onclick={() => (form.touchAll(), form.valid && next())}>Siguiente</button>
```

- **The form's fields** are the keys of the second argument; the sheet may
  have more columns. It also accepts a list of `ColumnDef` written in the
  client, without a server.
- **The control is the cell's.** For types with their own editor (date,
  date-time, list, `lookup`, image, password) `Field` opens that same editor
  anchored to the field: the field acts as host, like jspreadsheet in the
  sheet (`closeEditor(cell, save)`), so there is no second version of the
  calendar or of the mini table. Text and number are an `input` interpreted
  with the type's `parse`; the checkbox, a `checkbox`.
- **The rules are the type's** (`validate`): required, pattern, range,
  «no corresponde a ningún registro» ("does not match any record"). The error
  appears on leaving the field or with `form.touchAll()`; `form.valid` gathers
  them. The server is still the authority on save.
- Styled with daisyUI (`fieldset`, `input`, `label`), like the other components.
- A `lookup` with `avatar` shows the photo, initials or icon of the chosen
  record in the field, like the cell (SB-29, SB-39). `form.set(field, id, name, photo, icon)` for one
  that arrives already chosen.

Example: `/form` (creating a product on the Postgres sheet).

**A record's form (SB-32).** To edit one that already exists, with the
sheet's concurrency:

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

Example: `/ficha?id=c_00001` (a contact from the basic sheet).

### 4.4 Thumbnails in cells (SB-29)

A person is recognized by their photo, a company by its initials. The column
declares it on the server, in the same sheet:

```ts
// The chosen advisor's photo (lookup); without a photo or with a broken one, their initials.
assigned_user_id: { type: types.LOOKUP, label: 'Asesor', lookup: users, avatar: { image: 'avatar_url', initials: true } },
// The company's initials, square and with its color: «TN».
name: { type: types.TEXT, label: 'Cliente', avatar: { initials: true, shape: 'square' } },
// Icon only.
issuer: { type: types.TEXT, label: 'Emisora', avatar: { icon: 'landmark', shape: 'square' } },
// One icon per row, that of the chosen stage (SB-39): `stages.icon_name` = 'hourglass', 'calendar-check'…
stage: { type: types.LOOKUP, label: 'Etapa', lookup: stages, avatar: { iconField: 'icon_name', initials: true, shape: 'square' } },
```

| Option | What it does |
|---|---|
| `image` | Field with the URL. In `lookup`, from the chosen record (the server sends it in `Page.images`; the popover takes it from the chosen row). In `text`, from the same row. Only `http(s)://`, `/…` or `data:image/`. |
| `initials` | Up to two initials, without `SA`, `CV`, `SAPI`, `de`, `del`… Stable color per text (`--dg-avatar-1…8`). |
| `iconField` | Field with the **name** of an icon (SB-39), from the same place as `image`: in `lookup`, from the chosen record (in `Page.icons`); in `text`, from the same row. Empty or unknown: whatever comes next in the fallback. |
| `icon` | Name of an icon, the same for the whole column: `user`, `user-round`, `users`, `building`, `store`, `truck`, `bot`, `landmark`, `mail`, `phone`, `file-text`. More with `registerIcons({ tractor: Tractor })` in the client. |
| `shape` | `round` (default, people) or `square` (companies). |

- **Fallback:** photo → record icon (`iconField`) → initials → fixed icon →
  generic (person or building). Icons are SVG with `currentColor`: they
  follow the light or dark theme.
- **Also in `select`** (SB-39): `options: [{ value: 'high', label: 'Alta', icon: 'arrow-up' }]`
  paints the icon before the label, in the cell and in the list. The list
  shows the value on the right only if it differs from the label (a code).
- **Actions with the row's text** (SB-39): ``actions: [{ label: (row) => `#${row.folio}`, icon: FileText, onclick }]``.
- **Where it goes:** in the sheets that **pick** the record (a `lookup`: a
  customer's advisor, a contract's customer), next to the name. In the sheet
  that **owns** the image (Users, Customers), the image goes in its own
  `image` column, to the left of the name, and is changed there; the name does
  not repeat it.
- **Presentation only.** The initials go in an attribute painted with CSS: the
  cell's text, what is copied, the search and what is saved do not change.
- **Editing:** text with a thumbnail is edited inside the cell, like the
  native one (Enter confirms, Esc discards). In `Field` it is still an `input`.
- **Theme:** `--dg-avatar-size`, `--dg-avatar-fg`, `--dg-avatar-icon-bg/fg` and
  `--dg-avatar-1…8`; `theme-daisyui.css` mixes them with the theme colors.

Examples: «Cliente» in `/cases` (initials), «Responsable» in `/postgres` (photo)
and «Etapa» in `/stages` (icon of the chosen stage, also with a hand-written
remote source).

### 4.5 Uploaded files and images (SB-30)

The destination is declared once; the column uses it with `upload`:

```ts
import { diskStorage, types } from '@spreadbase/server';

// A server folder. Tomorrow, a bucket with the same `save(file, ctx) → url`.
const docs = diskStorage({ dir: './uploads/docs', publicUrl: 'https://api.midominio.mx/uploads/docs' });

columns: {
	logo_url: { type: types.IMAGE, label: 'Logo', upload: { storage: logos, maxSize: '2mb' } },
	contract_file: {
		type: types.FILE,
		label: 'Contrato firmado',
		upload: { storage: docs, maxSize: '10mb', accept: ['application/pdf'], allow: (ctx) => ctx.user?.role !== 'read_only' }
	}
}

// Serve what was stored; private documents, behind the app's session.
app.use('/uploads/docs', requireAuth, docs.serve());
```

- **Route:** `sheetRouter` already includes `POST /upload/:field`. With
  hand-written routes, `router.use(sheetUpload(sheet))`. **Without the route
  mounted, the schema does not announce `upload`** and the client does not show
  «Subir» ("Upload"): never a button that ends in a 404.
- **File cell:** an icon per type, the name and ↗ to open it. Copying gives
  the URL (pasting it in another row is the same file).
- **Editor** (image and file, also in `Field`): paste a URL, **Subir**
  ("Upload"), drag or paste the file. On upload, the URL stays in the cell,
  edited, and is saved with **Guardar** ("Save"); undo, draft and conflicts do
  not change.
- **The value is the URL.** The file is stored as
  `<random folder>/<clean name>`: nobody can guess someone else's path, two
  identical names do not collide and the cell shows the name without storing
  it separately.
- **Security (the engine's, not each app's):** the real type is checked by
  content (an HTML file renamed to `.png` does not pass and a PNG named `.pdf`
  is stored as `.png`); maximum size enforced while reading; SVG and HTML
  never; `allow(ctx)` for permissions. `serve()` sets `nosniff`, a CSP without
  scripts and downloads what is not an image, PDF or text.
- **Default types:** `image`, PNG, JPEG, WebP and GIF; `file`, also PDF and
  XML. CSV, text, zip and Office types are also recognized.
- **Pending:** several files per cell and deleting the ones nobody uses (a
  file is uploaded and then the change is discarded).

Examples: «Contrato» in `/cases`, «Foto» in `/postgres` and in `/form`.

---

### 4.6 Formula columns (SB-40) — 🟡 PROPOSAL / PENDING

> **Nothing in this section is implemented.** It is the proposal to decide on;
> once approved it becomes current design and tasks. Written in English (code
> and concepts in English; user-facing labels may stay in Spanish).

**The idea.** A column whose value is not captured but computed by a JS
function of the row, instead of an Excel formula or a SQL view.

```js
// Car catalog: "Price with VAT" and "Days in inventory"
price_with_vat: {
	type: types.NUMBER,                 // declared result type
	label: 'Precio con IVA',            // user-facing text may be Spanish
	formula: '(row) => row.price * 1.16'
},
days_in_stock: {
	type: types.NUMBER,
	label: 'Días en inventario',
	formula: '(row, { today }) => row.received_at ? daysBetween(row.received_at, today) : null',
	recompute: 'daily'                  // depends on the date: recomputed every day
}
```

#### How it is written

- **Signature:** `(row, ctx) => value`, an arrow function as text. `row` holds
  the row's **canonical values** (the same ones the protocol carries: numbers
  as numbers, dates as `YYYY-MM-DD`, files and folders as objects/lists, a
  `lookup` as its id). `ctx` holds `today` (the computation date, fixed for the
  whole run) and a few pure helpers (`daysBetween`, `round`, `sum`…). No
  `fetch`, no `require`, no clock of its own (`Date.now()` does not exist; the
  date is `ctx.today`, so results are reproducible).
- **Result:** of the declared type (`NUMBER`, `TEXT`, `DATE`, `BOOLEAN`…). It
  is validated with the same `validateValue` from `core` as a captured cell; if
  it does not fit (text in a numeric column) the cell is in error (below).
- **Always `readOnly`.** Not editable in the sheet, in `Field` or in the
  record form; never part of the batch nor of the concurrency fingerprint
  (SB-4).
- **Other tables only through a declared `lookup`.** `row.customer` is the id;
  to read fields of the chosen record the formula declares what it needs:
  `uses: { customer: ['name', 'kind'] }`, and receives `row.$customer.name`.
  The server loads those fields **before** sending the batch to the worker (one
  query per batch, not per row). A formula never queries on its own: that is
  how dependencies are known (for recompute) and there is no N+1 and no free
  database access.
- **Formulas over formulas** are allowed within the same row
  (`row.price_with_vat` in another formula). Order comes from dependencies.

#### Where it runs

- **Isolated workers**, like the `agents`/`hooks`/`reports` lanes of
  `aggy_isolated_runtime`: a `formulas` lane claiming jobs from a Postgres
  queue. Each job is **a batch of rows** (e.g. 500) and **one formula compiled
  once** in an Isolate reused for the whole batch; data goes in copied and a
  list of values comes out.
- **Limits:** Isolate memory (e.g. 32 MB), time **per row** (e.g. 50 ms) and
  per batch (e.g. 5 s). A row over the limit gets a `timeout` error; the rest
  of the batch continues.
- **Reasonable throughput:** a pure arrow function over copied data runs in
  microseconds; the real cost is copying data and writing results. Target:
  **≥ 5,000 cells/s per worker** (the bottleneck is the batched `UPDATE`, not
  the JS), scaled horizontally: several workers claim different batches
  (`FOR UPDATE SKIP LOCKED`). Recomputing 1 million rows with 4 workers: about
  a minute.
- **Who writes it and who runs it.** SpreadBase defines the contract —the
  `formula` declaration, the type, `uses`, `recompute`— and a small interface,
  `formulaRunner`, that the host app plugs in (like `storage` in SB-30 or the
  agent in SB-36). In Aggy: **the Studio** edits the formula (with a preview
  over a few rows) and **aggy_isolated_runtime** runs it. For tests and
  examples, an in-process local runner (no isolation; development only).

#### When it runs and how it is queried (the central point)

| Mode | How | Filter / sort over the whole table | Cost |
|---|---|---|---|
| **Materialized on save** | After a batch touches a row, its recompute is queued; the worker writes the result into a **real column** of the table | ✅ It is a Postgres column: `where`, `sort`, value counts (SB-33), indexes | One extra write per saved row; the value takes a moment to appear |
| **On read** | Computed only for the rows of the page being sent | ❌ No: filtering would require computing the whole table on every query | Nothing on disk; every page pays the computation |
| **Scheduled recompute** | A job (e.g. daily at 00:05) queues every row of the formulas with `recompute: 'daily'` | ✅ (over the materialized column) | One pass per day |

**Recommendation: always materialized**, plus **scheduled recompute** for
date-dependent formulas (`recompute: 'daily'`), plus a **full recompute** when
a formula is created or changed. "On read" is ruled out as the main mode: a
SpreadBase sheet lives on filtering and sorting over millions of rows (SB-33,
SB-35), and that only works if the value is in the database.

Details:

- **While computing:** the saved row comes back with the old value and a
  `pending` mark on the cell (grey, "calculando…"); the result arrives through
  the events channel (SB-8) or on reload. Saving never waits for the worker.
- **Where it is stored:** a regular column of the table, declared by the app in
  its migration (`price_with_vat numeric`) or created by SpreadBase if the
  source allows it. Only the worker writes it (the batch ignores it because it
  is `readOnly`).
- **Values coming from a `lookup`:** if the record in the other table changes,
  the rows pointing at it are queued (known from `uses`). Until then the value
  may lag slightly; this is accepted and documented.

#### Dependencies, errors and versions

- **Dependencies and cycles.** Each formula's inputs are known (the `row`
  fields it reads, by static analysis of its text, plus `uses`). That builds a
  graph per sheet; a **cycle** (`a` uses `b`, `b` uses `a`) is rejected **when
  the formula is declared**, with a message naming the cycle. The worker
  computes in topological order within each row.
- **Errors.** An exception, a result of the wrong type or a `timeout` leave
  `NULL` in the column and store the error separately (`{ field, error }` in a
  per-row formula-errors table). The cell shows it like an invalid cell today
  (red, with the message on hover: "Error en la fórmula: row.price is
  undefined"). Filtering "with error" is possible.
- **Versioning.** Each formula stores a `hash` of its text. When it changes, a
  **full-table recompute** with the new version is queued; meanwhile the sheet
  shows a notice ("Recalculando Precio con IVA: 40 %"). Each value records the
  version it was computed with, so an old result never overwrites a new one.
- **Security.** Never user SQL: the formula is JS in an Isolate with no
  network, no file system and no database access. The only input is the row's
  data (and that of `uses`); the only output is one value per row, validated
  before being written. Editing formulas is a permission separate from editing
  data.

#### The bridge with what exists today (Aggy, Grupo Tec POC)

Today in Aggy, computed columns are **Postgres views**: a closed catalog of
computations plus a POC `formula` limited to an arithmetic subset (`row.x`,
numbers, `+ - * / %`, parentheses and `Math.round/max/min`) that is
**translated to SQL** in the view:

```js
{ name: 'dias', type: 'computed', compute: 'days_since', from: 'fecha_ingreso' }
{ name: 'num_fotos', type: 'computed', compute: 'count', from: 'fotos' }
{ name: 'total', type: 'computed', formula: '(row) => row.precio * row.cantidad' } // POC: arithmetic subset translated to SQL
```

The sheet reads from the view and writes to the table
(`postgresSource({ table, view })`), and the column reaches the client as a
`readOnly` column of the result type.

The move to SB-40 changes **only where the value comes from**, never the
declaration the sheet sees:

| Today (SQL view) | Tomorrow (runtime formula) |
|---|---|
| `compute: 'days_since', from: 'fecha_ingreso'` | `formula: '(row, { today }) => row.fecha_ingreso ? daysBetween(row.fecha_ingreso, today) : null'`, `recompute: 'daily'` |
| `compute: 'count', from: 'fotos'` | `formula: '(row) => row.fotos?.length ?? 0'` |
| `formula: '(row) => row.precio * row.cantidad'` (translated to SQL) | The same text, run in the runtime |

- Each `compute` of the catalog is a **predefined formula**: Aggy can expand
  `{ compute, from }` into its equivalent text, and the Studio can show it
  already written so it can be edited.
- A `formula` that fits the arithmetic subset can **keep being translated to
  SQL** (cheap, always up to date, filterable on the view); one that does not
  fit goes to the runtime and is materialized. The author writes the same
  thing in both cases; the engine picks the path.
- The column keeps its **name, type, label and `readOnly`**; its filters
  (SB-33), the form (`Field`, SB-25) and the record form keep seeing it the
  same way.
- Per-column migration: (1) add the real column to the table, (2) run the full
  recompute, (3) drop the expression from the view (the view stays if it joins
  other things, or `view` stops being used). One column at a time.

#### Still to decide

1. The option names (`formula`, `recompute`) and whether `recompute` accepts
   more than `'daily'` (`'hourly'`, cron).
2. Whether SpreadBase creates the real column or the app always declares it
   (`postgresSource` could; other sources cannot).
3. The initial set of `ctx` helpers (dates, rounding, text).
4. Whether the Studio preview runs in the same isolated runtime (recommended)
   or in the browser.

---

## 5. Protocol

### 5.1 Routes under the sheet's base

| Method | Route | Response |
|---|---|---|
| `GET` | `/schema` | Columns (type, declarative rules, visual hints), `idField`, `allowInsert`, `allowDelete`, `policy` |
| `GET` | `/?offset&limit&sort=field:asc\|desc&search=&where=[…]&<field>=a,b` | `{ rows, total, offset, limit, version }`. Order **always with an id tiebreaker**. `limit` ≤ 500. `where`: per-column filters in JSON (SB-33) |
| `GET` | `/values/:field?where=[…]&<field>=a,b` | `{ values: [{ value, count }], truncated, labels? }`: distinct values of the column in the query, empty ones first (SB-33) |
| `GET` | `/:id` | One row, with `rowVersion` |
| `GET` | `/:id/position?…` | `{ id, position, total }` within the same query; `position: null` if the query excludes it |
| `POST` | `/batch` | Save batch (§5.2). Accepts `Idempotency-Key` |
| `GET` | `/lookup/:field?q&offset&limit` | Rows of the resource of a `lookup` column, paginated: `{ rows, total, offset, limit }` (SB-21) |
| `POST` | `/lookup/:field/resolve` | `{ texts }` → `{ matches }`: pasted text → matching rows (SB-21) |
| `GET` | `<imports>/`, `/:format/schema` | Import formats and their schema: columns with `aliases` and `from`, `key`, `header`, `footer` (SB-34) |
| `POST` | `<imports>/:format/review`, `/:format/apply` | `{ rows, fields, fileName?, checksum?, force? }` → `{ ok, applied, summary, issues: [{ row, field, level, message }], blocked }` (SB-34) |
| `POST` | `/upload/:field` | File bytes (name in `X-File-Name`) → `201 { url, name, type, size }`. Only columns with `upload` (SB-30) |

With `lookup` columns, each page also carries `labels`: the name of each id in
the range (`03-lookup.md` §4); if the column has `avatar.image`, also
`images`: the photo URL of each id (SB-29); with `avatar.iconField`, `icons`:
the icon name of each id (SB-39). The client stores them in its cache whether
the source is `Sheet(url)` or hand-written.

Pagination by **offset**, not by cursor: it allows jumping to a position (going
to a row from the changes panel). To be revisited if the volume grows by an
order of magnitude.

### 5.2 Save batch

```jsonc
// Request
{
	"creates": [{ "key": "tmp_m0", "values": { "customer_rfc": "…" } }],
	"updates": [{
		"id": "case_002344",
		"rowVersion": "9c1e…",                                        // opaque token it read (SB-4)
		"changes": { "stage_code": { "from": "early", "to": "judicial" } },   // only what it touched
		"base": { "customer_name": "…", "handler_id": "usr_2" }       // what it read in the writable columns it did NOT touch (SB-16)
	}],
	"deletes": [{ "id": "case_000008", "rowVersion": "41b0…" }]
}

// Response 200 — partial success
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

Rules (proven in OpenCollect, SB-5):

- **Shortcut:** if the current `rowVersion` is the one the client read, nobody
  touched the row: it is applied without comparing.
- **For each field the request changes:** current value = `from` → it is
  applied; different → `field_conflict`, **unless the current value is already
  the one the client asks for** (`to`, SB-17). The client applies the same rule
  on reload. The comparison is normalized by type (`1500` = `"1500.00"`).
- **Changes by others in other fields** —those in `base` whose current value
  is already different—, depending on the sheet's policy, set on the server:
  `merge` keeps them and reports them in `notices`; `strict` rejects the row
  with `version_mismatch`.
- **Deleting what someone else edited** is always a conflict (the `rowVersion`
  does not match). Deleting what someone else already deleted is reported as
  deleted. Editing what someone else deleted: `not_found`.
- **A conflict does not block the rest of the batch.** A malformed batch
  (nonexistent field, read-only field or invalid value) is rejected as a whole
  with 400. An error in a domain handler rolls back the whole batch (SB-20).
- **Idempotency (SB-18):** the same key returns the same response without
  reapplying (`Idempotent-Replayed: true`); the same key with a different
  body, 422. An error is not stored: it can be retried.

### 5.3 Data source (SB-2, SB-4, SB-19)

```ts
// packages/server/src/source.ts — each method may return the value or a promise
interface SheetSource {
	attach?(definition: SheetDefinition): void;          // learns the columns
	list(q: ListQuery): Page;                             // order and filters; id tiebreaker
	position(id: string, q: ListQuery): { position: number | null; total: number };
	get(id: string): Row | undefined;                     // with its rowVersion
	insert(values): Row;                                  // direct write, if there are no handlers
	update(id: string, values): Row;                      // returns the row with its new rowVersion
	remove(id: string): void;

	// Optional: what a transactional database provides
	transaction?<T>(fn: (tx: SheetTx) => Promise<T>): Promise<T>;
	idempotency?: IdempotencyStore;                       // otherwise, the engine stores it in memory
}

interface SheetTx extends SheetSource {
	lock(ids: string[]): Promise<void>;                   // SELECT … FOR UPDATE, in id order
	db: unknown;                                          // the connection: handlers write with it
}
```

There are `memorySource` (version counter; no transaction: the engine applies
batches one at a time), `postgresSource` (content fingerprint, transaction,
locking and idempotency in the database) and `mongoSource` (fingerprint or
counter; the sheet can be a subset of a shared collection with `filter`;
transactions with Mongo sessions on a replica set, locking through locks in
`spreadbase_locks` with retry on `WriteConflict`, idempotency in
`spreadbase_idempotency` with TTL). How source, transaction and handlers fit
together, with an example in a JavaScript host project:
`02-fuentes-transacciones-handlers.md`.

**The user's table needs nothing special** (SB-4): no version column, no
trigger, no change table. If it already has a version or last-modified column,
it can be used instead of the fingerprint, for performance.

### 5.4 Events (SB-8)

Each applied batch emits, per row, `{ sheet, op, id, fields, rowVersion }` to
whoever subscribes with `sheet.subscribe(fn)`, **after** the transaction is
committed. Nobody consumes it today; it is the hook for real time.

---

## 6. Repo structure

```
SpreadBase/
├── packages/
│   ├── core/          @spreadbase/core
│   ├── server/        @spreadbase/server
│   └── client/        @spreadbase/client
├── examples/          one server and one app for all the examples (SB-11)
│   ├── backend/       common base (src/app.ts) + src/examples/{basic,postgres,cases}
│   └── frontend/      index + one page per example (basic, postgres, cases, local)
├── tests/             E2E per module against the examples, and sources against a real database (§7)
└── docs/
```

The **cases** example is layered like an OpenCollect module
(`cases.routes → cases.controller → cases.service`), with hand-written routes.
The **basic** one uses the `sheetRouter()` shortcut. The **Postgres** one is a
JS backend with Aggy's structure (orchestrator, `core/api/<module>`). Together
the three cover the forms in §4.1.

**Client styles.** The components only use Tailwind/daisyUI classes and their
own CSS. The app declares `@source` pointing to `@spreadbase/client/src` so
that Tailwind generates those classes, and imports
`@spreadbase/client/theme-daisyui.css` so the sheet takes the theme colors.

---

## 7. Tests

Principles, inherited from OpenCollect's testing strategy (its doc 09):

1. **E2E first, no mocks:** real API, real browser, real data. A test tells a
   user story and may call the API and drive the browser in the same story.
2. **Servers running in test mode.** The tests do not start them: they require
   them to respond and, if they do not, fail immediately with the instruction
   to start them. Destructive endpoints (`reset`, `mutate`) only exist in test
   mode.
3. **The deterministic decides.** Vitest compares concrete values (API
   response, a cell's text or class, state on the server). Screenshots and
   consoles accompany, they do not decide.
4. **Each user is a browser context.** Two contexts = two users editing the
   same row.
5. **Pure code, next to the code.** What requires importing the code —like
   the history property test— lives in its package
   (`packages/client/src/**/*.test.ts`). It is the exception.

Tools: Vitest 4.1.x as the runner and Playwright 1.63.x as a library.

| Directory | Covers |
|---|---|
| `tests/protocol/` | The rules of §5: reading, batch, per-field concurrency, idempotency. 23 cases: with `merge` 22 pass and 1 is skipped; with `strict`, 20 pass and 3 are skipped |
| `tests/grid/` | Browser: the 32 scenarios in its README (basics, window, draft, A/B concurrency and network), plus the walkthrough with and without a server; L-1 to L-5 (lookup) and T-1 to T-5 (password and checkbox) on the Postgres example |
| `tests/postgres/` | `postgresSource` (23), lookup columns (15), password and boolean (11) and ordering (4) against a real database |
| `packages/client/src/…test.ts` | History properties: undoing an action ≙ replaying everything without it |
| `tests/contract/` | The contract kit (SB-26) against the cases sheet (memory) and the products sheet (Postgres, external write through SQL): 10 cases |
| `tests/mongo/` | `mongoSource` against MongoDB 7 (single-node replica set in Docker, `MONGO_URL`): reading, shared collection, batch, concurrency, transaction and handlers, idempotency (22); filters against the memory rule (9); contract kit over HTTP (5). Skipped without Mongo |
| `tests/assistant/` | The importer agent (SB-36): with rules and with a scripted model that calls tools, HTTP routes (zip, limits, owner), a real bulletin with `EXTRACTION_PDF`; plus `tests/mongo/asistente.test.ts` and `tests/protocol/asistente.test.ts` (with the example running) |
| `tests/extraction/` | File extraction (SB-36): table reconstruction by coordinates (8), minimal PDF written in the test (4), Excel/CSV/text (4), fake LLM and comparison (5); the real bulletin, only with `EXTRACTION_PDF` (3) |

### 7.1 What SpreadBase guarantees and what the app tests (2026-09-29)

Concurrency —per-field conflict, `merge`/`strict`, locking in the transaction,
idempotency— belongs to the engine and is tested **here, once**
(`protocol/`, `grid/concurrencia`, `postgres/source`). An app that uses
SpreadBase **does not repeat that suite** per module.

What the app does test for each sheet is **its connection** to the engine,
because that is where it can break the guarantee without touching the
library: a view missing an editable column, a `versionColumn` that a handler
or an external process does not update, a handler that writes outside
`ctx.tx`, routes that do not pass `Idempotency-Key`. That is what the
**contract kit** is for (`@spreadbase/testing`, SB-26): the app calls it once
per sheet and it registers five cases over HTTP.

```ts
import { edit, sheetContract } from '@spreadbase/testing';

sheetContract({
	name: 'customers',
	url: `${API}/api/customers/sheet`,          // the same URL as new Sheet(url)
	reset: () => post('/api/customers/dev/reset'),
	edits: [edit.text('name'), edit.toggle('active')],
	external: (id, field) => sql(`UPDATE customers SET ${field} = … WHERE id = $1`, [id])
});
```

| Case | If it fails, the sheet… |
|---|---|
| K-1 same field → `field_conflict` and does not overwrite | does not detect versions (fingerprint or `versionColumn`) |
| K-2 another field → merged with a notice (`strict`: rejected) | its view is missing an editable column |
| K-3 deleting what was edited → conflict (if it allows deletes) | its deletes do not respect the version |
| K-4 retry with the same key → no duplicate; another request with the key → 422 | its routes do not pass `Idempotency-Key` |
| K-5 another process wrote from outside → conflict (if `external` is given) | what writes from outside does not move the version |

`edit.text`, `edit.toggle`, `edit.option` and `edit.lookup` generate valid
values according to the column type (taken from the schema); `edit.custom`,
the rest. With a single editable field (an almost read-only sheet), K-2 is
skipped. The kit is tested against the examples in `tests/contract/`.

A sheet with a local source (`dataSource: { load, save }`) has no
concurrency: each browser has its own copy.

---

## 8. Plan and status

| # | Step | Status |
|---|---|---|
| 1 | Repo base (workspaces, TypeScript, Vitest) | ✅ |
| 2 | Proven copy of OpenCollect as the starting point | ✅ |
| 3 | Commit of the starting point | ✅ |
| 4 | `core`: column and protocol types, normalization and validation | ✅ |
| 5 | `server`: `SpreadBase`, `memorySource`, `parseListQuery`/`parseBatch`, `sheetRouter()`. Layered cases example. Protocol green with `merge` and `strict` | ✅ |
| 6 | `client`: `Sheet` + `<SpreadBase>` loading `/schema`. Pages with and without a server. History property and browser walkthrough green | ✅ |
| 7 | Basic example (verified in the browser: schema, pattern validation, saving) | ✅ |
| 8 | Remove the temporary copy, `apps/demo` and the previous code in `packages/` | ✅ |
| 9 | Browser E2E in `tests/grid/`: the 32 scenarios (§7) | ✅ |
| 10 | OpenCollect consumes the packages and deletes its copy; second consumer (SB-15). **First module done:** `users` (`/settings/users`), installed from a local path, with password, checkbox and domain rules in handlers. `/cases` still uses the previous copy | 🟡 |
| 11 | `postgresSource` (SB-2, SB-4, SB-18, SB-19): 23 tests against a real database and the Postgres example verified in the browser | ✅ |
| 12 | Real-time collaboration (SB-8) | ⬜ |
| 13 | Examples in a single server and a single app (SB-11) | ✅ |
| 14 | `lookup` column (SB-21): protocol, engine, popover with a paginated mini table, pasting in three steps; 15 engine tests and 5 browser tests | ✅ |
| 15 | Postgres example with a field of each type: text, number, select, lookup, image, date and date-time | ✅ |
| 16 | `PASSWORD` (SB-22) and `BOOLEAN` types; users sheet in the Postgres example; 11 engine tests and T-1 to T-5 in the browser | ✅ |
| 17 | Default sheet order (`defaultSort`) and `collation` in `postgresSource` to sort Spanish text (`es-x-icu`); 4 tests against the database | ✅ |
| 18 | Client columns and per-row actions (SB-23): `columns` (patch or function, client-only columns) and `actions`; 9 unit tests and AC-1 to AC-3 in the browser on `/basic` | ✅ |
| 19 | Toolbar in three sections with custom buttons (SB-24) and no horizontal overflow; AC-4 and AC-5 in the browser on `/basic` | ✅ |
| 21 | Contract kit `@spreadbase/testing` (SB-26), tested against cases and products (`tests/contract/`) | ✅ |
| 23 | Import (SB-34): `importFormat`/`importRoutes`, `<SheetImport>` with an editable preview, server notices in the cell; example `/imports`, 8 tests without a browser and 4 in the browser | ✅ |
| 22 | Sort and filter from the header (SB-33): `where` in the protocol, memory and Postgres with the same rule, `GET /values/:field`, column menu and Filters panel; 10 tests against the database and FC-1…FC-5 in the browser | ✅ |
| 20 | Forms with the sheet's columns: `Field` and `FormState` (SB-25), example `/form`, F-1…F-5 in the browser (`tests/grid/form.test.ts`) | ✅ |
| 24 | `mongoSource` (basis for SB-36; Aggy Legacy stores in Mongo): same interface as `postgresSource`, fixed `filter` for a table inside `datadocuments`, fingerprint or `versionField`, SB-33 filters with `$expr`, SB-35 estimated count, transactions with sessions, locks and idempotency with TTL. `mongodb` as an optional dependency. 36 tests against Mongo 7 in Docker (`tests/mongo/`), contract kit included. §5.3 and `02-fuentes…` §4.3 | ✅ |
| 29 | Icons taken from the data (SB-39): `avatar.iconField` (text and lookup, `Page.icons`), `Option.icon`, list without a repeated value, names and icons from a hand-written `RemoteDataSource`, `ColumnAction.label` as a function; example `/stages`, IC-1…IC-11 in the browser | ✅ |
| 28 | Import assistant v2, second revision (SB-36 §8): A2 («Importar archivos» ("Import files") button, resuming the run by `origen`, «Ver documento» ("View document")/«Ver staging» ("View staging")), S (staging = the real sheet of the destination table with the changes of the whole run as pending, `GET/PUT /runs/:run/staging`, «Importar» ("Import") = save the sheet with confirmation of deletions) and T (`FILE`/`FOLDER`/long text, SB-38, and matching files with rows); live through `GET /events` and «Detener» ("Stop") | ✅ |
| 27 | Agent engine (SB-37): outside this repo | ✅ |
| 26 | SB-36 importer agent, server side (`packages/server/src/importAgent/`): `importAgent` with `ImportLLM.chat` (loop with tools, provider-neutral), `ImportRunStore` (`memoryRunStore`, with version control), `ImportRunner` (`inProcessRunner`), `ImportFileStorage` (`diskStorage` now with `read`/`remove`); destinations SB-34 format (`upsert`/`replace`), `adjuntar` and discard; 13 base tools; `importAssistantRoutes` with the contract in core (`ImportRun`…); example `/api/import-assistant` (scripted model; Gemini optional). `docs/05-asistente-importacion.md`. Client: `<ImportAssistant>` (4-step window: files, folders and zips opened in the browser with `jszip`; destination and instruction per file; analysis with chat; import in the background; Details with correct and retry) and `ImportAssistantState`; page `/import-assistant`; AI-1 and AI-2 in the browser | ✅ |
| 25 | File extraction for SB-36 (`packages/server/src/extraction/`): block-based intermediate structure; method P (`pdfjs-dist` + `@napi-rs/canvas`: tables by alignment, hidden text and merged cells from the rendered page; Excel/CSV with `readXlsx`/`parseDelimited`/`locateTable`, which move from the client to core); method X with an injected `ImportLLM`; `compararExtracciones` cell by cell. Optional dependencies, imported on use. 24 tests (`tests/extraction/`), 3 with the real bulletin | ✅ |

### Known pending items

- **Validation in two implementations (SB-1 half done).** The rules are one
  —they travel in the schema—, but two pieces of code apply them: `core`'s
  `validateValue` on the server and `client`'s cell types (`cellTypes.ts`,
  inherited from OpenCollect) in the browser. Unifying them requires touching
  the proven grid; it will be done once the browser tests are complete.
- **`client/types.ts` repeats protocol types** (`BatchRequest`,
  `BatchResponse`…) instead of importing them from `core`.
- **Supabase:** `postgresSource` is tested against Postgres 16 in Docker. The
  same tests still have to run against the Supabase project: its connection
  string (`DATABASE_URL`) is needed, not just the API key.
- **Inherited names:** CSS classes still have the `oc-` prefix (`oc-grid`,
  `oc-cell-dirty`) and the tests depend on them. Renaming to `sb-` is a
  mechanical change best done before publishing.
- **Client-only types:** `action` (per-row button) and `remote-select`
  exist in the client but not in `core`: the server neither declares nor
  validates them. `remote-select` is superseded by `lookup` (SB-21).
- **Date-time without a time zone:** `postgresSource` reads it as
  `AAAA-MM-DD HH:mm` (i.e. `YYYY-MM-DD HH:mm`), the client's format, in the
  database session's time zone. Reading another format made `from` and `base`
  not match what was stored (false conflicts and notices); with `timestamptz`,
  the sheet works in the connection's time zone.
- **Installation from a local path:** until it is published, a project consumes
  the packages with `file:../../SpreadBase/packages/*`. In Vite it needs
  `resolve.dedupe: ['svelte']` (a single copy of Svelte) and allowing the folder
  in `server.fs.allow`; in Tailwind, `@source` pointing to `node_modules/@spreadbase/client/src`.
- **Idempotency in memory** (`memorySource`): fine for one process. With
  Postgres it is already in the database, in the same transaction as the batch.
