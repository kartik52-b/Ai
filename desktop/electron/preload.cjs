/**
 * Preload bridge (CommonJS — required by Electron's sandboxed preload).
 *
 * The renderer gets a small, explicit API. It never receives the service token,
 * a node module, or a raw ipcRenderer handle.
 */

const { contextBridge, ipcRenderer } = require("electron");

const EVENT_CHANNEL = "jarvis:event";
const STATE_CHANNEL = "jarvis:service-state";

async function invoke(channel, payload) {
  try {
    const result = await ipcRenderer.invoke(channel, payload);
    if (!result || typeof result !== "object") {
      return { ok: false, error: { code: "ipc_error", message: "the desktop shell did not answer" } };
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      error: { code: "ipc_error", message: "the desktop shell could not be reached" },
    };
  }
}

contextBridge.exposeInMainWorld("jarvis", {
  platform: process.platform,
  desktop: true,
  status: () => invoke("jarvis:status"),
  startService: () => invoke("jarvis:service.start"),
  stopService: () => invoke("jarvis:service.stop"),
  restartService: () => invoke("jarvis:service.restart"),
  catalog: () => invoke("jarvis:catalog"),
  command: (payload) => invoke("jarvis:command", payload),
  confirm: (payload) => invoke("jarvis:confirm", payload),
  message: (payload) => invoke("jarvis:message", payload),
  speechStart: () => invoke("jarvis:speech.start"),
  speechStop: () => invoke("jarvis:speech.stop"),
  speechMute: (payload) => invoke("jarvis:speech.mute", payload),
  speechSay: (payload) => invoke("jarvis:speech.say", payload),
  getSettings: () => invoke("jarvis:settings.get"),
  setSettings: (payload) => invoke("jarvis:settings.set", payload),
  onEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  },
  onServiceState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(STATE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(STATE_CHANNEL, handler);
  },
});
