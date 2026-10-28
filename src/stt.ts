import { PROVIDERS } from './llm';
import * as log from './logger';
import type { Language, Settings } from './types';

const LANGUAGE_CODES: Partial<Record<Language, string>> = { spanish: 'es', english: 'en' };

// PCM 16-bit mono a 16 kHz: ~32 KB por segundo de audio, liviano para subir.
function encodeWav(samples: Float32Array, sampleRate = 16000) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

// Cada modelo de Whisper en Groq tiene su propio límite (20 req/min): con el respaldo se duplica la capacidad.
const FALLBACK_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];

export async function transcribeGroq(cfg: Settings, samples: Float32Array): Promise<string> {
  const apiKey = cfg.apiKeys.groq;
  if (!apiKey) throw new Error('Falta la API key de Groq (Ajustes → Proveedor de respuestas → Groq)');

  const wav = encodeWav(samples);
  const models = [cfg.cloudWhisperModel, ...FALLBACK_MODELS.filter((m) => m !== cfg.cloudWhisperModel)];
  for (let i = 0; ; i++) {
    try {
      return await requestTranscription(cfg, apiKey, wav, models[i], samples.length / 16000);
    } catch (e) {
      const err = log.asError(e);
      if (err.status !== 429 || i === models.length - 1) {
        log.error('STT', err.message);
        throw err;
      }
      log.warn('STT', `${err.message} → probando respaldo ${models[i + 1]}`);
    }
  }
}

async function requestTranscription(cfg: Settings, apiKey: string, wav: Buffer, model: string, seconds: number) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const languageCode = LANGUAGE_CODES[cfg.language];
  if (languageCode) form.append('language', languageCode);
  // El prompt sesga a Whisper hacia el vocabulario esperado (nombres de tecnologías, del proyecto, cargo).
  if (cfg.topic) form.append('prompt', cfg.mode === 'interview' ? `Entrevista de trabajo para ${cfg.topic}.` : `${cfg.topic}.`);

  log.info('STT', `→ Groq ${model} (${seconds.toFixed(1)} s de audio)`);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${PROVIDERS.groq.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const err = log.asError(e);
    const reason = err.name === 'TimeoutError' ? 'sin respuesta en 15 s' : err.cause?.code || err.message;
    throw new log.ApiError(`Groq STT: sin conexión o API caída (${reason})`, 0);
  }
  if (!res.ok) throw await log.apiError('Groq STT', res);
  const text = ((await res.json()) as { text: string }).text.trim();
  log.ok('STT', `← ${Date.now() - started} ms ${log.rateLimitSummary(res.headers)}`);
  return text;
}
