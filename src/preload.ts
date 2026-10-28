import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Api } from './types';

const on =
  <Args extends unknown[]>(channel: string) =>
  (cb: (...args: Args) => void) => {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as Args));
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };

const api: Api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  setOpacity: (v) => ipcRenderer.invoke('window:opacity', v),

  ollamaStatus: () => ipcRenderer.invoke('ollama:status'),
  llmProviders: () => ipcRenderer.invoke('llm:providers'),
  llmModels: () => ipcRenderer.invoke('llm:models'),
  llmTest: () => ipcRenderer.invoke('llm:test'),
  transcribeCloud: (samples) => ipcRenderer.invoke('stt:groq', samples),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  listDocs: () => ipcRenderer.invoke('rag:list'),
  addFiles: () => ipcRenderer.invoke('rag:add-files'),
  addText: (name, text) => ipcRenderer.invoke('rag:add-text', { name, text }),
  removeDoc: (id) => ipcRenderer.invoke('rag:remove', id),
  onRagProgress: on('rag:progress'),
  onModelProgress: on('model:progress'),

  generateAnswer: (id, question, transcript) => ipcRenderer.invoke('answer:generate', { id, question, transcript }),
  cancelAnswer: () => ipcRenderer.invoke('answer:cancel'),
  onAnswerToken: on('answer:token'),
  onAnswerDone: on('answer:done'),
  onAnswerError: on('answer:error'),

  onLog: on('log'),
  onShortcutAnswer: on('shortcut:answer'),
  onShortcutToggleListen: on('shortcut:toggle-listen'),
  onShortcutClear: on('shortcut:clear'),
};

contextBridge.exposeInMainWorld('api', api);
