import cors from 'cors';
import express from 'express';
import registerRoutes from '../core/api/index.js';

const app = express();
app.use(cors({ origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5380').split(',') }));
// Un lote con miles de filas supera el límite por defecto (100 kB).
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
registerRoutes(app);

app.use((req, res) => res.status(404).json({ error: { code: 'route_not_found', message: `No existe ${req.method} ${req.path}` } }));

const port = Number(process.env.PORT ?? 4300);
app.listen(port, () => console.log(`Tienda (Postgres): http://localhost:${port}/api/products/sheet/schema`));
