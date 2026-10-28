// Tipos compartidos entre el proceso principal, el preload y el renderer (solo tipos: no genera JS).

export type ApiProvider = 'groq' | 'cerebras' | 'custom';
export type Provider = 'ollama' | ApiProvider;
// '' = detectar el idioma automáticamente.
export type Language = 'spanish' | 'english' | '';
// 'presentation': presentas o participas en una reunión y te hacen preguntas; 'interview': entrevista de trabajo.
export type Mode = 'presentation' | 'interview';

export interface Settings {
  ollamaUrl: string;
  chatModel: string;
  embedModel: string;
  provider: Provider;
  apiModels: Record<ApiProvider, string>;
  apiKeys: Record<ApiProvider, string>;
  customBaseUrl: string;
  whisperModel: string;
  sttProvider: 'local' | 'groq';
  cloudWhisperModel: string;
  language: Language;
  autoAnswer: boolean;
  ragTopK: number;
  mode: Mode;
  // Tema de la reunión o cargo al que se postula: da contexto al modelo y vocabulario a Whisper.
  topic: string;
  extraInstructions: string;
  opacity: number;
}

// Los mapas por proveedor se fusionan con los guardados, así que alcanza con mandar una entrada.
export type SettingsPatch = Partial<Omit<Settings, 'apiModels' | 'apiKeys'>> & {
  apiModels?: Partial<Settings['apiModels']>;
  apiKeys?: Partial<Settings['apiKeys']>;
};

export interface ProviderInfo {
  name: string;
  baseUrl: string;
  keysUrl?: string;
}

export interface OllamaStatus {
  online: boolean;
  chatModel: boolean;
  embedModel: boolean;
  models: string[];
}

export interface RagDocument {
  id: string;
  name: string;
  chunks: number;
  addedAt: number;
}

export interface RagHit {
  source: string;
  text: string;
  score: number;
}

export interface LlmTestResult {
  firstTokenMs: number | null;
  totalMs: number;
  chars: number;
}

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  source: string;
  message: string;
}

export interface ModelProgress {
  file: string;
  progress: number;
}

type Unsubscribe = () => void;
type Listener<Args extends unknown[]> = (cb: (...args: Args) => void) => Unsubscribe;

// Lo que el preload expone en `window.api`.
export interface Api {
  getSettings(): Promise<Settings>;
  setSettings(patch: SettingsPatch): Promise<Settings>;

  minimize(): Promise<void>;
  close(): Promise<void>;
  setOpacity(value: number): Promise<void>;

  ollamaStatus(): Promise<OllamaStatus>;
  llmProviders(): Promise<Record<ApiProvider, ProviderInfo>>;
  llmModels(): Promise<string[]>;
  llmTest(): Promise<LlmTestResult>;
  transcribeCloud(samples: Float32Array): Promise<string>;
  openExternal(url: string): Promise<void>;

  listDocs(): Promise<RagDocument[]>;
  addFiles(): Promise<RagDocument[]>;
  addText(name: string, text: string): Promise<RagDocument[]>;
  removeDoc(id: string): Promise<RagDocument[]>;
  onRagProgress: Listener<[message: string]>;
  onModelProgress: Listener<[progress: ModelProgress]>;

  generateAnswer(id: number, question: string, transcript: string): Promise<void>;
  cancelAnswer(): Promise<void>;
  onAnswerToken: Listener<[id: number, token: string]>;
  onAnswerDone: Listener<[id: number]>;
  onAnswerError: Listener<[id: number, message: string]>;

  onLog: Listener<[entry: LogEntry]>;
  onShortcutAnswer: Listener<[]>;
  onShortcutToggleListen: Listener<[]>;
  onShortcutClear: Listener<[]>;
}

// Mensajes entre el renderer y el worker de Whisper.
export type WhisperRequest =
  | { type: 'load'; model: string; language: Language }
  | { type: 'transcribe'; id: number; audio: Float32Array };

export type WhisperResponse =
  | { type: 'progress'; file: string; progress: number }
  | { type: 'ready'; device: string }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; message: string };

declare global {
  interface Window {
    api: Api;
  }
}
