# tests/engine — motor y protocolo del servidor

Cubre `@spreadbase/server` contra `apps/demo` encendida: lectura por tramos,
`locate`, el lote de guardado con concurrencia por campo (field · merge/strict ·
bajas) e idempotencia.

Los mismos casos pasaban en OpenCollect antes de la extracción; son la red de
la migración.

## Entorno

- Demo encendida: `cd <SpreadBase> && PORT=4050 npx tsx watch apps/demo/src/index.ts`,
  o `npm run demo` con `PORT=4050`.
- La semilla vive en memoria: reiniciar la demo la reinicia.

## Correr

```bash
cd tests && npm test
```

23 casos: 22 pasan y 1 se omite (el de política `strict`) porque la demo
corre en `merge`. Para cubrirlo, arranca la demo con
`SANDBOX_REMOTE_CHANGES=strict` y corre la suite otra vez.
