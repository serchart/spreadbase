import { env } from '$env/dynamic/public';

/** URL base del backend del playground. Ver `.env.example`. */
export const API_URL = (env.PUBLIC_API_URL || 'http://localhost:4100').replace(/\/$/, '');
