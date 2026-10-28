import type { OllamaStatus, Settings } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  cfg: Settings;
  messages: ChatMessage[];
  signal: AbortSignal;
  onToken: (token: string) => void;
}

export async function status(cfg: Settings): Promise<OllamaStatus> {
  try {
    const res = await fetch(`${cfg.ollamaUrl}/api/tags`);
    const { models } = (await res.json()) as { models: { name: string }[] };
    const names = models.map((m) => m.name);
    const has = (model: string) => names.some((n) => n === model || n === `${model}:latest`);
    return { online: true, chatModel: has(cfg.chatModel), embedModel: has(cfg.embedModel), models: names };
  } catch {
    return { online: false, chatModel: false, embedModel: false, models: [] };
  }
}

export async function embed(cfg: Settings, texts: string[]): Promise<number[][]> {
  const res = await fetch(`${cfg.ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.embedModel, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama embed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { embeddings: number[][] }).embeddings;
}

export async function chat({ cfg, messages, signal, onToken }: ChatOptions) {
  const res = await fetch(`${cfg.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: cfg.chatModel,
      stream: true,
      keep_alive: '30m',
      options: { temperature: 0.4, num_ctx: 8192 },
      messages,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama chat: ${res.status} ${await res.text()}`);

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      if (data.message?.content) onToken(data.message.content);
    }
  }
}
