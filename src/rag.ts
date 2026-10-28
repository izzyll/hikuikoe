import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { embed } from './ollama';
import type { RagDocument, RagHit, Settings } from './types';

interface Chunk {
  docId: string;
  source: string;
  text: string;
  vector: number[];
}

interface Store {
  documents: RagDocument[];
  chunks: Chunk[];
}

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;

const storeFile = () => path.join(app.getPath('userData'), 'rag-store.json');
let store: Store | null = null;

function load(): Store {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Store;
  } catch {
    store = { documents: [], chunks: [] };
  }
  return store;
}

function save() {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(store));
}

async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  // Las librerías se cargan con require recién al necesitarlas, para no demorar el arranque.
  if (ext === '.pdf') {
    // Se importa lib/ directamente: el index de pdf-parse 1.x ejecuta un test de debug al cargarse.
    const pdfParse: typeof import('pdf-parse') = require('pdf-parse/lib/pdf-parse.js');
    return (await pdfParse(buffer)).text;
  }
  if (ext === '.docx') {
    const mammoth: typeof import('mammoth') = require('mammoth');
    return (await mammoth.extractRawText({ buffer })).value;
  }
  if (ext === '.html' || ext === '.htm') {
    return buffer
      .toString('utf8')
      .replace(/<(script|style|button|select|textarea|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }
  return buffer.toString('utf8');
}

function chunkText(text: string) {
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const paragraphs = clean.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > CHUNK_SIZE && current) {
      chunks.push(current.trim());
      current = current.slice(-CHUNK_OVERLAP) + '\n\n' + p;
    } else {
      current = current ? current + '\n\n' + p : p;
    }
    while (current.length > CHUNK_SIZE * 1.5) {
      chunks.push(current.slice(0, CHUNK_SIZE).trim());
      current = current.slice(CHUNK_SIZE - CHUNK_OVERLAP);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export async function addText(name: string, text: string, cfg: Settings) {
  const store = load();
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error(`"${name}" no tiene texto extraíble`);

  const id = crypto.randomUUID();
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += 16) {
    // nomic-embed-text espera prefijos de tarea para documentos y consultas.
    vectors.push(...(await embed(cfg, chunks.slice(i, i + 16).map((c) => `search_document: ${c}`))));
  }

  store.documents.push({ id, name, chunks: chunks.length, addedAt: Date.now() });
  chunks.forEach((text, i) => store.chunks.push({ docId: id, source: name, text, vector: vectors[i] }));
  save();
}

export async function addFile(filePath: string, cfg: Settings) {
  await addText(path.basename(filePath), await extractText(filePath), cfg);
}

export function removeDocument(id: string) {
  const store = load();
  store.documents = store.documents.filter((d) => d.id !== id);
  store.chunks = store.chunks.filter((c) => c.docId !== id);
  save();
  return listDocuments();
}

export function listDocuments() {
  return load().documents;
}

function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Si todo el perfil cabe holgado en el contexto (p. ej. solo un CV), se envía completo:
// da mejores respuestas que quedarse con los k fragmentos más parecidos.
const SMALL_CORPUS_CHARS = 8000;

export async function search(query: string, cfg: Settings, k = 5): Promise<RagHit[]> {
  const { chunks } = load();
  if (!chunks.length) return [];
  const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
  if (totalChars <= SMALL_CORPUS_CHARS) return chunks.map((c) => ({ source: c.source, text: c.text, score: 1 }));

  const [q] = await embed(cfg, [`search_query: ${query}`]);
  return chunks
    .map((c) => ({ source: c.source, text: c.text, score: cosine(q, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
