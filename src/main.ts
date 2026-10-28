import { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, session, dialog, screen, shell, systemPreferences } from 'electron';
import fs from 'fs';
import path from 'path';
import * as settings from './settings';
import * as rag from './rag';
import * as ollama from './ollama';
import * as llm from './llm';
import * as stt from './stt';
import * as log from './logger';
import * as hfCache from './hf-cache';
import type { SettingsPatch } from './types';

// Los handlers de IPC y los atajos solo se disparan con la ventana ya creada.
let win!: BrowserWindow;

// En dev la ventana es visible en capturas (para poder sacar screenshots y depurar).
// `npm run dev:protect` (flag --protect) arranca dev con la protección activa, como en producción.
const isDev = !app.isPackaged;
let contentProtection = !isDev || process.argv.includes('--protect');

const isMac = process.platform === 'darwin';
// En macOS el audio 'loopback' de getDisplayMedia necesita este flag de Chromium (ScreenCaptureKit, macOS 13+).
if (isMac) app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare');

// La app se llamó "Interview Copilot" y "Meeting Copilot". Si hay datos con un nombre anterior se sigue usando esa
// carpeta en vez de moverlos: el "Local State" de Chromium guarda la clave con la que safeStorage cifró las API keys,
// y Chromium puede crear uno nuevo antes de que corra este código, dejando las keys sin poder descifrarse.
const LEGACY_NAMES = ['Meeting Copilot', 'Interview Copilot'];

function useLegacyDataDir() {
  if (fs.existsSync(path.join(app.getPath('userData'), 'settings.json'))) return;
  const legacy = LEGACY_NAMES.map((name) => path.join(app.getPath('appData'), name)).find((dir) => fs.existsSync(path.join(dir, 'settings.json')));
  if (legacy) app.setPath('userData', legacy);
}
useLegacyDataDir();

hfCache.registerScheme();

function setContentProtection(enabled: boolean) {
  contentProtection = enabled;
  win.setContentProtection(enabled);
  if (enabled) log.ok('Ventana', 'oculta en capturas de pantalla');
  else log.warn('Ventana', 'VISIBLE en capturas de pantalla (modo dev) — Ctrl+Shift+P para ocultarla');
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 460;
  const height = 640;

  win = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    // "toolbar" la oculta también de Alt+Tab en Windows; en macOS "panel" flota sobre apps en pantalla completa.
    type: isMac ? 'panel' : 'toolbar',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Excluye la ventana de cualquier captura de pantalla (Meet, Zoom, Teams, OBS...).
  // En Windows 10 2004+ usa WDA_EXCLUDEFROMCAPTURE: la ventana no aparece en el video compartido.
  win.setContentProtection(contentProtection);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  log.setTarget(win.webContents);
  if (isDev) win.webContents.on('did-finish-load', () => setContentProtection(contentProtection));
  // El HTML y el CSS se sirven desde src/; el JS compilado del renderer está en out/renderer.
  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
}

function registerShortcuts() {
  const send = (channel: string) => win && win.webContents.send(channel);
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.showInactive();
  });
  globalShortcut.register('CommandOrControl+Shift+Space', () => send('shortcut:answer'));
  globalShortcut.register('CommandOrControl+Shift+L', () => send('shortcut:toggle-listen'));
  globalShortcut.register('CommandOrControl+Shift+K', () => send('shortcut:clear'));
  // Solo en dev: alterna la protección para probar que la ventana desaparece al compartir pantalla.
  if (isDev) globalShortcut.register('CommandOrControl+Shift+P', () => win && setContentProtection(!contentProtection));
}

app.whenReady().then(() => {
  // getDisplayMedia() en el renderer devuelve el audio del sistema (loopback de Windows):
  // todo lo que suena por los parlantes/audífonos, es decir, la voz de los demás participantes en Meet.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    // macOS pide el permiso la primera vez; si se negó, la captura falla sin decir por qué.
    if (isMac && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
      log.error('Audio', 'sin permiso: Ajustes del Sistema → Privacidad y seguridad → Grabación de pantalla y audio del sistema → activar Hikui Koe y reiniciar la app');
    }
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: sources[0], audio: 'loopback' });
  });

  hfCache.handle((progress) => win && win.webContents.send('model:progress', progress));

  // skipTaskbar no aplica en macOS: lo equivalente es no mostrar el ícono en el Dock.
  if (isMac) app.dock?.hide();
  createWindow();
  registerShortcuts();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());

// --- IPC ---

ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_e, patch: SettingsPatch) => settings.set(patch));

ipcMain.handle('window:minimize', () => win.hide());
ipcMain.handle('window:close', () => app.quit());
ipcMain.handle('window:opacity', (_e, value: number) => win.setOpacity(value));

ipcMain.handle('ollama:status', () => ollama.status(settings.get()));
ipcMain.handle('llm:providers', () => llm.PROVIDERS);
ipcMain.handle('llm:models', () => llm.listApiModels(settings.get()));
ipcMain.handle('llm:test', () => llm.test(settings.get()));
ipcMain.handle('stt:groq', (_e, samples: Float32Array) => stt.transcribeGroq(settings.get(), samples));
ipcMain.handle('open-external', (_e, url: string) => /^https:\/\//.test(url) && shell.openExternal(url));

ipcMain.handle('rag:list', () => rag.listDocuments());
ipcMain.handle('rag:remove', (_e, id: string) => rag.removeDocument(id));
ipcMain.handle('rag:add-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Agregar documentos de contexto',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Documentos', extensions: ['pdf', 'docx', 'txt', 'md', 'html', 'htm', 'json'] }],
  });
  if (canceled) return rag.listDocuments();
  for (const filePath of filePaths) {
    win.webContents.send('rag:progress', `Indexando ${path.basename(filePath)}...`);
    await rag.addFile(filePath, settings.get());
  }
  win.webContents.send('rag:progress', '');
  return rag.listDocuments();
});
ipcMain.handle('rag:add-text', async (_e, { name, text }: { name: string; text: string }) => {
  await rag.addText(name, text, settings.get());
  return rag.listDocuments();
});

let currentAnswer: AbortController | null = null;

interface AnswerRequest {
  id: number;
  question: string;
  transcript: string;
}

ipcMain.handle('answer:generate', async (event, { id, question, transcript }: AnswerRequest) => {
  if (currentAnswer) currentAnswer.abort();
  const controller = new AbortController();
  currentAnswer = controller;

  const cfg = settings.get();
  const started = Date.now();
  let firstToken: number | null = null;
  let chars = 0;
  try {
    const context = await rag.search(question, cfg, cfg.ragTopK);
    log.info('RAG', `${context.length} fragmentos en ${Date.now() - started} ms`);
    await llm.answer({
      cfg,
      question,
      transcript,
      context,
      signal: controller.signal,
      onToken: (token) => {
        if (firstToken == null) {
          firstToken = Date.now() - started;
          log.info('LLM', `primer token a ${firstToken} ms`);
        }
        chars += token.length;
        event.sender.send('answer:token', id, token);
      },
    });
    log.ok('LLM', `respuesta completa en ${Date.now() - started} ms (${chars} caracteres)`);
    event.sender.send('answer:done', id);
  } catch (e) {
    const err = log.asError(e);
    if (err.name === 'AbortError') {
      log.info('LLM', 'respuesta cancelada (llegó una nueva pregunta)');
    } else {
      log.error('LLM', err.message);
      event.sender.send('answer:error', id, err.message);
    }
  } finally {
    if (currentAnswer === controller) currentAnswer = null;
  }
});
ipcMain.handle('answer:cancel', () => currentAnswer && currentAnswer.abort());
