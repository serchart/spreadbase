# 03 — `lookup` columns: picking a record from another table

> The select whose options come from an external resource: users, customers,
> suppliers… It is configured **on the server**, in the column; the front end
> writes nothing.

**Created:** 2026-09-28 · **Status:** 🟢 current (SB-21). Running in the Postgres example, «Responsable» column

---

## 1. What it is

A column whose value is the key of a record in another resource —almost
always a foreign key (`owner_id`)—. The cell **stores the id and shows a
name**; editing it opens a popover with a **mini table** of that resource,
with a search box, to pick a row.

```
┌───────────────────────┬──┐
│ Ana López             │🔽│      ← the cell: shows `display`, stores `value`
└───────────────────────┴──┘
┌──────────────────────────────────────────┐
│ 🔍 ana_                                  │
├──────┬────────────────┬──────────────────┤
│      │ Name           │ Email            │ ← sticky header (none if there is a single column)
├──────┼────────────────┼──────────────────┤
│ (AL) │ Ana López      │ ana@…            │ ← highlighted row
│ (AM) │ Ana Martínez   │ amartinez@…      │
│  …   │ …              │ …                │ ↕ ↔  scrolls in both directions
├──────┴────────────────┴──────────────────┤
│ 50 de 132                                │ ← loads more on reaching the bottom
└──────────────────────────────────────────┘
```

Difference from `select`: in `select` the options are a fixed list that travels
in the schema. In `lookup` they are a resource that may have thousands of rows:
it is searched on the server, in chunks.

---

## 2. The contract: the only thing SpreadBase requires

A `types.LOOKUP` column with a `lookup` object:

```js
owner_id: {
  type: types.LOOKUP,
  label: 'Owner',
  required: true,
  lookup: {
    value: 'id',                                 // required: the field stored in the cell
    display: 'name',                             // required: the field shown in the cell
    columns: {                                   // optional: the popover's columns
      avatar: { type: types.IMAGE, label: '', width: 36, shape: 'round' },
      name:   { type: types.TEXT,  label: 'Name', width: 200 },
      email:  { type: types.TEXT,  label: 'Email', width: 220 }
    },
    search:  (q, { offset, limit }, ctx) => …,   // required → { rows, total }
    byIds:   (ids, ctx)   => …,                  // required → rows
    resolve: (texts, ctx) => …                   // optional → rows
  }
}
```

| Key | What for | When SpreadBase calls it |
|---|---|---|
| `value` | What is stored. Almost always the id | — |
| `display` | What is shown in the cell, in the changes panel and in conflicts | — |
| `columns` | The mini table's columns, with the same types as the sheet (display only). Without `columns`: a single column, `display`, **with no header** | — |
| `search(q, page, ctx)` | Fill the popover. **Paginated from the start**: receives `{ offset, limit }` and returns `{ rows, total }`, just like the sheet's list | When the popover opens, when typing in the search box and when the scroll reaches the bottom |
| `byIds(ids, ctx)` | The rows for specific ids: to **paint** the names and to **validate** that they exist | Once per loaded chunk of the sheet and once per saved batch |
| `resolve(texts, ctx)` | Pasting text: rows whose `display` **or** `value` matches each text | Only with the pasted texts the client could not resolve, without duplicates |

- Every row returned by `search`, `byIds` and `resolve` carries at least `value`,
  `display` and the fields in `columns`.
- `ctx` is the request context (the user, the tenant…), the same one the
  handlers receive. It is used to filter by permissions.
- Storing the text instead of the id also works: `value: 'name', display: 'name'`.
  It is discouraged for people (repeated names, names that change).
- If `search` or `byIds` is missing, `new SpreadBase` fails at startup with the
  field name, not on first use.
- What travels in `GET /schema` is `value`, `display` and `columns`. The functions
  stay on the server, just like `validate`.

**SpreadBase does not care where that object comes from.** It can be written
right there, with its SQL, or come from another module. That is a matter of how
the app's code is organized: §3 is the recommended way.

### 2.1 Base form: everything in the column

The most direct one. Good for a standalone sheet or a quickstart:

```js
import { SpreadBase, postgresSource, types } from '@spreadbase/server';

const sheet = new SpreadBase({
  id: 'products',
  columns: {
    name: { type: types.TEXT, label: 'Name', required: true },
    owner_id: {
      type: types.LOOKUP,
      label: 'Owner',
      lookup: {
        value: 'id',
        display: 'name',
        search: async (q, { offset, limit }) => {
          const where = `WHERE name ILIKE $1`;
          const [rows, count] = await Promise.all([
            pool.query(`SELECT id, name FROM users ${where} ORDER BY name, id LIMIT $2 OFFSET $3`, [`%${q}%`, limit, offset]),
            pool.query(`SELECT count(*)::int AS total FROM users ${where}`, [`%${q}%`])
          ]);
          return { rows: rows.rows, total: count.rows[0].total };
        },
        byIds: async (ids) => (await pool.query(`SELECT id, name FROM users WHERE id = ANY($1)`, [ids])).rows
      }
    }
  },
  source: postgresSource({ pool, table: 'products' })
});
```

It works, but in a real project it has two problems: the products sheet
writes SQL for the users table, and the next sheet with a user column repeats
all of it.

---

## 3. Recommended form: the resource defines its lookup; the sheet is a function

This is how the Postgres example organizes it, with Aggy's structure. **It is
not part of SpreadBase**: it is an app convention that makes it simpler to use.

Two ideas:

1. **The module that owns the resource defines once how one of its records is
   picked**: what is stored, what is shown, its columns and how it is searched.
   It is a property of its service (`users.lookup`), with its SQL inside.
2. **The sheet definition is a function that receives its dependencies**
   (`productsSheet({ users })`). That way the column is complete in a single
   place, and the sheet does not import the users service: it receives it, and
   the dependency still comes in through the constructor, as in Aggy.

```
core/api/
├── users/
│   └── users.service.js       ← SQL + `this.lookup`: how a user is picked
└── products/
    ├── products.sheet.js      ← productsSheet({ users }): the columns; `lookup: users.lookup`
    └── products.service.js    ← new SpreadBase({ ...productsSheet({ users }), source, handlers })
```

**The resource: `users.service.js`**

```js
import { types } from '@spreadbase/server';

class UsersService {
  constructor(orchestrator) {
    this.pool = orchestrator.pool;

    /** How a user is picked from any sheet. */
    this.lookup = {
      value: 'id',
      display: 'name',
      columns: {
        avatar: { type: types.IMAGE, label: '', width: 36, shape: 'round' },
        name:   { type: types.TEXT,  label: 'Name', width: 200 },
        email:  { type: types.TEXT,  label: 'Email', width: 220 }
      },
      search:  (q, page, ctx) => this.search(q, page, ctx),
      byIds:   (ids, ctx)     => this.byIds(ids, ctx),
      resolve: (texts, ctx)   => this.byNames(texts, ctx)
    };
  }

  /** Paginated search, ignoring accents and case. */
  async search(q, { offset, limit }) { /* SELECT … LIMIT/OFFSET + count */ }

  async byIds(ids) { /* SELECT … WHERE id = ANY($1) */ }

  /** For pasting: by name or by id. */
  async byNames(texts) { /* SELECT … WHERE translate(lower(name), …) = ANY($1) OR id = ANY($2) */ }
}
```

**The sheet: `products.sheet.js`**

```js
import { types } from '@spreadbase/server';

/** Sheet definition. Receives the services its columns depend on. */
export const productsSheet = ({ users }) => ({
  id: 'products',
  allowInsert: true,
  allowDelete: true,
  columns: {
    name:     { type: types.TEXT,   label: 'Name', required: true },
    owner_id: { type: types.LOOKUP, label: 'Owner', required: true, lookup: users.lookup }
  }
});
```

**The sheet's service: `products.service.js`**

```js
constructor(orchestrator) {
  this.sheet = new SpreadBase({
    ...productsSheet({ users: orchestrator.usersService }),
    source: postgresSource({ pool: orchestrator.pool, view: 'v_products', table: 'products' }),
    handlers: { … }
  });
}
```

The orchestrator creates `usersService` before `productsService`.

**Advantages**

- The column is entirely in the sheet, like `validate`.
- The users SQL lives in the users module.
- **It is reused:** any other sheet with a user column uses
  `lookup: users.lookup` and behaves the same: same popover, same search, same
  pasting.
- **It can be tuned per column** without touching the resource:

  ```js
  reviewer_id: {
    type: types.LOOKUP,
    label: 'Reviewer',
    lookup: { ...users.lookup, search: (q, page, ctx) => users.search(q, page, { ...ctx, onlyActive: true }) }
  }
  ```

---

## 4. Protocol

Two more routes under the sheet's base, and one more field on each page:

| Method | Route | Response |
|---|---|---|
| `GET` | `/lookup/:field?q=&offset=&limit=` | `{ rows, total, offset, limit }`. `limit` ≤ 100, default 50 |
| `POST` | `/lookup/:field/resolve` · `{ "texts": [...] }` | `{ matches: { "<text>": [row, …] } }`. Up to 500 texts per request |

**Names on every page of the sheet.** `GET /?offset&limit` adds `labels`:
the `display` of each id of the `lookup` columns present in that chunk,
obtained with **one** call to `byIds` per column. The cell never shows a
bare id.

```jsonc
{
  "rows": [{ "id": "prd_01", "owner_id": "usr_2", … }],
  "total": 500, "offset": 0, "limit": 60, "version": 0,
  "labels": { "owner_id": { "usr_2": "Ana López" } }
}
```

With `avatar` on the column, the same call also returns each id's
thumbnail: `images` (the URL from `avatar.image`, SB-29) and `icons` (the icon
name from `avatar.iconField`, SB-39), for example `"icons": { "stage_id": { "st_2": "hourglass" } }`.
The client stores them in its cache in a single place (the controller), so
a hand-written source that returns the same thing looks the same as `Sheet(url)`.

**Validation on save.** The engine collects the ids of each `lookup` column in
the batch and calls `byIds` **once**. An id that does not exist rejects the batch
with 400 and `No corresponde a ningún registro`, like any invalid value.

`sheetRouter` mounts both routes. With a hand-written controller they are two
more methods, with the parsing helpers, and the list receives the context for
the names:

```js
list:    sheet.list(parseListQuery(req.query), { user: req.user })
lookup:  sheet.lookup(req.params.field, parseLookupQuery(req.query), { user: req.user })   // GET  …/lookup/:field
resolve: sheet.resolve(req.params.field, parseResolve(req.body), { user: req.user })     // POST …/lookup/:field/resolve
```

---

## 5. On the client

`new Sheet(url)` reads `lookup` from the schema and builds the search against
`/lookup/:field` on its own. There is nothing to write in the front end.

**The popover** is an HTML table —not another jspreadsheet instance: its global
focus and keyboard state would fight with the sheet that contains it—, styled
with the sheet's theme (`--dg-*` variables):

- sticky header (`position: sticky`); **no header** if there is a single column;
- scrolls in both directions; the width is the sum of its columns, capped
  at the screen;
- **chunked loading**: 50 rows on open; when nearing the bottom it requests the
  next ones, with `offset`. A stale response (the user kept typing) is
  discarded;
- keyboard: ↑↓ move the highlighted row, Enter picks it, Esc cancels; ←→ stay
  in the search box;
- the mini table's cells use their type's format: an image shows as an image
  (avatar if `shape: 'round'`), a number with its format.

---

## 6. Pasting

Pasting 1,000 cells does **not** make 1,000 searches. Each pasted text goes
through three filters, from cheapest to most expensive, and only what is not
resolved in one reaches the next:

1. **Copied from the same sheet — zero queries.** The clipboard carries what
   is shown (names), so it reads well in Excel; the sheet also remembers in
   memory the real values of the last thing it copied. If what is pasted is
   that same text, it uses those values.
2. **Already known names — zero queries.** Those from the loaded pages and
   those picked in the popover, ignoring case and accents.
3. **What is left — one request**, with the **unique** texts (1,000 cells
   usually hold few distinct names): `POST /lookup/:field/resolve`, in
   chunks of 500.

Result per cell:

| Matches | The cell |
|---|---|
| One | Stores the id and shows the name |
| None | Keeps the pasted text, in red: «No corresponde a ningún registro» |
| Several | Keeps the text, in red: «Ambiguo: N coincidencias». The popover opens already filtered by that text |

If the server is needed, **it waits for the response and then applies the whole
paste**, as a single history step («Resolviendo 12 nombres…»). Pasting
instantly and correcting afterwards would break undo. If the network fails, the
text is pasted as is, in red: nothing is lost. Without `resolve` on the server,
step 3 does not exist and whatever is unresolved stays red to be picked by hand.

---

## 7. Tests

- `tests/postgres/lookup.test.ts` (15): schema without functions, startup with a
  half-defined lookup, names per chunk with a single query, paginated search
  ignoring accents, `resolve` (unique, ambiguous, none, by id, no duplicates),
  validation on save with a single query per batch, context.
- `tests/grid/lookup.test.ts` (L-1 to L-5): the mini table, chunked loading,
  picking with the keyboard, pasting from outside with a single request, and
  copying and pasting within the sheet with none.

## 8. Pending

- The rows of a **conflict** (`remote`) do not carry `labels`: if the other user
  picked a record the sheet does not know, the panel shows its id.
- The `remote-select` type inherited from OpenCollect is still in the client
  (search written in the front end). `lookup` replaces it; it will be removed
  when OpenCollect migrates.

## 9. Decisions

| # | Decision |
|---|---|
| **SB-21** | `lookup` column configured on the server: `value` (the id) is stored and `display` is shown; the popover is an HTML mini table with the sheet's theme, paginated from the start; names travel on every page; the server validates with `byIds`; pasting resolves in three steps, with a single request for the unique texts. SpreadBase only requires the shape of the `lookup` object; where it comes from (§3) is a matter of the app's organization |
