# 04 — Tipos de columna

> Qué tipos existen, cómo se declaran en el servidor y qué hace cada lado con
> ellos. La contraseña tiene su propio apartado (§2): es el único tipo cuyo
> valor guardado nunca sale del servidor.

**Creado:** 2026-09-28 · **Estado:** 🟢 vigente (SB-21, SB-22)

---

## 1. Los tipos

Se declaran con `types.<TIPO>` de `@spreadbase/server`. Todos corren en el
ejemplo de Postgres (hojas de productos y de usuarios).

| Tipo | Valor | Reglas que valida el servidor (y el cliente al editar) | En la celda | Ejemplo |
|---|---|---|---|---|
| `TEXT` | texto | `required`, `minLength`, `maxLength`, `pattern` (+ `patternMessage`) | Texto | Nombre, SKU, correo |
| `NUMBER` | número | `required`, `min`, `max` | `prefix`, `suffix`, `precision`, `thousands` | Precio |
| `SELECT` | texto de `options` | `required`, que esté en `options` | La etiqueta; buscador en lista | Estado, rol |
| `LOOKUP` | id de otro recurso | `required`, que el id exista (`lookup.byIds`) | El nombre; mini tabla paginada | Responsable ([03-lookup.md](03-lookup.md)) |
| `DATE` | `AAAA-MM-DD` | `required`, fecha válida | `DD/MM/AAAA`; calendario | Lanzamiento |
| `DATETIME` | `AAAA-MM-DD HH:mm` | `required`, fecha y hora válidas | `DD/MM/AAAA HH:mm`; calendario con hora | Último surtido |
| `IMAGE` | URL (`https://`, `/`, `data:image/`) | `required`, que sea URL de imagen | Miniatura (`shape: 'round'` = avatar) | Foto, avatar |
| `BOOLEAN` | `true` / `false` | `required`, que sea booleano | Casilla: un clic la alterna. Al copiar, «Sí»/«No» | Activo |
| `PASSWORD` | ver §2 | `required`, `minLength` (default 8), `maxLength` | `••••••••` | Contraseña |

Comunes a todos: `label`, `readOnly`, `required`, `defaultValue`, `validate`
(función, solo en el servidor), `width`, `align`, `searchable` (texto).

**Formatos canónicos.** Lo que viaja es siempre el valor canónico de la
tabla de arriba. `postgresSource` lee en ese formato (números como número,
fechas como texto, fecha-hora sin segundos y en la zona de la conexión):
leer otro formato haría que `from` y `base` no coincidieran con lo guardado y
daría conflictos y avisos falsos.

**Solo en el cliente** existen además `action` (un botón por fila, sin
datos), `remote-select` (buscador escrito en el front; lo sustituye `LOOKUP`)
y renderizadores propios. El servidor no los declara.

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

## 3. Pruebas

| Archivo | Qué cubre |
|---|---|
| `tests/postgres/password.test.ts` (11) | La marca en lista, fila, respuesta y conflicto; distinta por fila; filtro ignorado y orden rechazado; sin `hash` no arranca; el hash con su contexto, el handler solo ve el hash; alta obligatoria; longitud, vaciar y marca rechazadas; conflicto y aviso sobre la marca; booleano de ida y vuelta y su filtro |
| `tests/grid/tipos.test.ts` (T-1 a T-5) | Puntos y casilla al cargar, sin rastro del hash en la página; editor vacío que no cambia nada; contraseña nueva que no llega al borrador y se guarda; contraseña corta marcada; casilla con clic, deshacer, rehacer y guardado; copiar una contraseña da vacío |
