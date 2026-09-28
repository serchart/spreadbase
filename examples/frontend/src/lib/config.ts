import { env } from '$env/dynamic/public';

/** URL base del servidor de ejemplos (`npm run back`). Ver `.env.example`. */
export const API_URL = (env.PUBLIC_API_URL || 'http://localhost:4100').replace(/\/$/, '');
