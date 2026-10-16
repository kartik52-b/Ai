/**
 * JARVIS desktop main process.
 *
 * Responsibilities: one window, one local service child, loopback-only
 * permissions, and the IPC bridge. Everything sensitive (the service token,
 * file paths, process control) stays in this process.
 */

import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EVENT_POLL_INTERVAL_MS, resolvePaths, resolvePython, serviceEntryPoint } from "./config.mjs";
import { forwardServiceEvents, registerIpcHandlers } from "./ipc.mjs";
import { startRendererServer } from "./renderer-server.mjs";
import { PythonService } from "./service-manager.mjs";
import { DesktopSettings } from "./settings.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_STATE_CHANNEL = "jarvis:service-state";

let mainWindow = null;
let rendererServer = null;
let service = null;
let desktopSettings = null;
let stopEventForwarding = null;
let quitting = false;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

function isInternalOrigin(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

/** Only the microphone, only from our own renderer origin, nothing else. */
function applyPermissionPolicy() {
  const allowed = (permission, origin) => permission === "media" && isInternalOrigin(origin ?? "");
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(allowed(permission, contents?.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) =>
    allowed(permission, origin),
  );
}

async function loadRenderer(window) {
  const devUrl = process.env.JARVIS_DEV_RENDERER_URL;
  if (devUrl) {
    await window.loadURL(devUrl);
    return;
  }
  const { rendererDir } = resolvePaths({ app, resourcesPath: process.resourcesPath });
  if (!existsSync(path.join(rendererDir, "index.html"))) {
    await window.loadURL(
      `data:text/html,${encodeURIComponent(
        "<h2 style='font-family:sans-serif'>Renderer bundle missing</h2><p>Run <code>npm run bundle:renderer</code> inside <code>desktop/</code>.</p>",
      )}`,
    );
    return;
  }
  rendererServer = await startRendererServer(rendererDir);
  // The shell opens the local console directly; the landing page and the cloud
  // assistant are one client-side navigation away.
  await window.loadURL(`${rendererServer.url}desktop`);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: "#070a13",
    title: "JARVIS",
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === "string" && url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isInternalOrigin(url) && !url.startsWith("data:")) event.preventDefault();
  });
  window.on("closed", () => {
    mainWindow = null;
  });
  return window;
}

async function startLocalService() {
  if (!service) return null;
  const snapshot = await service.start();
  if (!stopEventForwarding && mainWindow && !mainWindow.isDestroyed()) {
    stopEventForwarding = forwardServiceEvents({
      service,
      webContents: mainWindow.webContents,
      intervalMs: EVENT_POLL_INTERVAL_MS,
    });
  }
  return snapshot;
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", async (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  stopEventForwarding?.();
  stopEventForwarding = null;
  try {
    await service?.stop();
  } catch {
    /* shutting down anyway */
  }
  rendererServer?.close?.().catch(() => {});
  app.exit(0);
});

app.whenReady().then(async () => {
  applyPermissionPolicy();

  const paths = resolvePaths({ app, resourcesPath: process.resourcesPath });
  desktopSettings = new DesktopSettings(paths.settingsPath);

  const interpreter = resolvePython({ pythonDir: paths.pythonDir });
  service = new PythonService({
    pythonDir: paths.pythonDir,
    command: interpreter.command,
    args: [...interpreter.args, ...serviceEntryPoint()],
    stateDir: paths.stateDir,
    env: desktopSettings.serviceEnvironment(),
    logger: console,
  });

  service.on("status", (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(SERVICE_STATE_CHANNEL, snapshot);
    }
  });

  registerIpcHandlers({ ipcMain, service, settings: desktopSettings });

  mainWindow = createWindow();
  await loadRenderer(mainWindow);

  // Startup is opt-in: only launch the service (and the microphone) when the
  // user has explicitly enabled it. Otherwise the UI offers a "Start core" button.
  if (desktopSettings.current().startServiceOnLaunch) {
    startLocalService().catch((error) => {
      console.error(`[jarvis] local service did not start: ${error?.code ?? "error"}`);
    });
  }
});

export { startLocalService };
