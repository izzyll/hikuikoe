import type { WebContents } from 'electron';
import type { LogLevel } from './types';

// Registro de eventos que se muestra en la vista En vivo (llamadas a APIs, límites, errores, respaldos).
let target: WebContents | null = null;

export function setTarget(webContents: WebContents) {
  target = webContents;
}

function log(level: LogLevel, source: string, message: string) {
  console.log(`[${source}] ${message}`);
  if (target && !target.isDestroyed()) target.send('log', { at: Date.now(), level, source, message });
}

export const info = (source: string, message: string) => log('info', source, message);
export const ok = (source: string, message: string) => log('ok', source, message);
export const warn = (source: string, message: string) => log('warn', source, message);
export const error = (source: string, message: string) => log('error', source, message);

// Resume los límites de Groq/OpenAI que vienen en las cabeceras de cada respuesta.
export function rateLimitSummary(headers: Headers) {
  const h = (k: string) => headers.get(`x-ratelimit-${k}`);
  const parts: string[] = [];
  if (h('remaining-requests')) parts.push(`${h('remaining-requests')}/${h('limit-requests')} req`);
  if (h('remaining-tokens')) parts.push(`${h('remaining-tokens')}/${h('limit-tokens')} tok`);
  return parts.length ? `quedan ${parts.join(', ')}` : '';
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: string | null,
  ) {
    super(message);
  }
}

// Convierte una respuesta HTTP fallida en un ApiError con un mensaje legible.
export async function apiError(name: string, res: Response) {
  let detail = await res.text();
  try {
    detail = JSON.parse(detail).error?.message || detail;
  } catch {}
  const retryAfter = res.headers.get('retry-after');
  const label = res.status === 429 ? 'límite de uso alcanzado' : res.status >= 500 ? 'API caída' : 'error';
  return new ApiError(
    `${name}: ${res.status} ${label}${retryAfter ? ` (reintentar en ${retryAfter} s)` : ''} — ${detail.slice(0, 160)}`,
    res.status,
    retryAfter,
  );
}

// Los errores capturados son `unknown`; esto los normaliza para leer name/message/status sin casts sueltos.
type CaughtError = Omit<Error, 'cause'> & { status?: number; cause?: { code?: string } };
export function asError(err: unknown): CaughtError {
  return (err instanceof Error ? err : new Error(String(err))) as CaughtError;
}
