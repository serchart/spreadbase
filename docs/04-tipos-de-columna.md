# 04 — Column types

> Which types exist, how they are declared on the server and what each side does
> with them. The password has its own section (§2): it is the only type whose
> stored value never leaves the server.

**Created:** 2026-09-28 · **Status:** 🟢 current (SB-21, SB-22, SB-38)

---

## 1. The types

They are declared with `types.<TYPE>` from `@spreadbase/server`. All of them run in the
Postgres example (products and users sheets).

| Type | Value | Rules the server validates (and the client when editing) | In the cell | Example |
|---|---|---|---|---|
| `TEXT` | text | `required`, `minLength`, `maxLength`, `pattern` (+ `patternMessage`) | Text | Name, SKU, email |
| `NUMBER` | number | `required`, `min`, `max` | `prefix`, `suffix`, `precision`, `thousands` | Price |
| `SELECT` | text from `options` | `required`, that it is in `options` | The label, with the option's icon if it has `icon` (SB-39); searchable list (the value on the right only if it differs from the label) | Status, role |
| `LOOKUP` | id of another resource | `required`, that the id exists (`lookup.byIds`) | The name; paginated mini table | Owner ([03-lookup.md](03-lookup.md)) |
| `DATE` | `YYYY-MM-DD` | `required`, valid date | `DD/MM/YYYY`; calendar | Launch |
| `DATETIME` | `YYYY-MM-DD HH:mm` | `required`, valid date and time | `DD/MM/YYYY HH:mm`; calendar with time | Last restock |
| `IMAGE` | URL (`https://`, `/`, `data:image/`) | `required`, that it is an image URL | Thumbnail (`shape: 'round'` = avatar) | Photo, avatar |
| `FILE` | `{ url, name, type, size }` (`FileRef`) or just the URL (SB-30) | `required`, `http(s)` URL or path, non-empty name | Icon, name, size and ↗ (§3) | Contract, PDF spec sheet |
| `FOLDER` | list of `FileRef` | `required` (non-empty list), each file valid | Primary file (thumbnail or type icon), «3 archivos» and the names; panel with the list (§3) | Plan files |
| `BOOLEAN` | `true` / `false` | `required`, that it is a boolean | Checkbox: one click toggles it. When copying, «Sí»/«No» | Active |
| `PASSWORD` | see §2 | `required`, `minLength` (default 8), `maxLength` | `••••••••` | Password |

`TEXT` with `multiline: true` is **long text** (a markdown spec sheet, a JSON): the cell shows its
type (MD/JSON) and the first line; it is read and edited in a wide viewer (§3.4).

Common to all: `label`, `readOnly`, `required`, `defaultValue`, `validate`
(function, server only), `width`, `align`, `searchable` (text).

**Canonical formats.** What travels is always the canonical value from the
table above. `postgresSource` reads in that format (numbers as numbers,
dates as text, date-time without seconds and in the connection's time zone):
reading another format would make `from` and `base` not match what is stored and
would cause false conflicts and warnings.

**Client only**, there are also `action` (a button per row, with no
data), `remote-select` (search written in the front end; replaced by `LOOKUP`)
and custom renderers. The server does not declare them: they are added from
`new Sheet(url, { columns, actions })` (SB-23).

```ts
new Sheet(url, {
	actions: [{ label: 'Open', icon: SquareArrowOutUpRight, onclick: (row) => open(row.id) }],
	// or with the row's text (SB-39): «#1042»
	// actions: [{ label: (row) => `#${row.number}`, icon: FileText, onclick: (row) => open(row.id) }],
	columns: {
		name: { width: 260 },                                    // patch over the server's one
		status: (col) => ({ ...col, label: 'Contact status' }),  // function: receives it and returns the final one
		note: { type: 'text', label: 'Note', at: 'end' }         // client only (read-only)
	},
	frozenColumns: 1                                             // the action stays fixed when scrolling
});
```

---

## 2. Password (`PASSWORD`, SB-22)

### 2.1 Declaring it

```js
password_hash: {
  type: types.PASSWORD,
  label: 'Password',
  required: true,                        // mandatory on create; cannot be emptied
  minLength: 10,
  hash: (plain, ctx) => bcrypt.hash(plain, 12)   // mandatory: the app picks the algorithm
}
```

The table needs nothing special: a text column where the hash is stored.
SpreadBase does not depend on any crypto library. **Without `hash`, the sheet
does not start**: a password is never stored in plain text. The example uses
Node's `scrypt` (`common/passwords.js`).

### 2.2 What happens at each moment

| Moment | What SpreadBase does |
|---|---|
| **Read** (list, row, batch response, conflict row) | What is stored never leaves. An **opaque mark** `pwd:…` travels instead: a one-way hash of the row id and of what is stored. It changes when the password changes; two rows with the same stored value do not get the same mark. Without a password, `null` |
| **Display** | `••••••••` if there is a mark. A freshly typed password, one dot per character |
| **Edit** | The field starts empty; **empty means «don't change it»**, it never erases the stored one by accident. «Mostrar» lets you see it while typing |
| **Save** | Validates (`required`, length; the returned mark as is is rejected), calls `hash(plain, ctx)` and replaces the value. Handlers and source receive **only the hash**; the `row` a handler receives is masked |
| **Concurrency** | Per field, like any other, over the mark: if someone else changed the password and so did you, `field_conflict`; if you changed another field, a warning (`merge`) |
| **Query** | Filtering by the column is ignored and sorting by it is an error: they would be an oracle for guessing the hash |
| **Copy / paste** | Copying gives empty. Pasting writes a new password |
| **Local draft** | The typed but unsaved password **is not stored** in IndexedDB or `localStorage`: what was there before goes instead. After reloading, it has to be typed again |

Hiding is the **engine's** job, not each source's: even if a source or a
handler returns the hash, what goes out over HTTP is already masked. Nor does
the plain-text password remain in events or in the response; the
idempotency table only holds a fingerprint of the batch body.

### 2.3 What it does not do

- **It does not verify passwords.** Login belongs to the app (`verifyPassword` in the
  example). The mark is not useful for that.
- **It does not enforce complexity policies** beyond length. A custom
  rule goes in the column's `validate` (server only; its error shows up
  on save).

---

## 3. Files: `FILE` and `FOLDER` (SB-38)

### 3.1 Declaring them

```ts
import { diskStorage, types } from '@spreadbase/server';
const files = diskStorage({ dir: './uploads/planes', publicUrl: 'https://api.midominio.mx/uploads/planes' });

columns: {
	image:     { type: types.IMAGE,  label: 'Image', upload: { storage: files, maxSize: '5mb' } },
	contract:  { type: types.FILE,   label: 'Contract', upload: { storage: files, accept: ['application/pdf'] } },
	files:     { type: types.FOLDER, label: 'Files', upload: { storage: files, maxSize: '20mb' } },
	specSheet: { type: types.TEXT,   label: 'Spec sheet', multiline: true }
}
```

In the table: `jsonb` (or `text`) for `FILE` and `FOLDER`; `text` for long text.

### 3.2 The value

```ts
interface FileRef { url: string; name: string; type: string; size: number }   // @spreadbase/core
// FILE:   FileRef | 'https://…/contract.pdf' (the bare URL from SB-30 is still valid)
// FOLDER: FileRef[]
```

- `url` is the one from `FileStorage.save` (SB-30); `name` the one displayed (on upload, the cleaned name);
  `type` the real one (from the content); `size` in bytes.
- The legacy Spanish shape `{ url, nombre, tipo, tamano }` is still read (deprecated; removed in the next major); new values are always written in the new shape.
- Equality by content (`sameValue`: JSON with sorted keys): reading a file and returning it in
  `from` is not a conflict, even if the database returns the keys in another order.
- `postgresSource` writes the object or the list as JSON (in `jsonb` or in `text`) and on read turns the
  JSON into an object; a bare URL stays as text. The fingerprint (SB-4) includes them like any column.
- `mongoSource` stores them as a subdocument or a list (BSON numbers, such as `Int32`, come back as
  numbers).
- Filtering: `FILE` by its text (in Postgres, the column's JSON); `FOLDER` is not filtered.

### 3.3 In the cell

| | `FILE` | `FOLDER` |
|---|---|---|
| Cell | Icon by type, name, size (if known) and ↗ (opens; anything that is not an image, PDF or text is downloaded, `serve()` from SB-30) | The **primary** file (the first in the list) by type —its thumbnail if it is an image, otherwise its type's icon—, always «N archivos», and all the names on hover (tooltip) |
| Panel (double click) | Paste a URL, **Subir**, drag or paste the file; on upload the `FileRef` is set | The list: each file with name, size, ↗, ☆ «Hacer principal» (moves it to first place; the first one carries a «Principal» badge) and ✕ (remove); **Subir** adds several (or drop them on the panel); «Vaciar» and «Aceptar» |
| Copy / paste | The URL | One URL per line |

Every change stays pending and is saved with the batch, like any cell (undo, draft and
conflicts do not change).

**Thumbnail from a folder.** `avatar.image` (SB-29) may name a `FOLDER` column. The thumbnail is its
primary file if it is an image, otherwise the first image in the folder, otherwise the usual fallback
(initials or icon). It works in the same row (`text`) and in a `lookup`: the server sends in
`Page.images` the URL of that image, not the folder (`thumbnailOf`, core). A folder returned by the
database as JSON text is read the same way. Example: `/catalog`.

### 3.4 Long text (`multiline`)

The cell: an `MD` or `JSON` tag (if the text is one) and the first line (without `#`). The viewer: a
560 px monospaced area with the character count; «Formatear JSON» if the text is valid
JSON; Ctrl/⌘+Enter accepts and Escape discards. It is presentation only: the value is still text and is
validated as `TEXT`. (The text is never interpreted as HTML.)

### 3.5 From the import assistant (SB-36 §8)

An `adjuntar` destination with `columna: { formato, campo, emparejar? }` takes the file to that column of the
row it **matches**: by `destino.fila` (the exact key, set by the brain or by the person) or by name
(the values of `emparejar` as whole words of the file's name or folder). The value comes
from the column's type: `IMAGE` the URL, `FILE` the `FileRef`, `FOLDER` is appended to the list, text the
agent's derived output (ficha.md) or the document in markdown (method P). It stays as an `update` in staging.

## 4. Tests

| File | What it covers |
|---|---|
| `tests/postgres/password.test.ts` (11) | The mark in list, row, response and conflict; different per row; filter ignored and sort rejected; without `hash` it does not start; the hash with its context, the handler only sees the hash; mandatory on create; length, emptying and mark rejected; conflict and warning over the mark; boolean round trip and its filter |
| `tests/postgres/archivos.test.ts` (4) | `FILE`/`FOLDER` in `jsonb` and `text`: reading the JSON as an object and the bare URL as text, writing objects and lists without false conflicts, validation, schema and no folder filter |
| `tests/mongo/archivos.test.ts` (2) | The same on MongoDB (subdocument, list, `Int32` → number) |
| `tests/grid/archivos.test.ts` (AR-1, AR-6, AR-7) | Uploading a `FILE` leaves `{ url, name, type, size }` with its size in the cell; folder with count and names, panel that lists, opens, removes and uploads several; long text with its type, wide viewer and «Formatear JSON» |
| `tests/grid/carpeta.test.ts` (CP-1 to CP-5) | Primary file in the cell by type, count and names; «Hacer principal» and the saved order; `avatar.image` over a folder in the same row and in a `lookup` (`images` from the server) |
| `tests/protocol/asistente.test.ts` (T-1 to T-3) | The Planes GMF sheet with image, folder and spec sheet; matching by name (full unit, folder, markdown spec sheet, unmatched and ambiguous) and by `destino.fila` |
| `tests/grid/tipos.test.ts` (T-1 to T-5) | Dots and checkbox on load, no trace of the hash in the page; empty editor that changes nothing; new password that does not reach the draft and is saved; short password flagged; checkbox with click, undo, redo and save; copying a password gives empty |
