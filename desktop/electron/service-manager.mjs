/**
 * Lifecycle manager for the local Python service.
 *
 * Guarantees:
 *  - at most one service process: a stale instance found in the handshake file
 *    is terminated before a new one is spawned, and start() is idempotent;
 *  - the per-session token is generated here and never leaves the main process;
 *  - a crash is detected, reported to the UI, and retried with backoff a bounded
 *    number of times instead of looping forever;
 *  - stop() is graceful (POST /v1/shutdown) and falls back to killing the child.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ServiceError, serviceRequest } from "./bridge-client.mjs";
import { MAX_SERVICE_RESTARTS, SERVICE_READY_TIMEOUT_MS, SERVICE_STOP_TIMEOUT_MS } from "./config.mjs";

export class ServiceStartError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ServiceStartError";
    this.code = code;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function readHandshake(stateDir) {
  try {
    const raw = readFileSync(path.join(stateDir, "service.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PythonService extends EventEmitter {
  constructor({
    pythonDir,
    command,
    args = [],
    stateDir,
    env = {},
    logger = console,
    readyTimeoutMs = SERVICE_READY_TIMEOUT_MS,
    stopTimeoutMs = SERVICE_STOP_TIMEOUT_MS,
    maxRestarts = MAX_SERVICE_RESTARTS,
    restartDelayMs = 1_000,
    spawnImpl = spawn,
  }) {
    super();
    this.pythonDir = pythonDir;
    this.command = command;
    this.args = args;
    this.stateDir = stateDir;
    this.baseEnv = env;
    this.logger = logger;
    this.readyTimeoutMs = readyTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.maxRestarts = maxRestarts;
    this.restartDelayMs = restartDelayMs;
    this.spawnImpl = spawnImpl;

    this.token = randomBytes(32).toString("base64url");
    this.child = null;
    this.port = null;
    this.pid = null;
    this.stateName = "stopped";
    this.lastError = null;
    this.errorCode = null;
    this.restarts = 0;
    this.logs = [];
    this.stopping = false;
    this.startPromise = null;
  }

  snapshot() {
    return {
      state: this.stateName,
      running: this.stateName === "ready",
      pid: this.pid,
      port: this.port,
      restarts: this.restarts,
      lastError: this.lastError,
      errorCode: this.errorCode,
      logs: this.logs.slice(-40),
    };
  }

  _setState(state, { error = null, code = null } = {}) {
    this.stateName = state;
    this.lastError = error;
    this.errorCode = code;
    this.emit("status", this.snapshot());
  }

  _record(line) {
    const text = String(line).trim();
    if (!text) return;
    this.logs.push(text.slice(0, 500));
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
  }

  /** Terminate a service left behind by a previous run (never two at once). */
  async killStaleInstance() {
    const handshake = readHandshake(this.stateDir);
    const pid = handshake?.pid;
    if (!Number.isInteger(pid) || pid === process.pid) return false;
    if (!isProcessAlive(pid)) return false;

    this._record(`terminating stale local service (pid ${pid})`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return false;
    }
    for (let i = 0; i < 30; i += 1) {
      if (!isProcessAlive(pid)) return true;
      await sleep(100);
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    return true;
  }

  async start() {
    if (this.stateName === "ready") return this.snapshot();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._startOnce();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async _startOnce() {
    if (!this.command) {
      this._setState("unavailable", {
        code: "python_missing",
        error:
          "Python was not found. Install Python 3.10+ and create the virtual environment (see docs/WINDOWS-SETUP.md).",
      });
      throw new ServiceStartError("python_missing", this.lastError);
    }

    this.stopping = false;
    this._setState("starting");
    await this.killStaleInstance();

    const env = {
      ...process.env,
      ...this.baseEnv,
      JARVIS_TOKEN: this.token,
      JARVIS_STATE_DIR: this.stateDir,
      JARVIS_PORT: "0", // ephemeral, reported back through the handshake line
      PYTHONUNBUFFERED: "1",
    };

    let child;
    try {
      child = this.spawnImpl(this.command, this.args, {
        cwd: this.pythonDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      this._setState("unavailable", {
        code: "python_missing",
        error: `could not start ${this.command} (${error?.code ?? "unknown error"})`,
      });
      throw new ServiceStartError(this.errorCode, this.lastError);
    }

    this.child = child;
    this.pid = child.pid ?? null;

    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const timer = setTimeout(() => {
        finish(reject, new ServiceStartError("service_timeout", "the local service did not report ready"));
      }, this.readyTimeoutMs);

      child.stdout?.on("data", (chunk) => {
        for (const line of String(chunk).split("\n")) {
          if (!line.trim()) continue;
          this._record(line);
          let parsed = null;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (parsed?.event === "ready" && Number.isInteger(parsed.port)) {
            clearTimeout(timer);
            finish(resolve, parsed);
          }
          if (parsed?.event === "error") {
            clearTimeout(timer);
            finish(reject, new ServiceStartError(parsed.error ?? "service_error", parsed.detail ?? "startup failed"));
          }
        }
      });
      child.stderr?.on("data", (chunk) => {
        for (const line of String(chunk).split("\n")) this._record(line);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        const missing = error?.code === "ENOENT";
        this._setState("unavailable", {
          code: missing ? "python_missing" : "service_spawn_failed",
          error: missing
            ? `Python was not found at ${this.command}. See docs/WINDOWS-SETUP.md.`
            : `the local service could not start (${error?.code ?? "unknown error"})`,
        });
        finish(reject, new ServiceStartError(this.errorCode, this.lastError));
      });
      child.on("exit", (code, signal) => {
        this.child = null;
        this.pid = null;
        if (!settled) {
          clearTimeout(timer);
          const busy = code === 3;
          this._setState("crashed", {
            code: busy ? "already_running" : "service_exited",
            error: busy
              ? "another JARVIS local service is already running"
              : `the local service stopped during startup (exit ${code ?? signal})`,
          });
          finish(reject, new ServiceStartError(this.errorCode, this.lastError));
          return;
        }
        this._handleExit(code, signal);
      });
    });

    let handshake;
    try {
      handshake = await ready;
    } catch (error) {
      this._record(error.message);
      if (this.child) {
        this.child.kill("SIGKILL");
        this.child = null;
      }
      throw error instanceof ServiceStartError
        ? error
        : new ServiceStartError("service_start_failed", String(error?.message ?? error));
    }

    this.port = handshake.port;
    this.pid = handshake.pid ?? this.pid;
    this._setState("ready");
    this.restarts = 0;
    return this.snapshot();
  }

  _handleExit(code, signal) {
    if (this.stopping) {
      this._setState("stopped");
      return;
    }
    this._setState("crashed", {
      code: "service_exited",
      error: `the local service stopped unexpectedly (exit ${code ?? signal ?? "unknown"})`,
    });
    this.emit("crashed", { code: code ?? null, signal: signal ?? null });
    if (this.restarts < this.maxRestarts) {
      this.restarts += 1;
      this._setState("restarting", { error: `restarting (attempt ${this.restarts})` });
      setTimeout(() => {
        this.start().catch((error) => {
          this._setState("crashed", { code: "restart_failed", error: error.message });
        });
      }, this.restartDelayMs * this.restarts);
    } else {
      this._setState("crashed", {
        code: "restart_limit",
        error: "the local service keeps stopping — check the log and start it again",
      });
      this.emit("gaveUp", this.snapshot());
    }
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this._setState("stopped");
      return this.snapshot();
    }

    if (this.port) {
      try {
        await serviceRequest({ port: this.port, token: this.token, path: "/v1/shutdown", method: "POST", timeoutMs: 2_000 });
      } catch {
        /* the child may already be gone */
      }
    }

    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      sleep(this.stopTimeoutMs).then(() => false),
    ]);
    if (!exited) {
      this._record("local service did not exit in time — terminating");
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await sleep(200);
    }

    this.child = null;
    this.pid = null;
    this.port = null;
    this._setState("stopped");
    return this.snapshot();
  }

  async restart() {
    await this.stop();
    this.killStaleInstance().catch(() => {});
    this.stopping = false;
    return this.start();
  }

  async request(requestPath, { method = "GET", body, timeoutMs } = {}) {
    if (this.stateName !== "ready" || !this.port) {
      throw new ServiceError("service_unavailable", "the local service is not running");
    }
    return serviceRequest({
      port: this.port,
      token: this.token,
      path: requestPath,
      method,
      body,
      timeoutMs,
    });
  }

  /** True when the python module directory exists (used for clearer errors). */
  hasServiceCode() {
    return Boolean(this.pythonDir) && existsSync(path.join(this.pythonDir, "jarvis_service", "__init__.py"));
  }
}
