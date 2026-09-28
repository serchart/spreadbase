import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/**
 * Hash de contraseña con scrypt (en Node, sin dependencias). Lo que se guarda:
 * `scrypt$<sal>$<clave>`. En una app real puede ser bcrypt o argon2: a
 * SpreadBase solo le importa que la columna tenga su función `hash`.
 * @param {string} plain
 */
export async function hashPassword(plain) {
	const salt = randomBytes(16).toString('hex');
	const key = /** @type {Buffer} */ (await scryptAsync(plain, salt, 32));
	return `scrypt$${salt}$${key.toString('hex')}`;
}

/** Para el login: ¿esta contraseña corresponde a este hash? */
export async function verifyPassword(plain, stored) {
	const [, salt, hex] = String(stored).split('$');
	if (!salt || !hex) return false;
	const key = /** @type {Buffer} */ (await scryptAsync(plain, salt, 32));
	return timingSafeEqual(key, Buffer.from(hex, 'hex'));
}
