/**
 * Renderer bridge: channel allowlist and payload validation.
 *
 * The renderer is treated as untrusted. Every invoke goes through these checks
 * before it reaches the service, and the payload shapes are re-validated on the
 * Python side too. The service token never crosses into the renderer.
 */

import { IPC_EVENT_CHANNEL } from "./config.mjs";

export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;
export const ARG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const MAX_ARGS = 24;
export const MAX_STRING = 2_000;
export const MAX_HISTORY = 20;

/** Channels the renderer may invoke. Anything else is refused. */
export const IPC_CHANNELS = Object.freeze([
  "jarvis:status",
  "jarvis:service.start",
  "jarvis:service.stop",
  "jarvis:service.restart",
  "jarvis:catalog",
  "jarvis:command",
  "jarvis:confirm",
  "jarvis:message",
  "jarvis:speech.start",
  "jarvis:speech.stop",
  "jarvis:speech.mute",
  "jarvis:speech.say",
  "jarvis:settings.get",
  "jarvis:settings.set",
]);

export class IpcValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IpcValidationError";
    this.code = "invalid_ipc_payload";
  }
}

export function validateChannel(channel) {
  if (typeof channel !== "string" || !IPC_CHANNELS.includes(channel)) {
    throw new IpcValidationError(`channel ${String(channel)} is not exposed`);
  }
  return channel;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateText(value, field, maxLength = MAX_STRING) {
  if (typeof value !== "string") throw new IpcValidationError(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new IpcValidationError(`${field} must not be empty`);
  if (text.length > maxLength) throw new IpcValidationError(`${field} is too long`);
  return text;
}

export function validateBoolean(value, field) {
  if (typeof value !== "boolean") throw new IpcValidationError(`${field} must be true or false`);
  return value;
}

export function validateNumber(value, field, { min, max }) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new IpcValidationError(`${field} must be a finite number`);
  }
  if (value < min || value > max) throw new IpcValidationError(`${field} must be between ${min} and ${max}`);
  return value;
}

export function validateArgs(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new IpcValidationError("args must be an object");
  const keys = Object.keys(raw);
  if (keys.length > MAX_ARGS) throw new IpcValidationError(`args may hold at most ${MAX_ARGS} fields`);

  const args = {};
  for (const key of keys) {
    if (!ARG_KEY_PATTERN.test(key) || FORBIDDEN_KEYS.has(key)) {
      throw new IpcValidationError(`args.${key} is not a valid argument name`);
    }
    const value = raw[key];
    if (typeof value === "string") {
      if (value.length > MAX_STRING) throw new IpcValidationError(`args.${key} is too long`);
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new IpcValidationError(`args.${key} must be a finite number`);
    } else if (typeof value !== "boolean") {
      throw new IpcValidationError(`args.${key} must be a string, number, or boolean`);
    }
    args[key] = value;
  }
  return args;
}

export function validateRequestId(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new IpcValidationError("requestId must be a string");
  const id = value.trim();
  if (!id || id.length > 120 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new IpcValidationError("requestId is malformed");
  }
  return id;
}

export function validateCommandPayload(payload) {
  if (!isPlainObject(payload)) throw new IpcValidationError("a command payload must be an object");
  const { name } = payload;
  if (typeof name !== "string" || !COMMAND_NAME_PATTERN.test(name)) {
    throw new IpcValidationError("that is not a valid command name");
  }
  return { name, args: validateArgs(payload.args), requestId: validateRequestId(payload.requestId) };
}

export function validateConfirmPayload(payload) {
  if (!isPlainObject(payload)) throw new IpcValidationError("a confirmation payload must be an object");
  const requestId = validateRequestId(payload.requestId);
  if (!requestId) throw new IpcValidationError("requestId is required");
  const approve = payload.approve === undefined ? true : validateBoolean(payload.approve, "approve");
  return { requestId, approve };
}

export function registerIpcHandlers({ ipcMain, service, settings, logger = console }) {
  const handle = (channel, run) => {
    validateChannel(channel);
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return { ok: true, value: await run(payload) };
      } catch (error) {
        // Structured errors only — never a stack trace across the bridge.
        const code = typeof error?.code === "string" ? error.code : "ipc_error";
        const message =
          typeof error?.message === "string" && error.message
            ? error.message
            : "the action could not be completed";
        if (code === "ipc_error") logger.error?.(`[ipc] ${channel} failed: ${error?.name ?? "Error"}`);
        return { ok: false, error: { code, message } };
      }
    });
  };

  handle("jarvis:status", () => ({ service: service.snapshot(), settings: settings.current() }));
  handle("jarvis:service.start", () => service.start());
  handle("jarvis:service.stop", () => service.stop());
  handle("jarvis:service.restart", () => service.restart());
  handle("jarvis:catalog", () => service.request("/v1/catalog"));
  handle("jarvis:command", (payload) => {
    const command = validateCommandPayload(payload);
    return service.request("/v1/command", { method: "POST", body: command });
  });
  handle("jarvis:confirm", (payload) => {
    const confirmation = validateConfirmPayload(payload);
    return service.request("/v1/confirm", { method: "POST", body: confirmation });
  });
  handle("jarvis:message", (payload) => {
    const message = validateMessagePayload(payload);
    return service.request("/v1/message", { method: "POST", body: message });
  });
  handle("jarvis:speech.start", () => service.request("/v1/speech/start", { method: "POST", body: {} }));
  handle("jarvis:speech.stop", () => service.request("/v1/speech/stop", { method: "POST", body: {} }));
  handle("jarvis:speech.mute", (payload) => {
    if (!isPlainObject(payload)) throw new IpcValidationError("a mute payload must be an object");
    return service.request("/v1/speech/mute", {
      method: "POST",
      body: { muted: validateBoolean(payload.muted, "muted") },
    });
  });
  handle("jarvis:speech.say", (payload) => {
    if (!isPlainObject(payload)) throw new IpcValidationError("a speech payload must be an object");
    return service.request("/v1/speech/say", {
      method: "POST",
      body: { text: validateText(payload.text, "text", 600) },
    });
  });
  handle("jarvis:settings.get", () => settings.current());
  handle("jarvis:settings.set", (payload) => settings.update(payload));
}

/**
 * Poll the service event log and forward new events to the renderer.
 * Polling keeps the token in the main process (the renderer never sees it).
 */
export function forwardServiceEvents({ service, webContents, intervalMs = 500, logger = console }) {
  let cursor = 0;
  let timer = null;

  const tick = async () => {
    if (service.snapshot().state === "ready") {
      try {
        const payload = await service.request(`/v1/events?since=${cursor}`);
        if (Number.isInteger(payload?.cursor)) cursor = payload.cursor;
        for (const event of payload?.events ?? []) {
          if (!webContents.isDestroyed()) webContents.send(IPC_EVENT_CHANNEL, event);
        }
      } catch (error) {
        logger.debug?.(`[events] ${error?.code ?? "error"}`);
      }
    }
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return () => clearTimeout(timer);
}

export function validateMessagePayload(payload) {
  if (!isPlainObject(payload)) throw new IpcValidationError("a message payload must be an object");
  const text = validateText(payload.text, "text", MAX_STRING);

  let history;
  if (payload.history !== undefined && payload.history !== null) {
    if (!Array.isArray(payload.history)) throw new IpcValidationError("history must be an array");
    if (payload.history.length > MAX_HISTORY) throw new IpcValidationError("history is too long");
    history = payload.history.map((turn) => {
      if (!isPlainObject(turn)) throw new IpcValidationError("history entries must be objects");
      const role = turn.role === "assistant" ? "assistant" : turn.role === "user" ? "user" : null;
      if (!role) throw new IpcValidationError("history entries must be user or assistant turns");
      return { role, content: validateText(turn.content, "history content", 4000) };
    });
  }
  return { text, history };
}
