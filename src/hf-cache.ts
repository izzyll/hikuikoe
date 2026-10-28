import { app, protocol, net } from 'electron';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';
import type { ModelProgress } from './types';

type OnProgress = (progress: ModelProgress) => void;

// Los modelos de Whisper se descargan a disco desde el proceso principal y se sirven al worker
// por hfcache://. La Cache API de Chromium falla con archivos de cientos de MB y así, además,
// la app funciona sin internet una vez descargado el modelo.
const SCHEME = 'hfcache';
const REMOTE = 'https://huggingface.co/';

const cacheDir = () => path.join(app.getPath('userData'), 'hf-cache');
const inFlight = new Map<string, Promise<number>>();

export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

async function download(remotePath: string, file: string, onProgress: OnProgress) {
  const res = await fetch(REMOTE + remotePath);
  if (!res.ok || !res.body) return res.status;

  const total = Number(res.headers.get('content-length')) || 0;
  let loaded = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => {
    loaded += chunk.length;
    if (total && Date.now() - lastReport > 250) {
      lastReport = Date.now();
      onProgress({ file: remotePath, progress: (loaded / total) * 100 });
    }
  });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part`;
  await pipeline(body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  onProgress({ file: remotePath, progress: 100 });
  return 200;
}

export function handle(onProgress: OnProgress) {
  protocol.handle(SCHEME, async (request) => {
    const remotePath = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    const file = path.join(cacheDir(), ...remotePath.split('/'));
    const headers = { 'Access-Control-Allow-Origin': '*' };

    if (!file.startsWith(cacheDir()) || remotePath.includes('..')) return new Response('', { status: 400, headers });

    if (!fs.existsSync(file)) {
      if (!inFlight.has(file)) {
        inFlight.set(file, download(remotePath, file, onProgress).finally(() => inFlight.delete(file)));
      }
      try {
        const status = await inFlight.get(file);
        if (status !== 200) return new Response('', { status, headers });
      } catch (err) {
        return new Response(String(err), { status: 502, headers });
      }
    }

    const res = await net.fetch(pathToFileURL(file).href);
    return new Response(res.body, {
      status: 200,
      headers: { ...headers, 'Content-Length': String(fs.statSync(file).size) },
    });
  });
}
