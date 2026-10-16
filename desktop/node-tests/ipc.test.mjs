import assert from "node:assert/strict";
import { test } from "node:test";

import { ServiceError } from "../electron/bridge-client.mjs";
import {
  IPC_CHANNELS,
  IpcValidationError,
  registerIpcHandlers,
  validateChannel,
  validateCommandPayload,
  validateConfirmPayload,
  validateMessagePayload,
} from "../electron/ipc.mjs";

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
  };
}

function fakeService({ onRequest } = {}) {
  const calls = [];
  return {
    calls,
    snapshot: () => ({ state: "ready", running: true, pid: 1, port: 1234 }),
    start: async () => ({ state: "ready" }),
    stop: async () => ({ state: "stopped" }),
    restart: async () => ({ state: "ready" }),
    request: async (path, options = {}) => {
      calls.push({ path, ...options });
      if (onRequest) return onRequest(path, options);
      return { ok: true, path };
    },
  };
}

function fakeSettings() {
  let values = { startServiceOnLaunch: false };
  return {
    current: () => ({ ...values }),
    update: (patch) => {
      values = { ...values, ...patch };
      return { ...values };
    },
  };
}

test("only allowlisted channels are registered", () => {
  const ipcMain = fakeIpcMain();
  registerIpcHandlers({ ipcMain, service: fakeService(), settings: fakeSettings() });
  for (const channel of ipcMain.handlers.keys()) {
    assert.ok(IPC_CHANNELS.includes(channel), `${channel} must be allowlisted`);
  }
  assert.equal(ipcMain.handlers.size, IPC_CHANNELS.length);
  assert.throws(() => validateChannel("jarvis:rm -rf"), IpcValidationError);
  assert.throws(() => validateChannel("fs:readFile"), IpcValidationError);
  assert.throws(() => validateChannel(null), IpcValidationError);
  assert.equal(validateChannel("jarvis:status"), "jarvis:status");
});

test("command payloads are normalised and validated", () => {
  assert.deepEqual(validateCommandPayload({ name: "open_notepad" }), {
    name: "open_notepad",
    args: {},
    requestId: undefined,
  });
  assert.deepEqual(validateCommandPayload({ name: "set_volume", args: { level: 0.4 }, requestId: "abc-123_X" }), {
    name: "set_volume",
    args: { level: 0.4 },
    requestId: "abc-123_X",
  });

  const bad = [
    { name: "Open_Notepad" },
    { name: "open notepad" },
    { name: "open_notepad; rm -rf /" },
    { name: "ab" },
    { name: "a".repeat(60) },
    { name: 12 },
    {},
    { name: "open_notepad", args: "not-an-object" },
    { name: "open_notepad", args: { nested: { deep: true } } },
    { name: "open_notepad", args: { list: [1, 2] } },
    { name: "open_notepad", args: { "bad key": 1 } },
    // JSON.parse creates an own `__proto__` property; a literal would not.
    { name: "open_notepad", args: JSON.parse('{"__proto__": 1}') },
    { name: "open_notepad", args: { x: "y".repeat(3000) } },
    { name: "open_notepad", args: { x: Number.NaN } },
    { name: "open_notepad", args: { x: 10 ** 400 } },
    { name: "open_notepad", requestId: "spaces are not allowed" },
    { name: "open_notepad", requestId: 5 },
  ];
  for (const payload of bad) {
    assert.throws(() => validateCommandPayload(payload), IpcValidationError, JSON.stringify(payload));
  }

  const tooMany = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
  assert.throws(() => validateCommandPayload({ name: "open_notepad", args: tooMany }), IpcValidationError);
});

test("confirmation payloads require an explicit requestId and verdict", () => {
  assert.deepEqual(validateConfirmPayload({ requestId: "req-1" }), { requestId: "req-1", approve: true });
  assert.deepEqual(validateConfirmPayload({ requestId: "req-1", approve: false }), {
    requestId: "req-1",
    approve: false,
  });
  assert.throws(() => validateConfirmPayload({}), IpcValidationError);
  assert.throws(() => validateConfirmPayload({ requestId: "req-1", approve: "yes" }), IpcValidationError);
  assert.throws(() => validateConfirmPayload({ requestId: "<script>" }), IpcValidationError);
});

test("message payloads bound the text and history", () => {
  assert.deepEqual(validateMessagePayload({ text: "  hello  " }), { text: "hello", history: undefined });
  assert.deepEqual(
    validateMessagePayload({ text: "hi", history: [{ role: "user", content: "earlier" }] }),
    { text: "hi", history: [{ role: "user", content: "earlier" }] },
  );
  assert.throws(() => validateMessagePayload({ text: "   " }), IpcValidationError);
  assert.throws(() => validateMessagePayload({ text: "x".repeat(2100) }), IpcValidationError);
  assert.throws(() => validateMessagePayload({ text: "hi", history: "nope" }), IpcValidationError);
  assert.throws(() => validateMessagePayload({ text: "hi", history: [{ role: "system", content: "x" }] }), IpcValidationError);
  assert.throws(
    () => validateMessagePayload({ text: "hi", history: Array.from({ length: 40 }, () => ({ role: "user", content: "x" })) }),
    IpcValidationError,
  );
});

test("a valid command reaches the service with only validated fields", async () => {
  const ipcMain = fakeIpcMain();
  const service = fakeService();
  registerIpcHandlers({ ipcMain, service, settings: fakeSettings() });

  const result = await ipcMain.handlers.get("jarvis:command")(null, {
    name: "open_notepad",
    args: { path: "C:/Users/me" },
  });
  assert.deepEqual(result, { ok: true, value: { ok: true, path: "/v1/command" } });
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].body.name, "open_notepad");
  assert.equal(service.calls[0].method, "POST");
  assert.equal("token" in service.calls[0].body, false);
});

test("malformed payloads are refused before the service is called", async () => {
  const ipcMain = fakeIpcMain();
  const service = fakeService();
  registerIpcHandlers({ ipcMain, service, settings: fakeSettings() });

  const result = await ipcMain.handlers.get("jarvis:command")(null, { name: "open_notepad; rm -rf /" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_ipc_payload");
  assert.equal(service.calls.length, 0);
});

// The IPC layer only guarantees payload shape. Whether a well-formed command
// name is allowed lives in the Python registry (`require_command`), which is
// where `delete_file` is refused with 403 command_blocked — see
// desktop/python/tests/test_registry.py. Keeping one authority avoids a stale
// allowlist in the shell drifting away from the real one.
test("a well-formed name is forwarded for the registry to adjudicate", async () => {
  const ipcMain = fakeIpcMain();
  const service = fakeService({
    onRequest: () => {
      throw new ServiceError("command_blocked", "that capability is permanently disabled");
    },
  });
  registerIpcHandlers({ ipcMain, service, settings: fakeSettings() });

  const result = await ipcMain.handlers.get("jarvis:command")(null, { name: "delete_file" });
  assert.deepEqual(result, {
    ok: false,
    error: { code: "command_blocked", message: "that capability is permanently disabled" },
  });
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0].body.name, "delete_file");
});

test("service failures become structured errors without stack traces", async () => {
  const ipcMain = fakeIpcMain();
  const service = fakeService({
    onRequest: () => {
      throw new ServiceError("service_unavailable", "the local service is not running");
    },
  });
  registerIpcHandlers({ ipcMain, service, settings: fakeSettings() });

  const result = await ipcMain.handlers.get("jarvis:command")(null, { name: "open_notepad" });
  assert.deepEqual(result, {
    ok: false,
    error: { code: "service_unavailable", message: "the local service is not running" },
  });
  assert.equal("stack" in result.error, false);
});

test("unexpected errors are sanitised", async () => {
  const ipcMain = fakeIpcMain();
  const service = fakeService({
    onRequest: () => {
      const error = new Error("internal detail with a path C:/secret");
      throw error;
    },
  });
  const logged = [];
  registerIpcHandlers({ ipcMain, service, settings: fakeSettings(), logger: { error: (m) => logged.push(m) } });

  const result = await ipcMain.handlers.get("jarvis:message")(null, { text: "hello" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ipc_error");
  assert.equal(result.error.message, "internal detail with a path C:/secret");
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes("C:/secret"), "log lines must not carry the raw error message");
});

test("mute and say validate their inputs", async () => {
  const ipcMain = fakeIpcMain();
  const service = fakeService();
  registerIpcHandlers({ ipcMain, service, settings: fakeSettings() });

  const muted = await ipcMain.handlers.get("jarvis:speech.mute")(null, { muted: true });
  assert.equal(muted.ok, true);
  assert.deepEqual(service.calls.at(-1).body, { muted: true });

  const badMute = await ipcMain.handlers.get("jarvis:speech.mute")(null, { muted: "please" });
  assert.equal(badMute.error.code, "invalid_ipc_payload");

  const said = await ipcMain.handlers.get("jarvis:speech.say")(null, { text: "  good evening  " });
  assert.equal(said.ok, true);
  assert.deepEqual(service.calls.at(-1).body, { text: "good evening" });

  const longSay = await ipcMain.handlers.get("jarvis:speech.say")(null, { text: "x".repeat(700) });
  assert.equal(longSay.error.code, "invalid_ipc_payload");
});

test("settings handlers only accept known preferences", async () => {
  const ipcMain = fakeIpcMain();
  registerIpcHandlers({ ipcMain, service: fakeService(), settings: fakeSettings() });

  const before = await ipcMain.handlers.get("jarvis:settings.get")(null, undefined);
  assert.equal(before.value.startServiceOnLaunch, false);

  const after = await ipcMain.handlers.get("jarvis:settings.set")(null, { startServiceOnLaunch: true });
  assert.equal(after.value.startServiceOnLaunch, true);
  assert.equal(after.ok, true);
});
