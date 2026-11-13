# 04 — Tipos de columna

> Qué tipos existen, cómo se declaran en el servidor y qué hace cada lado con
> ellos. La contraseña tiene su propio apartado (§2): es el único tipo cuyo
> valor guardado nunca sale del servidor.

**Creado:** 2026-09-28 · **Estado:** 🟢 vigente (SB-21, SB-22, SB-38)

---

## 1. Los tipos

Se declaran con `types.<TIPO>` de `@spreadbase/server`. Todos corren en el
ejemplo de Postgres (hojas de productos y de usuarios).

| Tipo | Valor | Reglas que valida el servidor (y el cliente al editar) | En la celda | Ejemplo |
|---|---|---|---|---|
| `TEXT` | texto | `required`, `minLength`, `maxLength`, `pattern` (+ `patternMessage`) | Texto | Nombre, SKU, correo |
| `NUMBER` | número | `required`, `min`, `max` | `prefix`, `suffix`, `precision`, `thousands` | Precio |
| `SELECT` | texto de `options` | `required`, que esté en `options` | La etiqueta, con el ícono de la opción si trae `icon` (SB-39); buscador en lista (el valor a la derecha solo si es distinto de la etiqueta) | Estado, rol |
| `LOOKUP` | id de otro recurso | `required`, que el id exista (`lookup.byIds`) | El nombre; mini tabla paginada | Responsable ([03-lookup.md](03-lookup.md)) |
| `DATE` | `AAAA-MM-DD` | `required`, fecha válida | `DD/MM/AAAA`; calendario | Lanzamiento |
| `DATETIME` | `AAAA-MM-DD HH:mm` | `required`, fecha y hora válidas | `DD/MM/AAAA HH:mm`; calendario con hora | Último surtido |
| `IMAGE` | URL (`https://`, `/`, `data:image/`) | `required`, que sea URL de imagen | Miniatura (`shape: 'round'` = avatar) | Foto, avatar |
| `FILE` | `{ url, nombre, tipo, tamano }` (`FileRef`) o solo la URL (SB-30) | `required`, URL `http(s)` o ruta, nombre no vacío | Ícono, nombre, tamaño y ↗ (§3) | Contrato, ficha en PDF |
| `FOLDER` | lista de `FileRef` | `required` (lista no vacía), cada archivo válido | Carpeta, «3 archivos» y los nombres; panel con la lista (§3) | Archivos del plan |
| `BOOLEAN` | `true` / `false` | `required`, que sea booleano | Casilla: un clic la alterna. Al copiar, «Sí»/«No» | Activo |
| `PASSWORD` | ver §2 | `required`, `minLength` (default 8), `maxLength` | `••••••••` | Contraseña |

`TEXT` con `multiline: true` es **texto largo** (una ficha en markdown, un JSON): la celda muestra su
tipo (MD/JSON) y la primera línea; se lee y edita en un visor amplio (§3.4).

Comunes a todos: `label`, `readOnly`, `required`, `defaultValue`, `validate`
(función, solo en el servidor), `width`, `align`, `searchable` (texto).

**Formatos canónicos.** Lo que viaja es siempre el valor canónico de la
tabla de arriba. `postgresSource` lee en ese formato (números como número,
fechas como texto, fecha-hora sin segundos y en la zona de la conexión):
leer otro formato haría que `from` y `base` no coincidieran con lo guardado y
daría conflictos y avisos falsos.

**Solo en el cliente** existen además `action` (un botón por fila, sin
datos), `remote-select` (buscador escrito en el front; lo sustituye `LOOKUP`)
y renderizadores propios. El servidor no los declara: se agregan desde
`new Sheet(url, { columns, actions })` (SB-23).

```ts
new Sheet(url, {
	actions: [{ label: 'Abrir', icon: SquareArrowOutUpRight, onclick: (row) => abrir(row.id) }],
	// o con el texto de la fila (SB-39): «#1042»
	// actions: [{ label: (row) => `#${row.folio}`, icon: FileText, onclick: (row) => abrir(row.id) }],
	columns: {
		name: { width: 260 },                                    // parche sobre la del servidor
		status: (col) => ({ ...col, label: 'Estado del contacto' }), // función: la recibe y devuelve la final
		nota: { type: 'text', label: 'Nota', at: 'end' }         // solo del cliente (de solo lectura)
	},
	frozenColumns: 1                                             // la acción queda fija al desplazar
});
```

---

## 2. Contraseña (`PASSWORD`, SB-22)

### 2.1 Declararla

```js
password_hash: {
  type: types.PASSWORD,
  label: 'Contraseña',
  required: true,                        // obligatoria al crear; no se puede vaciar
  minLength: 10,
  hash: (plain, ctx) => bcrypt.hash(plain, 12)   // obligatoria: la app elige el algoritmo
}
```

La tabla no necesita nada: una columna de texto donde se guarda el hash.
SpreadBase no depende de ninguna librería de cifrado. **Sin `hash`, la hoja
no arranca**: nunca se guarda una contraseña en claro. El ejemplo usa
`scrypt` de Node (`common/passwords.js`).

### 2.2 Qué pasa en cada momento

| Momento | Qué hace SpreadBase |
|---|---|
| **Leer** (lista, fila, respuesta del lote, fila de un conflicto) | Lo guardado nunca sale. Viaja una **marca opaca** `pwd:…`: un hash de un solo sentido del id de la fila y de lo guardado. Cambia cuando cambia la contraseña; dos filas con lo mismo guardado no dan la misma marca. Sin contraseña, `null` |
| **Mostrar** | `••••••••` si hay marca. Una contraseña recién escrita, un punto por carácter |
| **Editar** | El campo empieza vacío; **vacío es «no cambiarla»**, nunca borra la guardada por accidente. «Mostrar» la deja ver mientras se escribe |
| **Guardar** | Valida (`required`, longitud; la marca devuelta tal cual se rechaza), llama a `hash(plain, ctx)` y reemplaza el valor. Handlers y fuente reciben **solo el hash**; la fila `row` que recibe un handler va enmascarada |
| **Concurrencia** | Por campo, como cualquier otro, sobre la marca: si otro cambió la contraseña y tú también, `field_conflict`; si tú cambiaste otro campo, aviso (`merge`) |
| **Consultar** | Filtrar por la columna se ignora y ordenar por ella es un error: serían un oráculo para adivinar el hash |
| **Copiar / pegar** | Copiar da vacío. Pegar escribe una contraseña nueva |
| **Borrador local** | La contraseña escrita y no guardada **no se guarda** en IndexedDB ni en `localStorage`: en su lugar va lo que había. Al recargar, hay que escribirla de nuevo |

Ocultar es trabajo del **motor**, no de cada fuente: aunque una fuente o un
handler devuelvan el hash, lo que sale por HTTP ya va enmascarado. Tampoco
queda la contraseña en claro en los eventos ni en la respuesta; en la tabla de
idempotencia solo hay una huella del cuerpo del lote.

### 2.3 Qué no hace

- **No verifica contraseñas.** El login es de la app (`verifyPassword` en el
  ejemplo). La marca no sirve para eso.
- **No aplica políticas de complejidad** más allá de la longitud. Una regla
  propia va en `validate` de la columna (solo en el servidor; su error aparece
  al guardar).

---

## 3. Archivos: `FILE` y `FOLDER` (SB-38)

### 3.1 Declararlos

```ts
import { diskStorage, types } from '@spreadbase/server';
const archivos = diskStorage({ dir: './uploads/planes', publicUrl: 'https://api.midominio.mx/uploads/planes' });

columns: {
	imagen:       { type: types.IMAGE,  label: 'Imagen', upload: { storage: archivos, maxSize: '5mb' } },
	contrato:     { type: types.FILE,   label: 'Contrato', upload: { storage: archivos, accept: ['application/pdf'] } },
	archivos:     { type: types.FOLDER, label: 'Archivos', upload: { storage: archivos, maxSize: '20mb' } },
	fichaTecnica: { type: types.TEXT,   label: 'Ficha técnica', multiline: true }
}
```

En la tabla: `jsonb` (o `text`) para `FILE` y `FOLDER`; `text` para el texto largo.

### 3.2 El valor

```ts
interface FileRef { url: string; nombre: string; tipo: string; tamano: number }   // @spreadbase/core
// FILE:   FileRef | 'https://…/contrato.pdf' (la URL suelta de SB-30 sigue valiendo)
// FOLDER: FileRef[]
```

- `url` es la de `FileStorage.save` (SB-30); `nombre` el que se muestra (al subir, el nombre limpio);
  `tipo` el real (por el contenido); `tamano` en bytes.
- Igualdad por contenido (`sameValue`: JSON con las claves ordenadas): leer un archivo y devolverlo en
  `from` no es conflicto, aunque la base devuelva las claves en otro orden.
- `postgresSource` escribe el objeto o la lista como JSON (en `jsonb` o en `text`) y al leer convierte el
  JSON en objeto; una URL suelta se queda como texto. La huella (SB-4) los incluye como cualquier columna.
- `mongoSource` los guarda como subdocumento o lista (los números de BSON, como `Int32`, vuelven como
  número).
- Filtrar: `FILE` por su texto (en Postgres, el JSON de la columna); `FOLDER` no se filtra.

### 3.3 En la celda

| | `FILE` | `FOLDER` |
|---|---|---|
| Celda | Ícono por tipo, nombre, tamaño (si se conoce) y ↗ (abre; lo que no es imagen, PDF o texto se descarga, `serve()` de SB-30) | El **principal** (el primero de la lista) según su tipo —miniatura si es imagen, ícono de su tipo si no—, «N archivos» y los nombres (todos en el tooltip) |
| Panel (doble clic) | Pegar una URL, **Subir**, arrastrar o pegar el archivo; al subir queda el `FileRef` | La lista: cada archivo con nombre, tamaño, ↗, ☆ **Hacer principal** (lo pasa al primer lugar; el primero lleva «Principal») y ✕ (quitar); **Subir** agrega varios (o soltarlos en el panel); «Vaciar» y «Aceptar» |
| Copiar / pegar | La URL | Una URL por línea |

Todo cambio queda pendiente y se guarda con el lote, como cualquier celda (deshacer, borrador y
conflictos no cambian).

**Miniatura desde una carpeta.** `avatar.image` (SB-29) puede nombrar una columna `FOLDER`: la
miniatura es su principal si es imagen; si no, la primera imagen de la carpeta; si no hay ninguna, el
respaldo de siempre (iniciales o ícono). Vale en la misma fila (`text`) y en un `lookup`: el servidor
manda en `Page.images` la URL de esa imagen, no la carpeta (`thumbnailOf`, core). Una carpeta que la
base devuelve como texto JSON se lee igual. Ejemplo: `/catalog` («Modelo y año» toma la foto principal
de «Fotos»; en «Unidades», el modelo elegido).

### 3.4 Texto largo (`multiline`)

La celda: una etiqueta `MD` o `JSON` (si el texto lo es) y la primera línea (sin `#`). El visor: un
área de 560 px en monoespaciado con el conteo de caracteres; «Formatear JSON» si el texto es un JSON
válido; Ctrl/⌘+Enter acepta y Escape descarta. Es presentación: el valor sigue siendo texto y se valida
como `TEXT`. (El texto nunca se interpreta como HTML.)

### 3.5 Desde el asistente de importación (SB-36 §8)

Un destino `adjuntar` con `columna: { formato, campo, emparejar? }` lleva el archivo a esa columna de la
fila que **empareja**: por `destino.fila` (la llave exacta, la deja el cerebro o la persona) o por nombre
(los valores de `emparejar` como palabras completas del nombre o la carpeta del archivo). El valor sale
del tipo de la columna: `IMAGE` la URL, `FILE` el `FileRef`, `FOLDER` se suma a la lista, texto el
derivado del agente (ficha.md) o el documento en markdown (método P). Queda como `update` en el staging.

## 4. Pruebas

| Archivo | Qué cubre |
|---|---|
| `tests/postgres/password.test.ts` (11) | La marca en lista, fila, respuesta y conflicto; distinta por fila; filtro ignorado y orden rechazado; sin `hash` no arranca; el hash con su contexto, el handler solo ve el hash; alta obligatoria; longitud, vaciar y marca rechazadas; conflicto y aviso sobre la marca; booleano de ida y vuelta y su filtro |
| `tests/postgres/archivos.test.ts` (4) | `FILE`/`FOLDER` en `jsonb` y `text`: leer el JSON como objeto y la URL suelta como texto, escribir objetos y listas sin conflicto falso, validación, esquema y sin filtro de carpeta |
| `tests/mongo/archivos.test.ts` (2) | Lo mismo sobre MongoDB (subdocumento, lista, `Int32` → número) |
| `tests/grid/carpeta.test.ts` (CP-1 a CP-5) | El principal en la celda según su tipo, el conteo y los nombres; «Hacer principal» y el orden guardado; `avatar.image` sobre la carpeta en la misma fila y en un `lookup` (`images` del servidor) |
| `tests/grid/archivos.test.ts` (AR-1, AR-6, AR-7) | Subir un `FILE` deja `{ url, nombre, tipo, tamano }` con su tamaño en la celda; carpeta con conteo y nombres, panel que lista, abre, quita y sube varios; texto largo con su tipo, visor amplio y «Formatear JSON» |
| `tests/protocol/asistente.test.ts` (T-1 a T-3) | La hoja Planes GMF con imagen, carpeta y ficha; emparejar por nombre (unidad completa, carpeta, ficha en markdown, sin emparejar y ambiguo) y por `destino.fila` |
| `tests/grid/tipos.test.ts` (T-1 a T-5) | Puntos y casilla al cargar, sin rastro del hash en la página; editor vacío que no cambia nada; contraseña nueva que no llega al borrador y se guarda; contraseña corta marcada; casilla con clic, deshacer, rehacer y guardado; copiar una contraseña da vacío |
