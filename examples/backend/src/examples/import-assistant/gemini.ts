/**
 * Un adaptador mínimo de Gemini a `ImportLLM`, con `fetch` (sin SDK). Opcional:
 * el ejemplo lo usa solo con `IMPORT_ASSISTANT_LLM=gemini` y `GEMINI_API_KEY`. Muestra la forma: cada app
 * escribe el suyo (Aggy, con `@google/genai`).
 *
 * - `generateStructured` → `generateContent` con `responseSchema`.
 * - `chat` → `generateContent` con `functionDeclarations`; las llamadas del
 *   modelo vuelven como `llamadas` y los resultados de las tools como
 *   `functionResponse`.
 */
import type { ImportLLM, JsonSchema, LLMMensaje, LLMParte } from '@spreadbase/server';

type Part = Record<string, unknown>;

/** Gemini acepta un subconjunto de OpenAPI: sin `additionalProperties`, un solo tipo, sin esquemas vacíos. */
function sanitize(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(sanitize);
	if (!schema || typeof schema !== 'object') return schema;
	const s = { ...(schema as Record<string, unknown>) };
	delete s.additionalProperties;
	delete s.minimum;
	delete s.maximum;
	if (Array.isArray(s.type)) s.type = s.type[0];
	if (!s.type && !s.properties && !s.items) s.type = 'string';
	for (const key of ['properties', 'items']) {
		if (s[key] && key === 'properties') s[key] = Object.fromEntries(Object.entries(s[key] as object).map(([k, v]) => [k, sanitize(v)]));
		else if (s[key]) s[key] = sanitize(s[key]);
	}
	return s;
}

const parte = (p: LLMParte): Part =>
	p.tipo === 'texto'
		? { text: p.texto }
		: typeof p.datos === 'string'
			? { fileData: { fileUri: p.datos, mimeType: p.mime ?? 'image/png' } }
			: { inlineData: { mimeType: p.mime ?? 'image/png', data: p.datos.toString('base64') } };

function contents(mensajes: LLMMensaje[]) {
	return mensajes.map((m) => {
		if (m.rol === 'usuario') return { role: 'user', parts: m.partes.map(parte) };
		if (m.rol === 'agente') {
			// Las partes del modelo tal cual (con sus thoughtSignature, que Gemini 3 exige de vuelta).
			if (Array.isArray(m.meta)) return { role: 'model', parts: m.meta as Part[] };
			const parts: Part[] = [];
			if (m.texto) parts.push({ text: m.texto });
			for (const l of m.llamadas ?? []) parts.push({ functionCall: { name: l.nombre, args: l.args } });
			return { role: 'model', parts };
		}
		return {
			role: 'user',
			parts: [
				{ functionResponse: { name: m.nombre, response: { resultado: m.resultado } } },
				...(m.imagenes ?? []).map((img) => ({ inlineData: { mimeType: 'image/png', data: img.toString('base64') } }))
			]
		};
	});
}

export function geminiLLM(options: { apiKey: string; model?: string }): ImportLLM {
	const model = options.model ?? 'gemini-2.5-flash';
	async function call(body: unknown, modelo?: string) {
		const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo ?? model}:generateContent`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
			body: JSON.stringify(body)
		});
		const json = (await res.json()) as any;
		if (!res.ok) throw new Error(`Gemini ${res.status}: ${json?.error?.message ?? 'error'}`);
		return (json.candidates?.[0]?.content?.parts ?? []) as Part[];
	}
	return {
		async generateStructured({ instrucciones, imagenes, texto, schema, modelo }) {
			const parts: Part[] = [{ text: instrucciones }, ...(texto ? [{ text: `Texto de apoyo:\n${texto}` }] : [])];
			for (const img of imagenes) parts.push(parte({ tipo: 'imagen', datos: img }));
			const out = await call(
				{ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', responseSchema: sanitize(schema as JsonSchema) } },
				modelo
			);
			return JSON.parse(out.map((p) => p.text ?? '').join('') || '{}');
		},
		async chat({ sistema, mensajes, tools, modelo }) {
			const out = await call(
				{
					systemInstruction: { parts: [{ text: sistema }] },
					contents: contents(mensajes),
					tools: [{ functionDeclarations: tools.map((t) => ({ name: t.nombre, description: t.descripcion, parameters: sanitize(t.parametros) })) }]
				},
				modelo
			);
			// Los pensamientos (`thought: true`) no son respuesta para la persona.
			const texto = out
				.filter((p) => !p.thought)
				.map((p) => p.text ?? '')
				.join('')
				.trim();
			const llamadas = out.filter((p) => p.functionCall).map((p) => ({ nombre: (p.functionCall as any).name, args: (p.functionCall as any).args ?? {} }));
			return { ...(texto ? { texto } : {}), ...(llamadas.length ? { llamadas } : {}), meta: out };
		}
	};
}
