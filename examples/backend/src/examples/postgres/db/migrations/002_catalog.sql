-- Un campo de cada tipo en la hoja de productos, y el recurso externo de la
-- columna lookup (SB-21): los usuarios que pueden ser responsables.
-- Se puede correr sobre una base ya sembrada con 001: solo agrega.

CREATE TABLE IF NOT EXISTS users (
	id      text PRIMARY KEY,
	name    text NOT NULL,
	email   text NOT NULL UNIQUE,
	avatar  text,
	active  boolean NOT NULL DEFAULT true
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url    text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS owner_id     text REFERENCES users (id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS launch_date  date;
ALTER TABLE products ADD COLUMN IF NOT EXISTS restocked_at timestamp;

-- La vista agrega las columnas nuevas al final (CREATE OR REPLACE solo admite eso).
CREATE OR REPLACE VIEW v_products AS
	SELECT id, name, sku, price, stock, status, image_url, owner_id, launch_date, restocked_at
	FROM products
	WHERE deleted_at IS NULL;
