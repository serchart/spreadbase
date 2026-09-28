/**
 * Entorno de pruebas. Todo apunta a servidores encendidos por separado; las
 * pruebas no los arrancan (doc 09 §1.3).
 */
export const API_URL = process.env.TEST_API_URL ?? 'http://localhost:4100';
export const FRONT_URL = process.env.TEST_FRONT_URL ?? 'http://localhost:5180';

/** Sin latencia simulada: se prueban reglas, no tiempos. */
export const NO_LATENCY = { 'x-latency': '0' } as const;
