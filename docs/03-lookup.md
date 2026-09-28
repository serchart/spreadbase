# 03 — Columnas `lookup`: elegir un registro de otra tabla

> El select cuyas opciones vienen de un recurso externo: usuarios, clientes,
> proveedores… Se configura **en el servidor**, en la columna; el front no
> escribe nada.

**Creado:** 2026-09-28 · **Estado:** 🟢 vigente (SB-21). Corriendo en el ejemplo de Postgres, columna «Responsable»

---

## 1. Qué es

Una columna cuyo valor es la llave de un registro de otro recurso —casi
siempre una llave foránea (`owner_id`)—. La celda **guarda el id y muestra un
nombre**; al editarla se abre un popover con una **mini tabla** de ese recurso,
con buscador, para elegir una fila.

```
┌───────────────────────┬──┐
│ Ana López             │🔽│      ← la celda: muestra `display`, guarda `value`
└───────────────────────┴──┘
┌──────────────────────────────────────────┐
│ 🔍 ana_                                  │
├──────┬────────────────┬──────────────────┤
│      │ Nombre         │ Correo           │ ← encabezado fijo (sin él si hay una sola columna)
├──────┼────────────────┼──────────────────┤
│ (AL) │ Ana López      │ ana@…            │ ← fila resaltada
│ (AM) │ Ana Martínez   │ amartinez@…      │
│  …   │ …              │ …                │ ↕ ↔  scroll en ambas direcciones
├──────┴────────────────┴──────────────────┤
│ 50 de 132                                │ ← carga más al llegar al fondo
└──────────────────────────────────────────┘
```

Diferencia con `select`: en `select` las opciones son una lista fija que viaja
en el esquema. En `lookup` son un recurso que puede tener miles de filas: se
busca en el servidor, por tramos.

---

## 2. El contrato: lo único que exige SpreadBase

Una columna `types.LOOKUP` con un objeto `lookup`:

```js
owner_id: {
  type: types.LOOKUP,
  label: 'Responsable',
  required: true,
  lookup: {
    value: 'id',                                 // obligatorio: el campo que se guarda en la celda
    display: 'name',                             // obligatorio: el campo que se ve en la celda
    columns: {                                   // opcional: las columnas del popover
      avatar: { type: types.IMAGE, label: '', width: 36, shape: 'round' },
      name:   { type: types.TEXT,  label: 'Nombre', width: 200 },
      email:  { type: types.TEXT,  label: 'Correo', width: 220 }
    },
    search:  (q, { offset, limit }, ctx) => …,   // obligatorio → { rows, total }
    byIds:   (ids, ctx)   => …,                  // obligatorio → rows
    resolve: (texts, ctx) => …                   // opcional   → rows
  }
}
```

| Clave | Para qué | Cuándo la llama SpreadBase |
|---|---|---|
| `value` | Qué se guarda. Casi siempre el id | — |
| `display` | Qué se ve en la celda, en el panel de cambios y en los conflictos | — |
| `columns` | Las columnas de la mini tabla, con los mismos tipos que la hoja (solo para mostrar). Sin `columns`: una sola columna, `display`, **sin encabezado** | — |
| `search(q, page, ctx)` | Llenar el popover. **Paginado desde el principio**: recibe `{ offset, limit }` y devuelve `{ rows, total }`, igual que la lista de la hoja | Al abrir el popover, al escribir en el buscador y al llegar al fondo del scroll |
| `byIds(ids, ctx)` | Las filas de ids concretos: para **pintar** los nombres y para **validar** que existen | Una vez por tramo de la hoja cargado y una vez por lote guardado |
| `resolve(texts, ctx)` | Pegar texto: filas cuyo `display` **o** `value` coincide con cada texto | Solo con los textos pegados que el cliente no pudo resolver, sin duplicados |

- Cada fila que devuelven `search`, `byIds` y `resolve` trae al menos `value`,
  `display` y los campos de `columns`.
- `ctx` es el contexto de la petición (el usuario, el tenant…), el mismo que
  reciben los handlers. Sirve para filtrar por permisos.
- Guardar el texto en lugar del id también vale: `value: 'name', display: 'name'`.
  Se desaconseja para personas (nombres repetidos, nombres que cambian).
- Si falta `search` o `byIds`, `new SpreadBase` falla al arrancar con el nombre
  del campo, no en el primer uso.
- Lo que viaja en `GET /schema` es `value`, `display` y `columns`. Las funciones
  se quedan en el servidor, igual que `validate`.

**De dónde salga ese objeto no le importa a SpreadBase.** Puede escribirse ahí
mismo, con su SQL, o venir de otro módulo. Eso es organización del código de
la app: el §3 es la forma recomendada.

### 2.1 Forma base: todo en la columna

La más directa. Sirve para una hoja suelta o un quickstart:

```js
import { SpreadBase, postgresSource, types } from '@spreadbase/server';

const sheet = new SpreadBase({
  id: 'products',
  columns: {
    name: { type: types.TEXT, label: 'Nombre', required: true },
    owner_id: {
      type: types.LOOKUP,
      label: 'Responsable',
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

Funciona, pero en un proyecto real tiene dos problemas: la hoja de productos
escribe SQL de la tabla de usuarios, y la siguiente hoja con una columna de
usuario repite todo.

---

## 3. Forma recomendada: el recurso define su lookup; la hoja es una función

Es cómo lo organiza el ejemplo de Postgres, con la estructura de Aggy. **No es
parte de SpreadBase**: es una convención de la app que simplifica usarla.

Dos ideas:

1. **El módulo dueño del recurso define una vez cómo se elige uno de sus
   registros**: qué se guarda, qué se ve, sus columnas y cómo se busca. Es una
   propiedad de su servicio (`users.lookup`), con su SQL dentro.
2. **La definición de la hoja es una función que recibe sus dependencias**
   (`productsSheet({ users })`). Así la columna queda completa en un solo
   lugar, y la hoja no importa el servicio de usuarios: lo recibe, y la
   dependencia sigue entrando por el constructor, como en Aggy.

```
core/api/
├── users/
│   └── users.service.js       ← SQL + `this.lookup`: cómo se elige un usuario
└── products/
    ├── products.sheet.js      ← productsSheet({ users }): las columnas; `lookup: users.lookup`
    └── products.service.js    ← new SpreadBase({ ...productsSheet({ users }), source, handlers })
```

**El recurso: `users.service.js`**

```js
import { types } from '@spreadbase/server';

class UsersService {
  constructor(orchestrator) {
    this.pool = orchestrator.pool;

    /** Cómo se elige un usuario desde cualquier hoja. */
    this.lookup = {
      value: 'id',
      display: 'name',
      columns: {
        avatar: { type: types.IMAGE, label: '', width: 36, shape: 'round' },
        name:   { type: types.TEXT,  label: 'Nombre', width: 200 },
        email:  { type: types.TEXT,  label: 'Correo', width: 220 }
      },
      search:  (q, page, ctx) => this.search(q, page, ctx),
      byIds:   (ids, ctx)     => this.byIds(ids, ctx),
      resolve: (texts, ctx)   => this.byNames(texts, ctx)
    };
  }

  /** Búsqueda paginada, sin distinguir acentos ni mayúsculas. */
  async search(q, { offset, limit }) { /* SELECT … LIMIT/OFFSET + count */ }

  async byIds(ids) { /* SELECT … WHERE id = ANY($1) */ }

  /** Para pegar: por nombre o por id. */
  async byNames(texts) { /* SELECT … WHERE translate(lower(name), …) = ANY($1) OR id = ANY($2) */ }
}
```

**La hoja: `products.sheet.js`**

```js
import { types } from '@spreadbase/server';

/** Definición de la hoja. Recibe los servicios de los que dependen sus columnas. */
export const productsSheet = ({ users }) => ({
  id: 'products',
  allowInsert: true,
  allowDelete: true,
  columns: {
    name:     { type: types.TEXT,   label: 'Nombre', required: true },
    owner_id: { type: types.LOOKUP, label: 'Responsable', required: true, lookup: users.lookup }
  }
});
```

**El servicio de la hoja: `products.service.js`**

```js
constructor(orchestrator) {
  this.sheet = new SpreadBase({
    ...productsSheet({ users: orchestrator.usersService }),
    source: postgresSource({ pool: orchestrator.pool, view: 'v_products', table: 'products' }),
    handlers: { … }
  });
}
```

El orquestador crea `usersService` antes que `productsService`.

**Ventajas**

- La columna está entera en la hoja, como `validate`.
- El SQL de usuarios vive en el módulo de usuarios.
- **Se reutiliza:** cualquier otra hoja con una columna de usuario usa
  `lookup: users.lookup` y queda igual: mismo popover, misma búsqueda, mismo
  pegado.
- **Se ajusta por columna** sin tocar el recurso:

  ```js
  reviewer_id: {
    type: types.LOOKUP,
    label: 'Revisa',
    lookup: { ...users.lookup, search: (q, page, ctx) => users.search(q, page, { ...ctx, onlyActive: true }) }
  }
  ```

---

## 4. Protocolo

Dos rutas más bajo la base de la hoja, y un campo más en cada página:

| Método | Ruta | Respuesta |
|---|---|---|
| `GET` | `/lookup/:field?q=&offset=&limit=` | `{ rows, total, offset, limit }`. `limit` ≤ 100, default 50 |
| `POST` | `/lookup/:field/resolve` · `{ "texts": [...] }` | `{ matches: { "<texto>": [fila, …] } }`. Hasta 500 textos por petición |

**Nombres en cada página de la hoja.** `GET /?offset&limit` agrega `labels`:
el `display` de cada id de las columnas `lookup` presentes en ese tramo,
obtenido con **una** llamada a `byIds` por columna. La celda nunca muestra un
id pelón.

```jsonc
{
  "rows": [{ "id": "prd_01", "owner_id": "usr_2", … }],
  "total": 500, "offset": 0, "limit": 60, "version": 0,
  "labels": { "owner_id": { "usr_2": "Ana López" } }
}
```

**Validación al guardar.** El motor junta los ids de cada columna `lookup` del
lote y llama **una vez** a `byIds`. Un id que no existe rechaza el lote con 400
y `No corresponde a ningún registro`, como cualquier valor inválido.

`sheetRouter` monta las dos rutas. Con controlador a mano son dos métodos más,
con los helpers de parseo, y la lista recibe el contexto para los nombres:

```js
list:    sheet.list(parseListQuery(req.query), { user: req.user })
lookup:  sheet.lookup(req.params.field, parseLookupQuery(req.query), { user: req.user })   // GET  …/lookup/:field
resolve: sheet.resolve(req.params.field, parseResolve(req.body), { user: req.user })     // POST …/lookup/:field/resolve
```

---

## 5. En el cliente

`new Sheet(url)` lee `lookup` del esquema y arma solo el buscador contra
`/lookup/:field`. No hay nada que escribir en el front.

**El popover** es una tabla HTML —no otra instancia de jspreadsheet: su estado
global de foco y teclado se pelearía con la hoja que la contiene—, con el
estilo del tema de la hoja (variables `--dg-*`):

- encabezado fijo (`position: sticky`); **sin encabezado** si hay una sola columna;
- scroll en ambas direcciones; el ancho es la suma de sus columnas, con tope
  en la pantalla;
- **carga por tramos**: 50 filas al abrir; al acercarse al fondo pide las
  siguientes, con `offset`. Una respuesta vieja (el usuario siguió
  escribiendo) se descarta;
- teclado: ↑↓ mueven la fila resaltada, Enter la elige, Esc cancela; ←→ se
  quedan en el buscador;
- las celdas de la mini tabla usan el formato de su tipo: una imagen se ve
  como imagen (avatar si `shape: 'round'`), un número con su formato.

---

## 6. Pegar

Pegar 1 000 celdas **no** hace 1 000 búsquedas. Cada texto pegado pasa por tres
filtros, de lo más barato a lo más caro, y solo lo que no se resuelve en uno
llega al siguiente:

1. **Copiado de la misma hoja — cero consultas.** El portapapeles lleva lo que
   se ve (nombres), para que en Excel salga legible; la hoja además recuerda
   en memoria los valores reales de lo último que copió. Si lo pegado es ese
   mismo texto, usa esos valores.
2. **Nombres ya conocidos — cero consultas.** Los de las páginas cargadas y los
   elegidos en el popover, sin distinguir mayúsculas ni acentos.
3. **Lo que falta — una petición**, con los textos **únicos** (1 000 celdas
   suelen ser pocos nombres distintos): `POST /lookup/:field/resolve`, en
   tramos de 500.

Resultado por celda:

| Coincidencias | La celda |
|---|---|
| Una | Guarda el id y muestra el nombre |
| Ninguna | Conserva el texto pegado, en rojo: «No corresponde a ningún registro» |
| Varias | Conserva el texto, en rojo: «Ambiguo: N coincidencias». El popover abre ya filtrado con ese texto |

Si hay que ir al servidor, **se espera la respuesta y luego se aplica el pegado
completo**, como un solo paso del historial («Resolviendo 12 nombres…»). Pegar
al instante y corregir después rompería el deshacer. Si la red falla, se pega
el texto tal cual, en rojo: no se pierde nada. Sin `resolve` en el servidor, el
paso 3 no existe y lo no resuelto queda en rojo para elegirlo a mano.

---

## 7. Pruebas

- `tests/postgres/lookup.test.ts` (15): esquema sin funciones, arranque con un
  lookup a medias, nombres por tramo con una sola consulta, búsqueda paginada
  sin acentos, `resolve` (único, ambiguo, ninguno, por id, sin duplicados),
  validación al guardar con una sola consulta por lote, contexto.
- `tests/grid/lookup.test.ts` (L-1 a L-5): la mini tabla, la carga por tramos,
  elegir con el teclado, pegar de fuera con una sola petición y copiar y pegar
  dentro de la hoja sin ninguna.

## 8. Pendiente

- Las filas de un **conflicto** (`remote`) no traen `labels`: si el otro usuario
  eligió un registro que la hoja no conoce, el panel muestra su id.
- El tipo `remote-select` heredado de OpenCollect sigue en el cliente (buscador
  escrito en el front). `lookup` lo sustituye; se retira cuando OpenCollect migre.

## 9. Decisiones

| # | Decisión |
|---|---|
| **SB-21** | Columna `lookup` configurada en el servidor: se guarda `value` (el id) y se ve `display`; el popover es una mini tabla HTML con el tema de la hoja, paginada desde el principio; los nombres viajan en cada página; el servidor valida con `byIds`; pegar resuelve en tres pasos, con una sola petición para los textos únicos. SpreadBase exige solo la forma del objeto `lookup`; de dónde sale (§3) es organización de la app |
