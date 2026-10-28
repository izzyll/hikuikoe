import type { ApiProvider, LogLevel, Mode, ProviderInfo, RagDocument, Settings, SettingsPatch, WhisperRequest, WhisperResponse } from '../types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Segment {
  text: string;
  at: number;
}

interface Timing {
  speechEndAt: number;
  sttMs: number | null;
  firstTokenMs: number | null;
}

const state = {
  settings: null as unknown as Settings, // se carga al inicio, antes de cualquier interacción
  listening: false,
  whisperReady: false,
  whisperModelLoaded: null as string | null,
  segments: [] as Segment[],
  answeredUpTo: 0, // índice del primer segmento aún sin responder
  answering: false,
  answerText: '',
  answerId: 0,
  currentQuestion: '',
  timing: { speechEndAt: 0, sttMs: null, firstTokenMs: null } as Timing,
  lastAuto: null as { startIndex: number; at: number } | null,
};

// ---------- UI helpers ----------

function setStatus(text: string, dot?: string) {
  $('status-text').textContent = text;
  $('status-dot').className = `dot ${dot || ''}`;
  console.log(`[status] ${text}`);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---------- Registro ----------

const LOG_MAX = 150;

function addLog(level: LogLevel, source: string, message: string, at = Date.now()) {
  const box = $('log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 20;
  const time = new Date(at).toLocaleTimeString('es', { hour12: false }) + `.${String(at % 1000).padStart(3, '0')}`;
  const row = document.createElement('div');
  row.innerHTML = `<span class="t">${time}</span> <span class="src">${escapeHtml(source)}</span> <span class="${level}">${escapeHtml(message)}</span>`;
  box.appendChild(row);
  while (box.children.length > LOG_MAX) box.firstElementChild!.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}
const log = {
  info: (src: string, msg: string) => addLog('info', src, msg),
  ok: (src: string, msg: string) => addLog('ok', src, msg),
  warn: (src: string, msg: string) => addLog('warn', src, msg),
  error: (src: string, msg: string) => addLog('error', src, msg),
};

window.api.onLog(({ at, level, source, message }) => addLog(level, source, message, at));
$('log-clear-btn').onclick = () => { $('log').innerHTML = ''; };
$('log-toggle-btn').onclick = () => {
  const hidden = $('log').classList.toggle('hidden');
  $('log-toggle-btn').textContent = hidden ? 'mostrar' : 'ocultar';
};

// Markdown mínimo: negritas, código, viñetas y bloques de código.
function renderMarkdown(md: string) {
  const parts = md.split(/```[\w-]*\n?/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${escapeHtml(part)}</code></pre>`;
      let html = '';
      let inList = false;
      for (const raw of part.split('\n')) {
        const line = escapeHtml(raw)
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>');
        const bullet = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
        if (bullet) {
          if (!inList) { html += '<ul>'; inList = true; }
          html += `<li>${bullet[1]}</li>`;
        } else {
          if (inList) { html += '</ul>'; inList = false; }
          if (line.trim()) html += `<p>${line}</p>`;
        }
      }
      if (inList) html += '</ul>';
      return html;
    })
    .join('');
}

function renderTranscript() {
  const box = $('transcript');
  if (!state.segments.length) {
    box.innerHTML = '<p class="muted">Esperando audio…</p>';
    return;
  }
  box.innerHTML = state.segments
    .slice(-30)
    .map((s, i, arr) => {
      const index = state.segments.length - arr.length + i;
      return `<p class="${index >= state.answeredUpTo ? 'pending' : ''}">${escapeHtml(s.text)}</p>`;
    })
    .join('');
  box.scrollTop = box.scrollHeight;
}

// ---------- Tabs ----------

document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
    if (tab.dataset.tab === 'settings') refreshOllamaStatus();
    if (tab.dataset.tab === 'profile') refreshDocs();
  });
});

$('min-btn').onclick = () => window.api.minimize();
$('close-btn').onclick = () => window.api.close();

// ---------- Whisper ----------

const worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
const postToWorker = (msg: WhisperRequest, transfer: Transferable[] = []) => worker.postMessage(msg, transfer);
let transcribeId = 0;
const pendingTranscriptions = new Map<number, (text: string) => void>();

worker.onmessage = ({ data }: MessageEvent<WhisperResponse>) => {
  if (data.type === 'progress') {
    // Lectura desde el caché en disco; la descarga real se informa vía onModelProgress.
    $('status-text').textContent = `Cargando ${data.file.split('/').pop()} ${Math.round(data.progress)}%`;
  } else if (data.type === 'ready') {
    state.whisperReady = true;
    log.ok('Whisper', `modelo local listo (${data.device})`);
    setStatus(state.listening ? `Escuchando (${data.device})` : `Whisper listo (${data.device})`, state.listening ? 'listening' : '');
  } else if (data.type === 'result') {
    pendingTranscriptions.get(data.id)?.(data.text);
    pendingTranscriptions.delete(data.id);
  } else if (data.type === 'error') {
    setStatus(`Error Whisper: ${data.message}`, 'error');
    log.error('Whisper', data.message);
    if (data.id != null) {
      pendingTranscriptions.get(data.id)?.('');
      pendingTranscriptions.delete(data.id);
    }
  }
};

window.api.onModelProgress(({ file, progress }) => {
  if (progress < 100) setStatus(`Descargando ${file.split('/').pop()} ${Math.round(progress)}%`, 'loading');
});

worker.onerror = (e) => {
  setStatus(`Error Whisper: ${e.message || 'no se pudo iniciar el worker'}`, 'error');
  log.error('Whisper', e.message || 'no se pudo iniciar el worker');
};

const LOCAL_TRANSCRIBE_TIMEOUT_MS = 30000;
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const cleanIpcError = (err: unknown) => errorMessage(err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// Alucinaciones típicas de Whisper con silencio o música de fondo.
const HALLUCINATIONS = [
  /subt[ií]tulos (realizados )?por/i,
  /amara\.org/i,
  /gracias por ver/i,
  /^\W*(muchas )?gracias\W*$/i,
  /^\W*thank you\W*$/i,
  /suscr[ií]bete/i,
  /thanks for watching/i,
  /^\W*(m+|uh+|ah+|eh+)?\W*$/i,
];

// Con transcripción en la nube no se carga Whisper local (libera VRAM), salvo como respaldo (force).
function ensureWhisper({ force = false } = {}) {
  if (!force && state.settings.sttProvider !== 'local') return;
  const { whisperModel, language } = state.settings;
  const key = `${whisperModel}|${language}`;
  if (state.whisperModelLoaded === key) return;
  state.whisperModelLoaded = key;
  state.whisperReady = false;
  setStatus('Cargando Whisper…', 'loading');
  log.info('Whisper', `cargando modelo local ${whisperModel.split('/').pop()}`);
  postToWorker({ type: 'load', model: whisperModel, language });
}

function transcribeLocal(audio: Float32Array) {
  return new Promise<string>((resolve) => {
    const id = ++transcribeId;
    const started = Date.now();
    // Si el worker se cuelga, la cola de transcripción no puede quedar esperando para siempre.
    const timer = setTimeout(() => {
      pendingTranscriptions.delete(id);
      log.error('Whisper', `sin respuesta en ${LOCAL_TRANSCRIBE_TIMEOUT_MS / 1000} s, segmento descartado`);
      resolve('');
    }, LOCAL_TRANSCRIBE_TIMEOUT_MS);
    pendingTranscriptions.set(id, (text) => {
      clearTimeout(timer);
      log.ok('Whisper', `transcrito localmente en ${Date.now() - started} ms`);
      resolve(text);
    });
    postToWorker({ type: 'transcribe', id, audio }, [audio.buffer]);
  });
}

async function transcribe(audio: Float32Array) {
  let text: string;
  if (state.settings.sttProvider === 'groq') {
    try {
      text = await window.api.transcribeCloud(audio);
    } catch (err) {
      setStatus(`Groq STT falló: ${cleanIpcError(err).slice(0, 80)}`, 'error');
      // Respaldo local solo si ya está cargado: esperar a que cargue bloquearía toda la cola.
      ensureWhisper({ force: true });
      if (!state.whisperReady) {
        log.warn('STT', 'Whisper local aún cargando como respaldo; este segmento se pierde');
        return '';
      }
      log.warn('STT', 'usando Whisper local como respaldo');
      text = await transcribeLocal(audio);
    }
  } else {
    text = await transcribeLocal(audio);
  }
  if (text && HALLUCINATIONS.some((re) => re.test(text))) {
    log.info('STT', `descartado (ruido/alucinación): "${text}"`);
    return '';
  }
  if (!text) log.info('STT', 'sin texto (silencio o ruido)');
  return text;
}

// ---------- Captura de audio + detección de voz ----------

const VAD = {
  minThreshold: 0.006, // RMS mínimo considerado voz
  noiseRatio: 3, // la voz debe superar N veces el ruido de fondo
  endSilenceMs: 500, // silencio que cierra un segmento (impacta directo en la latencia)
  maxSegmentMs: 20000, // corte forzado para no acumular demasiado
  minSpeechMs: 400, // descarta ruidos cortos
  preRollFrames: 10, // ~300 ms antes de detectar voz, para no comer la primera sílaba
};

let audio: { stream: MediaStream; ctx: AudioContext; node: AudioWorkletNode } | null = null;
let segmentFrames: Float32Array[] = [];
let preRoll: Float32Array[] = [];
let speechMs = 0;
let silenceMs = 0;
let inSpeech = false;
let noiseFloor = 0.002;
let transcribeQueue = Promise.resolve();

function rms(frame: Float32Array) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

function onFrame(frame: Float32Array, sampleRate: number) {
  const frameMs = (frame.length / sampleRate) * 1000;
  const level = rms(frame);
  const isVoice = level > Math.max(VAD.minThreshold, noiseFloor * VAD.noiseRatio);
  if (!isVoice) noiseFloor = noiseFloor * 0.98 + level * 0.02;

  if (!inSpeech) {
    preRoll.push(frame);
    if (preRoll.length > VAD.preRollFrames) preRoll.shift();
    if (isVoice) {
      inSpeech = true;
      segmentFrames = [...preRoll];
      preRoll = [];
      speechMs = frameMs;
      silenceMs = 0;
      onSpeechStart();
    }
    return;
  }

  segmentFrames.push(frame);
  if (isVoice) {
    speechMs += frameMs;
    silenceMs = 0;
  } else {
    silenceMs += frameMs;
  }

  const totalMs = segmentFrames.length * frameMs;
  if (silenceMs >= VAD.endSilenceMs || totalMs >= VAD.maxSegmentMs) {
    const frames = segmentFrames;
    const enoughSpeech = speechMs >= VAD.minSpeechMs;
    inSpeech = false;
    segmentFrames = [];
    // Momento en que el otro participante dejó de hablar: base para medir la latencia de la respuesta.
    const speechEndAt = Date.now() - silenceMs;
    if (enoughSpeech) flushSegment(frames, sampleRate, silenceMs >= VAD.endSilenceMs, speechEndAt);
    else setStatus('Escuchando', 'listening');
  }
}

async function resampleTo16k(frames: Float32Array[], sampleRate: number) {
  const length = frames.reduce((n, f) => n + f.length, 0);
  const joined = new Float32Array(length);
  let offset = 0;
  for (const f of frames) { joined.set(f, offset); offset += f.length; }
  if (sampleRate === 16000) return joined;

  const offline = new OfflineAudioContext(1, Math.ceil((length * 16000) / sampleRate), 16000);
  const buffer = offline.createBuffer(1, length, sampleRate);
  buffer.copyToChannel(joined, 0);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  return (await offline.startRendering()).getChannelData(0).slice();
}

function flushSegment(frames: Float32Array[], sampleRate: number, endedBySilence: boolean, speechEndAt: number) {
  setStatus('Transcribiendo…', 'listening');
  const seconds = frames.reduce((n, f) => n + f.length, 0) / sampleRate;
  log.info('Audio', `segmento de ${seconds.toFixed(1)} s${endedBySilence ? '' : ' (cortado por largo máximo)'}`);
  // Se encadenan en orden para que el texto no llegue desordenado. El catch es clave:
  // sin él, un solo error rechaza la cadena y todas las transcripciones siguientes se saltan.
  transcribeQueue = transcribeQueue
    .then(async () => {
      const audio16k = await resampleTo16k(frames, sampleRate);
      const sttStart = Date.now();
      const text = await transcribe(audio16k);
      const sttMs = Date.now() - sttStart;
      if (state.listening) setStatus('Escuchando', inSpeech ? 'speaking' : 'listening');
      if (!text) return;
      console.log(`[transcript] (${sttMs} ms) ${text}`);
      state.segments.push({ text, at: Date.now() });
      renderTranscript();
      if (endedBySilence) onSegmentEnd({ speechEndAt, sttMs });
    })
    .catch((err) => log.error('Audio', `error procesando segmento: ${cleanIpcError(err)}`));
}

// Si el dispositivo de audio cambia o falla, el loopback deja de entregar frames sin avisar.
const AUDIO_WATCHDOG_MS = 3000;
let lastFrameAt = 0;
let watchdogTimer: ReturnType<typeof setInterval> | undefined;

function startWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = setInterval(async () => {
    if (!state.listening || Date.now() - lastFrameAt < AUDIO_WATCHDOG_MS) return;
    log.error('Audio', `sin audio del sistema hace ${Math.round((Date.now() - lastFrameAt) / 1000)} s → reiniciando captura`);
    stopListening({ quiet: true });
    await startListening();
  }, 1000);
}

async function startListening() {
  ensureWhisper();
  let stream: MediaStream;
  try {
    // El proceso principal responde con el audio del sistema (loopback), sin mostrar selector.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    setStatus(`No se pudo capturar audio: ${errorMessage(err)}`, 'error');
    log.error('Audio', `no se pudo capturar el audio del sistema: ${errorMessage(err)}`);
    return;
  }
  stream.getVideoTracks().forEach((t) => t.stop());
  const [track] = stream.getAudioTracks();
  if (!track) {
    setStatus('El sistema no entregó audio', 'error');
    log.error('Audio', 'el sistema no entregó pista de audio');
    return;
  }
  track.onended = () => log.error('Audio', 'la pista de audio del sistema terminó');

  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(new URL('./audio-processor.js', import.meta.url));
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'capture-processor');
  node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
    lastFrameAt = Date.now();
    onFrame(data, ctx.sampleRate);
  };
  source.connect(node);
  // Sin conexión a ctx.destination: no se reproduce el audio de nuevo (evita eco).
  ctx.onstatechange = () => {
    if (ctx.state !== 'running' && audio?.ctx === ctx) log.warn('Audio', `estado del audio: ${ctx.state}`);
  };

  audio = { stream, ctx, node };
  lastFrameAt = Date.now();
  startWatchdog();
  log.ok('Audio', `capturando audio del sistema (${ctx.sampleRate} Hz)`);
  state.listening = true;
  $('listen-btn').textContent = 'Detener';
  $('listen-btn').classList.add('active');
  if (state.whisperReady || state.settings.sttProvider !== 'local') setStatus('Escuchando', 'listening');
  renderTranscript();
}

function stopListening({ quiet = false } = {}) {
  clearInterval(watchdogTimer);
  if (!quiet) log.info('Audio', 'escucha detenida');
  if (audio) {
    audio.node.disconnect();
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ctx.close();
    audio = null;
  }
  state.listening = false;
  inSpeech = false;
  segmentFrames = [];
  $('listen-btn').textContent = 'Escuchar';
  $('listen-btn').classList.remove('active');
  setStatus('Detenido', '');
}

const toggleListening = () => (state.listening ? stopListening() : startListening());
// No se pasa el evento del click como opciones de stopListening.
$('listen-btn').onclick = () => toggleListening();
window.api.onShortcutToggleListen(() => toggleListening());

// ---------- Detección de preguntas y respuesta ----------

const QUESTION_HINTS = new RegExp(
  [
    '\\?', '¿',
    '\\b(qu[eé]|c[oó]mo|cu[aá]l(es)?|cu[aá]nto|por qu[eé]|para qu[eé]|d[oó]nde|cu[aá]ndo|qui[eé]n)\\b',
    '\\b(cu[eé]ntame|cu[eé]ntanos|h[aá]blame|expl[ií]ca(me|nos)?|describe|define|diferencia|podr[ií]as|puedes|has trabajado|tienes experiencia)\\b',
    '\\b(tienen|usan|usaron|consideraron|han (pensado|considerado|probado|evaluado)|se puede|es posible|una (duda|consulta|pregunta)|me gustar[ií]a saber)\\b',
    '\\b(what|how|why|which|when|where|who|tell me|walk me|describe|explain|can you|could you|have you|do you|does it|did you|is there|are you)\\b',
  ].join('|'),
  'i',
);


function pendingQuestion() {
  return state.segments.slice(state.answeredUpTo).map((s) => s.text).join(' ').trim();
}

function recentTranscript() {
  return state.segments.slice(-20).map((s) => s.text).join('\n').slice(-3000);
}

function onSpeechStart() {
  setStatus('Hablando…', 'speaking');
}

// Si el otro participante sigue hablando poco después de una respuesta automática,
// se rehace la respuesta con la pregunta completa en vez de responder solo la continuación.
const CONTINUATION_WINDOW_MS = 4000;

function onSegmentEnd(timing: { speechEndAt: number; sttMs: number }) {
  if (!state.settings.autoAnswer) {
    log.info('Pregunta', 'respuesta automática desactivada (usa Ctrl+Shift+Space)');
    return;
  }
  const last = state.lastAuto;
  if (last && Date.now() - last.at < CONTINUATION_WINDOW_MS) {
    state.answeredUpTo = last.startIndex;
    log.info('Pregunta', 'continuación de la pregunta anterior → se rehace la respuesta');
  }

  // Responde de inmediato: esperar una pausa extra suma latencia, y la continuación se corrige arriba.
  const question = pendingQuestion();
  if (question.length > 12 && QUESTION_HINTS.test(question)) {
    log.info('Pregunta', `detectada → respondiendo: "${question.slice(0, 80)}${question.length > 80 ? '…' : ''}"`);
    answer(question, { auto: true, ...timing });
  } else {
    log.info('Pregunta', `no parece pregunta, no se responde (Ctrl+Shift+Space para forzar): "${question.slice(0, 60)}"`);
  }
}

async function answer(
  question = pendingQuestion(),
  { auto = false, speechEndAt = Date.now(), sttMs = null as number | null } = {},
) {
  if (!question) {
    $('answer').innerHTML = '<p class="muted">No hay nada nuevo que responder.</p>';
    return;
  }
  state.lastAuto = auto ? { startIndex: state.answeredUpTo, at: Date.now() } : null;
  state.answeredUpTo = state.segments.length;
  state.timing = { speechEndAt, sttMs, firstTokenMs: null };
  renderTranscript();

  state.answerText = '';
  state.answering = true;
  state.currentQuestion = question;
  $('answer').innerHTML = `<div class="question">${escapeHtml(question)}</div><p class="muted">Pensando…</p>`;
  state.answerId += 1;
  window.api.generateAnswer(state.answerId, question, recentTranscript());
}

// Latencia desde que el otro participante dejó de hablar hasta el primer texto visible.
function timingLabel() {
  const { firstTokenMs, sttMs } = state.timing;
  if (firstTokenMs == null) return '';
  const color = firstTokenMs <= 2000 ? 'var(--ok)' : 'var(--warn)';
  return ` <span style="color:${color};font-style:normal">· ${(firstTokenMs / 1000).toFixed(2)} s${sttMs != null ? ` (STT ${sttMs} ms)` : ''}</span>`;
}

window.api.onAnswerToken((id, token) => {
  if (id !== state.answerId) return;
  if (state.timing.firstTokenMs == null) state.timing.firstTokenMs = Date.now() - state.timing.speechEndAt;
  state.answerText += token;
  const box = $('answer');
  box.innerHTML = `<div class="question">${escapeHtml(state.currentQuestion)}${timingLabel()}</div>${renderMarkdown(state.answerText)}`;
  box.scrollTop = box.scrollHeight;
});
window.api.onAnswerDone((id) => {
  if (id !== state.answerId) return;
  state.answering = false;
  console.log(`[answer] (primer token ${state.timing.firstTokenMs} ms, total ${Date.now() - state.timing.speechEndAt} ms) ${state.answerText}`);
});
window.api.onAnswerError((id, msg) => {
  if (id !== state.answerId) return;
  state.answering = false;
  $('answer').innerHTML = `<p style="color:var(--err)">Error: ${escapeHtml(msg)}</p><p class="muted">Revisa la pestaña Ajustes.</p>`;
});

$('answer-btn').onclick = () => answer();
window.api.onShortcutAnswer(() => answer());

function clearAll() {
  window.api.cancelAnswer();
  state.segments = [];
  state.answeredUpTo = 0;
  $('answer').innerHTML = '<p class="muted">Aquí aparecerá la respuesta cuando detecte una pregunta.</p>';
  renderTranscript();
}
$('clear-btn').onclick = clearAll;
window.api.onShortcutClear(clearAll);

$<HTMLFormElement>('ask-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('ask-input');
  const q = input.value.trim();
  if (!q) return;
  input.value = '';
  answer(q);
};

// ---------- Contexto / RAG ----------

// Textos de la UI que dependen del modo (presentación/reunión o entrevista).
const MODE_TEXT: Record<Mode, { speaker: string; topic: string; topicHint: string; paste: string; noDocs: string }> = {
  presentation: {
    speaker: 'Participantes',
    topic: 'Tema de la reunión',
    topicHint: 'Ej: Demo del proyecto Atlas al cliente',
    paste: 'Pegar texto (guion, notas del proyecto, datos, preguntas esperadas…)',
    noDocs: 'Sin documentos. Agrega la presentación, documentación del proyecto o notas.',
  },
  interview: {
    speaker: 'Entrevistador',
    topic: 'Cargo / empresa',
    topicHint: 'Ej: Backend Developer Sr. en Acme',
    paste: 'Pegar texto (logros, proyectos, descripción del cargo…)',
    noDocs: 'Sin documentos. Agrega tu CV, proyectos o notas.',
  },
};
const modeText = () => MODE_TEXT[state.settings.mode] || MODE_TEXT.presentation;

function renderMode() {
  const t = modeText();
  $('transcript-label').textContent = t.speaker;
  $('topic-label').textContent = t.topic;
  $<HTMLInputElement>('cfg-topic').placeholder = t.topicHint;
  $('paste-label').textContent = t.paste;
  refreshDocs();
}

async function refreshDocs(docs?: RagDocument[]) {
  docs = docs || (await window.api.listDocs());
  $('docs-list').innerHTML = docs.length
    ? docs.map((d) => `<li><span>${escapeHtml(d.name)}<small>${d.chunks} fragmentos</small></span><button class="icon-btn" data-remove="${d.id}" title="Quitar">×</button></li>`).join('')
    : `<li class="muted">${modeText().noDocs}</li>`;
}

$('docs-list').onclick = async (e) => {
  const id = (e.target as HTMLElement).dataset.remove;
  if (id) refreshDocs(await window.api.removeDoc(id));
};

async function withRagErrors(fn: () => Promise<RagDocument[]>) {
  try {
    refreshDocs(await fn());
  } catch (err) {
    $('rag-progress').textContent = `Error: ${errorMessage(err).replace(/^Error invoking remote method '[^']+': /, '')}`;
  }
}

$('add-files-btn').onclick = () => withRagErrors(() => window.api.addFiles());
$('paste-btn').onclick = () => {
  const pasteText = $<HTMLTextAreaElement>('paste-text');
  const pasteName = $<HTMLInputElement>('paste-name');
  const text = pasteText.value.trim();
  if (!text) return;
  const name = pasteName.value.trim() || `Notas ${new Date().toLocaleString()}`;
  $('rag-progress').textContent = 'Indexando…';
  withRagErrors(async () => {
    const docs = await window.api.addText(name, text);
    pasteText.value = '';
    pasteName.value = '';
    $('rag-progress').textContent = '';
    return docs;
  });
};
window.api.onRagProgress((msg) => { $('rag-progress').textContent = msg; });

// ---------- Ajustes ----------

const FIELDS = ['mode', 'topic', 'provider', 'customBaseUrl', 'ollamaUrl', 'chatModel', 'embedModel', 'sttProvider', 'whisperModel', 'language', 'autoAnswer', 'opacity', 'extraInstructions'] as const;
let providers = {} as Record<ApiProvider, ProviderInfo>;

function renderSttProvider() {
  $('local-whisper-field').style.display = state.settings.sttProvider === 'local' ? '' : 'none';
}

async function saveSetting<K extends keyof SettingsPatch>(key: K, value: SettingsPatch[K]) {
  state.settings = await window.api.setSettings({ [key]: value });
  if (key === 'opacity') window.api.setOpacity(value as number);
  if (['whisperModel', 'language', 'sttProvider'].includes(key)) ensureWhisper();
  if (key === 'sttProvider') renderSttProvider();
  if (key === 'mode') renderMode();
  if (['ollamaUrl', 'chatModel', 'embedModel', 'provider'].includes(key)) refreshOllamaStatus();
  if (key === 'provider' || key === 'customBaseUrl') renderProvider();
}

// Muestra la key y el modelo del proveedor elegido; cada proveedor guarda los suyos.
function renderProvider() {
  const { provider, apiKeys, apiModels } = state.settings;
  $('api-fields').style.display = provider !== 'ollama' ? '' : 'none';
  $('ollama-chat-field').style.display = provider !== 'ollama' ? 'none' : '';
  $('test-llm-result').textContent = '';
  if (provider === 'ollama') return;

  $('custom-url-field').style.display = provider === 'custom' ? '' : 'none';
  $('get-key-link').style.display = providers[provider]?.keysUrl ? '' : 'none';
  $<HTMLInputElement>('api-key').value = apiKeys[provider] || '';
  $<HTMLInputElement>('api-model').value = apiModels[provider] || '';
  refreshApiModels();
}

// Modelos de chat preferidos, de mejor a peor. Cada cuenta/proveedor tiene acceso a modelos distintos.
const PREFERRED_MODELS = [/gpt-oss-120b$/, /gpt-oss-20b$/, /llama-3\.3-70b/, /qwen/, /llama/];
const NON_CHAT_MODELS = /whisper|guard|orpheus|tts|embed/i;

async function refreshApiModels() {
  let models: string[];
  try {
    models = await window.api.llmModels();
  } catch {
    $('api-models').innerHTML = '';
    return;
  }
  $('api-models').innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">`).join('');

  // Si el modelo guardado no existe para esta cuenta, elige uno disponible en vez de fallar al responder.
  const { provider, apiModels } = state.settings;
  if (provider === 'ollama' || !models.length || models.includes(apiModels[provider])) return;
  const chatModels = models.filter((m) => !NON_CHAT_MODELS.test(m));
  const pick = PREFERRED_MODELS.map((re) => chatModels.find((m) => re.test(m))).find(Boolean) || chatModels[0];
  if (!pick) return;
  await saveSetting('apiModels', { [provider]: pick });
  $<HTMLInputElement>('api-model').value = pick;
  $('test-llm-result').textContent = `"${apiModels[provider]}" no está disponible en tu cuenta; se usará ${pick}.`;
}

// Los campos de key y modelo solo se ven con un proveedor de API (ver renderProvider).
const currentApiProvider = () => state.settings.provider as ApiProvider;

$('api-key').onchange = async () => {
  await saveSetting('apiKeys', { [currentApiProvider()]: $<HTMLInputElement>('api-key').value.trim() });
  refreshApiModels();
};
$('api-model').onchange = () => saveSetting('apiModels', { [currentApiProvider()]: $<HTMLInputElement>('api-model').value.trim() });
$('get-key-link').onclick = () => window.api.openExternal(providers[currentApiProvider()].keysUrl!);

$('test-llm-btn').onclick = async () => {
  const out = $('test-llm-result');
  out.style.color = '';
  out.textContent = 'Probando…';
  try {
    const r = await window.api.llmTest();
    out.textContent = `Primer token: ${(r.firstTokenMs! / 1000).toFixed(2)} s · respuesta completa: ${(r.totalMs / 1000).toFixed(2)} s`;
  } catch (err) {
    out.style.color = 'var(--err)';
    out.textContent = cleanIpcError(err).slice(0, 200);
  }
};

function bindSettings() {
  for (const key of FIELDS) {
    const el = $<HTMLInputElement>(`cfg-${key}`);
    if (el.type === 'checkbox') {
      el.checked = state.settings[key] as boolean;
      el.onchange = () => saveSetting(key, el.checked);
    } else if (el.type === 'range') {
      el.value = String(state.settings[key]);
      el.oninput = () => saveSetting(key, Number(el.value));
    } else {
      el.value = String(state.settings[key]);
      // Los <select> solo ofrecen valores válidos para cada clave.
      el.onchange = () => saveSetting(key, el.value.trim() as SettingsPatch[typeof key]);
    }
  }
}

async function refreshOllamaStatus() {
  const s = await window.api.ollamaStatus();
  const box = $('ollama-status');
  $('ollama-models').innerHTML = s.models.map((m) => `<option value="${escapeHtml(m)}">`).join('');
  if (!s.online) {
    box.className = 'notice err';
    box.innerHTML = 'Ollama no responde. Instálalo desde <b>ollama.com</b> y ábrelo.';
    return;
  }
  const missing: string[] = [];
  if (!s.chatModel && state.settings.provider === 'ollama') missing.push(state.settings.chatModel);
  if (!s.embedModel) missing.push(state.settings.embedModel);
  if (missing.length) {
    box.className = 'notice err';
    box.innerHTML = `Ollama activo, faltan modelos. Ejecuta: ${missing.map((m) => `<code>ollama pull ${escapeHtml(m)}</code>`).join(' ')}`;
  } else {
    box.className = 'notice ok';
    box.textContent = 'Ollama activo y modelos disponibles.';
  }
}

// ---------- Inicio ----------

(async () => {
  state.settings = await window.api.getSettings();
  providers = await window.api.llmProviders();
  window.api.setOpacity(state.settings.opacity);
  bindSettings();
  renderProvider();
  renderSttProvider();
  renderMode();
  // Precarga Whisper para que esté listo cuando empiece la reunión.
  ensureWhisper();
  const s = await window.api.ollamaStatus();
  const chatMissing = state.settings.provider === 'ollama' && !s.chatModel;
  if (!s.online || chatMissing || !s.embedModel) document.querySelector<HTMLElement>('[data-tab="settings"]')!.click();
})();
