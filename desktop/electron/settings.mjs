/**
 * Desktop preferences — non-secret only, validated key by key.
 *
 * Startup is opt-in: `startServiceOnLaunch` defaults to false, so the local
 * service and microphone stay off until the user turns them on.
 */

import { readFileSync, writeFileSync } from "node:fs";

const DEFAULTS = Object.freeze({
  startServiceOnLaunch: false,
  listenOnLaunch: false,
  voiceReplies: true,
  wakeThreshold: 0.55,
  searchRoots: [],
  siteAllowlist: [],
});

const KEYS = Object.keys(DEFAULTS);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateValue(key, value) {
  switch (key) {
    case "startServiceOnLaunch":
    case "listenOnLaunch":
    case "voiceReplies":
      if (typeof value !== "boolean") throw new Error(`${key} must be true or false`);
      return value;
    case "wakeThreshold": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0.1 || value > 0.95) {
        throw new Error("wakeThreshold must be a number between 0.1 and 0.95");
      }
      return value;
    }
    case "searchRoots":
    case "siteAllowlist": {
      if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
      const items = value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 8);
      if (items.length !== value.length) throw new Error(`${key} must contain only non-empty strings`);
      return items;
    }
    default:
      throw new Error(`${key} is not a settable preference`);
  }
}

export class DesktopSettings {
  constructor(path) {
    this.path = path;
    this.values = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (isPlainObject(parsed)) {
        for (const key of KEYS) {
          if (key in parsed) {
            try {
              this.values[key] = validateValue(key, parsed[key]);
            } catch {
              /* ignore invalid stored values, keep the default */
            }
          }
        }
      }
    } catch {
      /* first run or unreadable file — defaults apply */
    }
    return this.current();
  }

  current() {
    return { ...this.values };
  }

  update(patch) {
    if (!isPlainObject(patch)) throw new Error("settings patch must be an object");
    const next = { ...this.values };
    for (const [key, value] of Object.entries(patch)) {
      if (!KEYS.includes(key)) throw new Error(`${key} is not a settable preference`);
      next[key] = validateValue(key, value);
    }
    this.values = next;
    this.persist();
    return this.current();
  }

  persist() {
    try {
      writeFileSync(this.path, `${JSON.stringify(this.values, null, 2)}\n`, { mode: 0o600 });
    } catch {
      /* preferences are best effort */
    }
  }

  /** Environment for the service process, built from non-secret preferences. */
  serviceEnvironment() {
    const env = {};
    if (this.values.searchRoots.length) env.JARVIS_SEARCH_ROOTS = this.values.searchRoots.join(process.platform === "win32" ? ";" : ":");
    if (this.values.siteAllowlist.length) env.JARVIS_SITE_ALLOWLIST = this.values.siteAllowlist.join(",");
    if (this.values.wakeThreshold) env.JARVIS_WAKE_THRESHOLD = String(this.values.wakeThreshold);
    return env;
  }
}

export { DEFAULTS as DEFAULT_DESKTOP_SETTINGS, KEYS as DESKTOP_SETTING_KEYS };
