import * as ollama from './ollama';
import * as log from './logger';
import type { ChatMessage, ChatOptions } from './ollama';
import type { ApiProvider, Language, LlmTestResult, Mode, ProviderInfo, RagHit, Settings } from './types';

// APIs compatibles con OpenAI con capa gratuita y alta velocidad de generación.
export const PROVIDERS: Record<ApiProvider, ProviderInfo> = {
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keysUrl: 'https://console.groq.com/keys' },
  cerebras: { name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', keysUrl: 'https://cloud.cerebras.ai' },
  custom: { name: 'Personalizado (compatible OpenAI)', baseUrl: '' },
};

const LANGUAGE_RULES: Partial<Record<Language, string>> = {
  spanish: 'Responde siempre en español, aunque los documentos estén en otro idioma.',
  english: 'Answer always in English, even if the documents are in Spanish.',
};

// Lo que cambia entre modos: a quién se asiste, qué se escucha y reglas de formato propias.
const MODES: Record<Mode, { intro: (topic: string) => string; docs: string; rules: string[] }> = {
  presentation: {
    intro: (topic) => `Eres un asistente en tiempo real para alguien que presenta o participa en una reunión (presentación de proyectos, demo, revisión técnica, reunión con clientes o equipo).
Escuchas lo que dicen los demás participantes y sugieres qué responder, en primera persona, como si fueras quien presenta. Si se habla del proyecto o del equipo, usa "nosotros".${topic ? `\n\nTema de la reunión: ${topic}` : ''}`,
    docs: 'Material de apoyo (presentación, documentación del proyecto, notas, datos). Es la fuente de verdad: basa la respuesta en él y cita los datos concretos que tenga (funcionalidades, decisiones, arquitectura, plazos, resultados). Nunca inventes funcionalidades, decisiones, clientes ni cifras que no estén aquí. Si la respuesta no está en el material, responde con conocimiento general marcado como tal, o sugiere comprometerse a confirmarlo después ("lo reviso y te lo envío").',
    rules: [
      'Si es una pregunta técnica o de cómo funciona algo, responde con lo que dice el material y un ejemplo breve; código solo si lo piden.',
      'Si es una objeción, crítica o duda sobre una decisión, reconoce el punto, explica el porqué de la decisión y menciona el siguiente paso o alternativa.',
      'Si preguntan por plazos, costos, riesgos o próximos pasos que no estén en el material, no los inventes: usa un marcador o sugiere confirmarlo.',
      'Si lo último que se dijo no es una pregunta, resume en una línea qué están pidiendo o qué conviene comentar.',
    ],
  },
  interview: {
    intro: (topic) => `Eres un asistente en tiempo real para un postulante en una entrevista de trabajo.
Escuchas lo que dice el entrevistador y sugieres qué responder, en primera persona, como si fueras el postulante.${topic ? `\n\nCargo al que postula: ${topic}` : ''}`,
    docs: 'Información real del postulante (CV, proyectos, notas). Úsala para personalizar la respuesta con experiencias, tecnologías y logros concretos. Nunca inventes empresas, proyectos, cifras ni experiencia que no estén aquí. Si la pregunta pide una experiencia que no aparece, responde con conocimiento técnico general y usa marcadores entre corchetes como [tu proyecto] o [resultado] para que el postulante los complete.',
    rules: [
      'Si es una pregunta técnica, incluye la definición precisa y un ejemplo breve; código solo si lo piden.',
      'Si es conductual (cuéntame de una vez que...), usa estructura STAR con un caso real del postulante.',
      'Si lo último que dijo el entrevistador no es una pregunta, resume en una línea qué está pidiendo o qué conviene comentar.',
    ],
  },
};

function buildSystemPrompt(cfg: Settings, context: RagHit[]) {
  const mode = MODES[cfg.mode] || MODES.presentation;
  const docs = context.length
    ? context.map((c, i) => `[${i + 1}] (${c.source})\n${c.text}`).join('\n\n')
    : '(sin documentos cargados)';
  const rules = [
    LANGUAGE_RULES[cfg.language] || 'Responde en el mismo idioma en que se hizo la pregunta.',
    'Primera línea: la idea central en una frase, en negrita.',
    'Luego 3 a 5 viñetas cortas que se puedan leer de un vistazo y decir en voz alta.',
    ...mode.rules,
    'Sé breve: el usuario lo lee mientras habla.',
    'Cifras (porcentajes, tiempos, montos, cantidades): úsalas solo si aparecen textualmente en los documentos. Si no, escribe un marcador como [X %] o [métrica] para completarlo. Nunca inventes resultados.',
  ];

  return `${mode.intro(cfg.topic)}

${mode.docs}

${docs}

Formato de respuesta:
${rules.map((r) => `- ${r}`).join('\n')}${cfg.extraInstructions ? `\n\nInstrucciones adicionales: ${cfg.extraInstructions}` : ''}`;
}

function apiProvider(cfg: Settings): ApiProvider {
  if (cfg.provider === 'ollama') throw new Error('El proveedor actual es Ollama, no una API');
  return cfg.provider;
}

function apiConfig(cfg: Settings) {
  const id = apiProvider(cfg);
  const provider = PROVIDERS[id];
  const baseUrl = (id === 'custom' ? cfg.customBaseUrl : provider.baseUrl).replace(/\/+$/, '');
  const apiKey = cfg.apiKeys[id];
  const model = cfg.apiModels[id];
  if (!baseUrl) throw new Error('Falta la URL base de la API');
  if (!apiKey && id !== 'custom') throw new Error(`Falta la API key de ${provider.name}`);
  if (!model) throw new Error('Falta el modelo de la API');
  return { baseUrl, apiKey, model };
}

// Modelos de respaldo cuando el principal devuelve 429: en Groq cada modelo tiene su propio límite por minuto.
const FALLBACK_MODELS: Partial<Record<ApiProvider, string[]>> = { groq: ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'], cerebras: ['qwen-3.8-27b'] };

async function chatOpenAI({ cfg, messages, signal, onToken }: ChatOptions) {
  const { baseUrl, apiKey, model } = apiConfig(cfg);
  const name = PROVIDERS[apiProvider(cfg)].name;
  const body: Record<string, unknown> = { model, messages, stream: true, temperature: 0.4, max_tokens: 700 };
  // Los gpt-oss razonan antes de responder; con esfuerzo bajo el primer token llega mucho antes.
  if (/gpt-oss/.test(model)) body.reasoning_effort = 'low';

  log.info('LLM', `→ ${name} ${model}`);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
      signal,
      body: JSON.stringify(body),
    });
  } catch (e) {
    const err = log.asError(e);
    if (err.name === 'AbortError') throw err;
    throw new log.ApiError(`${name}: sin conexión o API caída (${err.cause?.code || err.message})`, 0);
  }
  if (!res.ok || !res.body) throw await log.apiError(name, res);
  log.info('LLM', `← ${res.status} en ${Date.now() - started} ms ${log.rateLimitSummary(res.headers)}`);

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, '').trim();
      if (!data || data === '[DONE]' || !line.startsWith('data:')) continue;
      const json = JSON.parse(data);
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      const token = json.choices?.[0]?.delta?.content;
      if (token) onToken(token);
    }
  }
}

interface AnswerOptions {
  cfg: Settings;
  question: string;
  transcript: string;
  context: RagHit[];
  signal: AbortSignal;
  onToken: (token: string) => void;
}

export async function answer({ cfg, question, transcript, context, signal, onToken }: AnswerOptions) {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(cfg, context) },
    {
      role: 'user',
      content: `Transcripción reciente de la ${cfg.mode === 'interview' ? 'entrevista (voz del entrevistador)' : 'reunión (voz de los demás participantes)'}:\n"""${transcript}"""\n\nPregunta / intervención actual a responder:\n"""${question}"""`,
    },
  ];
  if (cfg.provider === 'ollama') {
    log.info('LLM', `→ Ollama ${cfg.chatModel}`);
    return ollama.chat({ cfg, messages, signal, onToken });
  }

  const provider = cfg.provider;
  const primary = cfg.apiModels[provider];
  const models = [primary, ...(FALLBACK_MODELS[provider] || []).filter((m) => m !== primary)];
  for (let i = 0; i < models.length; i++) {
    let emitted = false;
    try {
      await chatOpenAI({
        cfg: { ...cfg, apiModels: { ...cfg.apiModels, [provider]: models[i] } },
        messages,
        signal,
        onToken: (t) => { emitted = true; onToken(t); },
      });
      return;
    } catch (e) {
      const err = log.asError(e);
      // Solo se reintenta por límite de uso, y si todavía no se mostró parte de la respuesta.
      const canRetry = err.status === 429 && !emitted && i < models.length - 1;
      if (!canRetry) throw err;
      log.warn('LLM', `${err.message} → probando respaldo ${models[i + 1]}`);
    }
  }
}

export async function listApiModels(cfg: Settings): Promise<string[]> {
  const { baseUrl, apiKey } = apiConfig({ ...cfg, apiModels: { ...cfg.apiModels, [apiProvider(cfg)]: 'x' } });
  const res = await fetch(`${baseUrl}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const { data } = (await res.json()) as { data: { id: string }[] };
  return data.map((m) => m.id).sort();
}

// Mide cuánto tarda en llegar el primer token y la respuesta completa.
export async function test(cfg: Settings): Promise<LlmTestResult> {
  const started = Date.now();
  let firstToken: number | null = null;
  let text = '';
  await answer({
    cfg,
    question: '¿Qué es una API REST?',
    transcript: '¿Qué es una API REST?',
    context: [],
    signal: AbortSignal.timeout(60000),
    onToken: (t) => {
      firstToken ??= Date.now() - started;
      text += t;
    },
  });
  return { firstTokenMs: firstToken, totalMs: Date.now() - started, chars: text.length };
}
