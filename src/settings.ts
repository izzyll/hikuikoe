import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import type { Settings, SettingsPatch } from './types';

const DEFAULTS: Settings = {
  ollamaUrl: 'http://127.0.0.1:11434',
  chatModel: 'qwen2.5:7b',
  embedModel: 'nomic-embed-text',
  // Proveedor de las respuestas: 'ollama' (local) o una API compatible con OpenAI (ver PROVIDERS en llm.ts).
  provider: 'ollama',
  apiModels: { groq: 'openai/gpt-oss-120b', cerebras: 'gpt-oss-120b', custom: '' },
  apiKeys: { groq: '', cerebras: '', custom: '' },
  customBaseUrl: '',
  whisperModel: 'onnx-community/whisper-small',
  // Transcripción: 'local' (Whisper en la GPU con transformers.js) o 'groq' (API, usa la key de Groq).
  sttProvider: 'local',
  cloudWhisperModel: 'whisper-large-v3-turbo',
  language: 'spanish',
  autoAnswer: true,
  ragTopK: 5,
  mode: 'presentation',
  topic: '',
  extraInstructions: '',
  opacity: 0.94,
};

type Keys = Settings['apiKeys'];

const file = () => path.join(app.getPath('userData'), 'settings.json');
let cache: Settings | null = null;

// Las API keys se guardan cifradas con DPAPI (safeStorage) en vez de en texto plano.
const encrypt = (keys: Keys) =>
  Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v && safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(v).toString('base64')}` : v]));
function decryptOne(v: string | undefined) {
  if (!v?.startsWith('enc:')) return v;
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
  } catch {
    // Una key ilegible (p. ej. de otro usuario de Windows) se descarta sin perder el resto de los ajustes.
    return '';
  }
}
const decrypt = (keys: Partial<Keys>) => Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, decryptOne(v)]));

export function get(): Settings {
  if (cache) return cache;
  try {
    // `role` es el nombre anterior de `topic`, de cuando la app solo servía para entrevistas.
    const { role, ...saved } = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = {
      ...DEFAULTS,
      ...(role && { mode: 'interview', topic: role }),
      ...saved,
      apiModels: { ...DEFAULTS.apiModels, ...saved.apiModels },
      apiKeys: { ...DEFAULTS.apiKeys, ...decrypt(saved.apiKeys || {}) },
    };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache!;
}

export function set(patch: SettingsPatch): Settings {
  const current = get();
  const next: Settings = {
    ...current,
    ...patch,
    apiModels: { ...current.apiModels, ...patch.apiModels },
    apiKeys: { ...current.apiKeys, ...patch.apiKeys },
  };
  cache = next;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ ...next, apiKeys: encrypt(next.apiKeys) }, null, 2));
  return next;
}
