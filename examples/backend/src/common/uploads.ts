/**
 * Archivos subidos de los ejemplos (SB-30): una carpeta por ejemplo dentro de
 * `uploads/`, servida en `/uploads`. En otra app sería un bucket con el mismo
 * `save`.
 */
import { diskStorage } from '@spreadbase/server';
import { env } from '../config/env.ts';

/** El destino de un ejemplo: `uploads/<nombre>`, visto en `<PUBLIC_URL>/uploads/<nombre>`. */
export const uploadsFor = (name: string) => diskStorage({ dir: `${env.uploadsDir}/${name}`, publicUrl: `${env.publicUrl}/uploads/${name}` });

/** Sirve todo lo subido. Los ejemplos no tienen sesión; una app real pondría aquí su middleware. */
export const serveUploads = () => diskStorage({ dir: env.uploadsDir, publicUrl: `${env.publicUrl}/uploads` }).serve();
