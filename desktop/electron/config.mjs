import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVICE_READY_TIMEOUT_MS = 20_000;
export const SERVICE_STOP_TIMEOUT_MS = 4_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const EVENT_POLL_INTERVAL_MS = 500;
export const MAX_SERVICE_RESTARTS = 3;

export const IPC_EVENT_CHANNEL = "jarvis:event";

/** Where the app keeps its own files. */
export function resolvePaths({ app, resourcesPath }) {
  const desktopRoot = path.resolve(here, "..");
  const packaged = Boolean(app?.isPackaged);
  return {
    desktopRoot,
    // Tests and dev runs use desktop/python; packaged builds use resources/python.
    pythonDir: packaged ? path.join(resourcesPath, "python") : path.join(desktopRoot, "python"),
    rendererDir: packaged ? path.join(resourcesPath, "renderer") : path.join(desktopRoot, "renderer"),
    stateDir: path.join(app.getPath("userData"), "local-service"),
    settingsPath: path.join(app.getPath("userData"), "desktop-settings.json"),
  };
}

/**
 * Find a Python interpreter: explicit override, then a project virtualenv,
 * then the launcher on PATH. Returns null when nothing usable exists.
 */
export function resolvePython({ pythonDir, override = process.env.JARVIS_PYTHON } = {}) {
  const candidates = [];
  if (override) candidates.push(override);
  if (pythonDir) {
    candidates.push(
      path.join(pythonDir, ".venv", "Scripts", "python.exe"),
      path.join(pythonDir, ".venv", "bin", "python3"),
      path.join(pythonDir, ".venv", "bin", "python"),
    );
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return { command: candidate, args: [], kind: "explicit" };
  }
  // Fall back to PATH resolution by the OS at spawn time.
  return { command: process.platform === "win32" ? "python" : "python3", args: [], kind: "path" };
}

export function serviceEntryPoint() {
  return ["-m", "jarvis_service"];
}
