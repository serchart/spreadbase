/**
 * El cerebro por omisión: el agente de siempre (`importAgent` sin `brain`). Analiza cada archivo con su
 * bucle (o con reglas si no hay `llm.chat`) y contesta el chat con el suyo. No reacciona a los demás
 * eventos. Existe para poder elegirlo explícitamente y como respaldo.
 */
import type { ImportBrain } from './types.ts';

export function cerebroBasico(): ImportBrain {
	return {
		nombre: 'basico',
		async manejar(evento, host) {
			if (evento.tipo === 'analizar') await host.basico.analizar(evento.archivo);
			else if (evento.tipo === 'chat') return { respuesta: await host.basico.chat(evento.texto) };
		}
	};
}
