/**
 * End-to-end test: Electron IPC handlers → bridge client → the real Python
 * service over loopback.
 *
 * The other suites use fakes; this one exercises the actual cross-language
 * contract (route names, field casing, the approval request id, error codes).
 * It needs a Python interpreter, so it skips itself when none is available
 * instead of failing the suite on machines without one.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { serviceRequest } from "../electron/bridge-client.mjs";
import { registerIpcHandlers } from "../electron/ipc.mjs";
import { PythonService } from "../electron/service-manager.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonDir = path.join(desktopRoot, "python");
const TOKEN = "integration-token";

/** The first interpreter that actually responds to `--version`, or null. */
function findPython() {
  const candidates = [process.env.JARVIS_PYTHON, "python3", "python"].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const python = findPython();

test(
  "the IPC bridge drives the real local service",
  { skip: python ? false : "no Python interpreter available", timeout: 60_000 },
  async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "jarvis-it-"));
    const child = spawn(python, ["-m", "jarvis_service"], {
      cwd: pythonDir,
      env: {
        ...process.env,
        JARVIS_TOKEN: TOKEN,
        JARVIS_STATE_DIR: stateDir,
        JARVIS_PORT: "0",
        PYTHONUNBUFFERED: "1",
        // The default is 0.35s between commands; the throttle has its own unit
        // tests, and firing requests back to back here keeps this suite quick.
        JARVIS_COMMAND_MIN_INTERVAL: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderr = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

    try {
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`service did not report ready: ${stderr.join("")}`)), 25_000);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          for (const line of String(chunk).split("\n")) {
            if (!line.trim()) continue;
            let parsed;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue;
            }
            if (parsed.event === "ready" && Number.isInteger(parsed.port)) {
              clearTimeout(timer);
              resolve(parsed.port);
            }
            if (parsed.event === "error") {
              clearTimeout(timer);
              reject(new Error(`${parsed.error}: ${parsed.detail}`));
            }
          }
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`service exited early (${code}): ${stderr.join("")}`));
        });
      });

      const handlers = new Map();
      const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
      const service = {
        snapshot: () => ({ state: "ready", running: true, pid: child.pid, port }),
        start: async () => ({ state: "ready" }),
        stop: async () => ({ state: "stopped" }),
        restart: async () => ({ state: "ready" }),
        request: (requestPath, options) =>
          serviceRequest({ port, token: TOKEN, path: requestPath, ...options }),
      };
      const settings = {
        current: () => ({ startServiceOnLaunch: false }),
        update: (patch) => ({ startServiceOnLaunch: false, ...patch }),
      };

      registerIpcHandlers({ ipcMain, service, settings, logger: { error: () => {} } });
      const call = (channel, payload) => handlers.get(channel)(null, payload);

      // ---------------------------------------------------------- allowlist
      const catalog = await call("jarvis:catalog");
      assert.equal(catalog.ok, true);
      assert.equal(catalog.value.commands.length, 8);
      const sensitive = catalog.value.commands.find((command) => command.name === "set_volume");
      assert.equal(sensitive.requiresConfirmation, true, "volume must be gated behind approval");
      assert.equal(
        catalog.value.commands.find((command) => command.name === "get_current_time").danger,
        "read",
      );

      // ------------------------------------------------------------ results
      const time = await call("jarvis:command", { name: "get_current_time" });
      assert.equal(time.ok, true);
      assert.equal(time.value.status, "ok");
      assert.ok(time.value.data, "a read command returns its data");

      const blocked = await call("jarvis:command", { name: "delete_file" });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.error.code, "command_blocked");

      const unknown = await call("jarvis:command", { name: "make_coffee" });
      assert.equal(unknown.ok, false);
      assert.equal(unknown.error.code, "unknown_command");

      const outOfRange = await call("jarvis:command", { name: "set_volume", args: { level: 5 } });
      assert.equal(outOfRange.ok, false);
      assert.equal(outOfRange.error.code, "invalid_arg");

      const nested = await call("jarvis:command", { name: "open_notepad", args: { evil: { deep: true } } });
      assert.equal(nested.ok, false);
      assert.equal(nested.error.code, "invalid_ipc_payload");

      // --------------------------------------------------------- approvals
      const first = await call("jarvis:command", { name: "set_volume", args: { level: 0.3 } });
      assert.equal(first.value.status, "confirmation_required");
      const requestId = first.value.request?.requestId;
      assert.equal(typeof requestId, "string");

      const denied = await call("jarvis:confirm", { requestId, approve: false });
      assert.equal(denied.value.approved, false);

      const replay = await call("jarvis:confirm", { requestId, approve: true });
      assert.equal(replay.ok, false, "a consumed approval must not be reusable");

      const second = await call("jarvis:command", { name: "set_volume", args: { level: 0.3 } });
      const approved = await call("jarvis:confirm", {
        requestId: second.value.request.requestId,
        approve: true,
      });
      assert.equal(approved.value.approved, true);

      const refreshed = await call("jarvis:command", { name: "set_volume", args: { level: 0.8 } });
      assert.equal(
        refreshed.value.request.requestId === requestId,
        false,
        "each request has its own id",
      );
      assert.match(refreshed.value.summary, /80%/);

      // ------------------------------------------------------------ speech
      const muted = await call("jarvis:speech.mute", { muted: true });
      assert.equal(muted.ok, true);
      assert.equal(muted.value.speech.muted, true);
      assert.equal(typeof muted.value.speech.dependencies, "object");

      // ----------------------------------------------------------- message
      const local = await call("jarvis:message", { text: "what time is it" });
      assert.equal(local.ok, true);
      assert.equal(local.value.kind, "command");
      assert.equal(local.value.understoodLocally, true);

      const offline = await call("jarvis:message", {
        text: "explain quantum tunnelling in one sentence",
      });
      assert.equal(offline.ok, true);
      assert.equal(offline.value.kind, "answer");
      assert.equal(offline.value.source, "offline");

      // ------------------------------------------------------------ status
      const status = await call("jarvis:status");
      assert.equal(status.value.service.state, "ready");
      assert.equal(status.value.settings.startServiceOnLaunch, false);

      const events = await service.request("/v1/events?since=0");
      assert.ok(Array.isArray(events.events));
    } finally {
      child.kill("SIGTERM");
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);

test(
  "the service manager starts, reports and stops the real service",
  { skip: python ? false : "no Python interpreter available", timeout: 60_000 },
  async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "jarvis-mgr-"));
    const service = new PythonService({
      pythonDir,
      command: python,
      args: ["-m", "jarvis_service"],
      stateDir,
      env: { JARVIS_COMMAND_MIN_INTERVAL: "0" },
      logger: { error: () => {}, debug: () => {} },
      readyTimeoutMs: 25_000,
    });

    const states = [];
    service.on("status", (snapshot) => states.push(snapshot.state));

    try {
      const ready = await service.start();
      assert.equal(ready.state, "ready");
      assert.equal(typeof ready.port, "number");
      assert.ok(ready.port > 0, "the ephemeral port must be reported back");
      assert.ok(states.includes("starting"), "the UI sees a starting state");

      // The exact shape the console reads.
      const snapshot = service.snapshot();
      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.running, true);
      assert.equal(snapshot.lastError, null);

      // start() is idempotent: no second process.
      const again = await service.start();
      assert.equal(again.pid, snapshot.pid);

      const time = await service.request("/v1/command", {
        method: "POST",
        body: { name: "get_current_time", args: {} },
      });
      assert.equal(time.status, "ok");

      const stopped = await service.stop();
      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.pid, null);
    } finally {
      await service.stop().catch(() => {});
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);

after(() => {
  // nothing global to tear down; kept so the harness exits promptly
});
