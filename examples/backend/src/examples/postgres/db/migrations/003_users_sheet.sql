-- La hoja de usuarios: contraseña (SB-22) y rol. El hash lo pone SpreadBase al
-- guardar, con la función `hash` de la columna; aquí solo hay una columna de texto.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'ejecutivo'
	CHECK (role IN ('admin', 'supervisor', 'ejecutivo'));
