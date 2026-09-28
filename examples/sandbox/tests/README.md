# tests

Pruebas de OpenCollect. **Una prueba cuenta una historia de usuario** sobre un
módulo, y puede llamar a la API y manejar el navegador en la misma historia.
Reglas completas: `../docs/09-estrategia-pruebas.md`.

## Una sola vez

```bash
npm install
npx playwright install chromium
```

## Antes de correr

Backend y frontend encendidos, cada uno en su terminal (`--` los tests no los
arrancan):

```bash
cd ../backend && npm run dev
cd ../frontend && npm run dev
```

## Correr

```bash
npm test                 # todo
npm test -- sandbox      # un módulo (nombre de su directorio)
npm test -- sandbox/grid # un archivo
```

Variables para apuntar a otros servidores: `TEST_API_URL` y `TEST_FRONT_URL`.

## Dos políticas de concurrencia

El backend acepta `SANDBOX_REMOTE_CHANGES=merge|strict` (G-15). La suite salta
automáticamente lo que no aplica a la política activa. Para cubrir las dos:

```bash
cd ../backend && SANDBOX_REMOTE_CHANGES=strict SANDBOX_LOG=0 npm run dev
cd ../tests && npm test
```

## Estructura

| Directorio | Qué es |
|---|---|
| `support/` | Entorno de pruebas, cliente HTTP real, harness de Playwright (usuarios = contextos; consola y capturas por prueba), acceso al DataGrid |
| `sandbox/` | Módulo de casos + hoja de cálculo |
| `test-results/` | Capturas y consolas (no se versiona) |

## Nuevo módulo

Crea `tests/<módulo>/` con su `README.md` (escenarios y datos que asume) y sus
tests. El `README` debe decir cómo sembrar y reiniciar su base de pruebas.

## Artefactos

Cada prueba escribe en `test-results/<archivo>/<prueba>/`: una captura por
paso marcado y por fallo, y la consola de cada usuario del navegador. Entre las
consolas busca los grupos `[datagrid:…]` (debug del grid) y en el log del
backend los bloques `[batch]`, `[mutate]` e `[idempotency]`.
