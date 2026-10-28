// Se importa el bundle de navegador por ruta (el worker no resuelve paquetes de node_modules);
// TS no encuentra tipos junto a ese archivo, así que se toman los del paquete.
// @ts-expect-error TS7016: sin declaración para la ruta directa al bundle.
import * as transformersBundle from '../../node_modules/@huggingface/transformers/dist/transformers.min.js';
import type { AutomaticSpeechRecognitionPipeline, ProgressInfo } from '@huggingface/transformers';
import type { Language, WhisperRequest, WhisperResponse } from '../types';

const { pipeline, env } = transformersBundle as typeof import('@huggingface/transformers');

// Usa los binarios WASM de onnxruntime que vienen en node_modules en vez del CDN.
env.backends.onnx.wasm!.wasmPaths = new URL('../../node_modules/@huggingface/transformers/dist/', import.meta.url).href;
env.allowLocalModels = false;
// Las descargas pasan por el proceso principal, que las guarda en disco (ver src/hf-cache.ts).
env.remoteHost = 'hfcache://hf/';
env.useBrowserCache = false;

const post = (msg: WhisperResponse) => self.postMessage(msg);

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<void> | null = null;
let language: string | undefined;

async function load(model: string, lang: Language) {
  transcriber = null;
  language = lang || undefined;
  const progress = (p: ProgressInfo) => {
    if (p.status === 'progress') post({ type: 'progress', file: p.file, progress: p.progress });
  };

  let device: 'wasm' | 'webgpu' = 'wasm';
  const adapter = navigator.gpu && (await navigator.gpu.requestAdapter());
  if (adapter) device = 'webgpu';
  const encoder = adapter?.features.has('shader-f16') ? 'fp16' : 'fp32';

  let loaded: AutomaticSpeechRecognitionPipeline;
  try {
    loaded = await pipeline('automatic-speech-recognition', model, {
      device,
      dtype: device === 'webgpu' ? { encoder_model: encoder, decoder_model_merged: 'q4' } : 'q8',
      progress_callback: progress,
    });
  } catch (err) {
    if (device !== 'webgpu') throw err;
    device = 'wasm';
    loaded = await pipeline('automatic-speech-recognition', model, { device, dtype: 'q8', progress_callback: progress });
  }

  transcriber = loaded;
  // Calentamiento para que la primera transcripción real no tarde de más.
  await transcriber(new Float32Array(16000), { language, task: 'transcribe' });
  post({ type: 'ready', device });
}

async function transcribe(id: number, audio: Float32Array) {
  // Si llega audio mientras el modelo aún carga, espera en vez de fallar.
  await loading;
  if (!transcriber) throw new Error('el modelo no está cargado');
  const out = await transcriber(audio, { language, task: 'transcribe', chunk_length_s: 30 });
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
  post({ type: 'result', id, text: text.trim() });
}

self.onmessage = async ({ data }: MessageEvent<WhisperRequest>) => {
  try {
    if (data.type === 'load') await (loading = load(data.model, data.language));
    else if (data.type === 'transcribe') await transcribe(data.id, data.audio);
  } catch (err) {
    post({ type: 'error', id: data.type === 'transcribe' ? data.id : undefined, message: (err as Error)?.message || String(err) });
  }
};
