# SpreadBase — reglas para agentes

## Verificación

- `npx tsc -p packages/<nombre>` por paquete, o `npm run check -w @spreadbase/demo` para la demo.
- Pruebas E2E (API real contra la demo encendida): `cd tests && npm test`.
  La demo: `PORT=4050 npx tsx watch apps/demo/src/index.ts`. **Los tests la reinician.**

## Convenciones

- Los paquetes se distribuyen como TypeScript en crudo (sin build); los
  `exports` de cada package.json apuntan a `src/index.ts`.
- Las decisiones van numeradas SB-1… en `docs/01-diseno.md`.
- Un cambio de comportamiento lleva su caso en `tests/<módulo>/`.
