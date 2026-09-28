-- Tablas del DOMINIO de la tienda. Nada aquí es requisito de SpreadBase:
-- ni columna de versión, ni trigger, ni tabla de cambios (SB-4). La tabla de
-- idempotencia (spreadbase_idempotency) la crea la librería sola (SB-18).

CREATE TABLE IF NOT EXISTS products (
	id          text PRIMARY KEY,
	name        text NOT NULL,
	sku         text NOT NULL UNIQUE,
	price       numeric(12, 2) NOT NULL CHECK (price >= 0),
	stock       integer NOT NULL DEFAULT 0,
	status      text NOT NULL DEFAULT 'draft',
	updated_by  text,
	deleted_at  timestamptz
);

-- Lo que ve la hoja: sin los eliminados (borrado lógico).
CREATE OR REPLACE VIEW v_products AS
	SELECT id, name, sku, price, stock, status
	FROM products
	WHERE deleted_at IS NULL;

-- Regla de negocio del ejemplo: historial de precios.
CREATE TABLE IF NOT EXISTS price_history (
	product_id text NOT NULL,
	old_price  numeric(12, 2),
	new_price  numeric(12, 2),
	changed_by text,
	changed_at timestamptz NOT NULL DEFAULT now()
);
