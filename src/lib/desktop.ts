/**
 * Typed access to the Electron preload bridge.
 *
 * The same web bundle runs in two places: inside the desktop shell, where
 * `window.jarvis` exists, and in a plain browser, where it does not. Everything
 * here degrades to a clear "desktop shell required" result instead of throwing,
 * so the console route can explain itself in the browser.
 *
 * The bridge never exposes the local service token, file paths, or a raw
 * ipcRenderer handle — only these named calls.
 */

export type DesktopErrorCode =
  | "invalid_ipc_payload"
  | "service_unavailable"
  | "service_timeout"
  | "service_error"
  | "unknown_command"
  | "command_blocked"
  | "invalid_arg"
  | "origin_rejected"
  | "unauthorized"
  | "not_found"
  | "throttled"
  | "ipc_error";

export interface DesktopError {
  code: DesktopErrorCode | (string & {});
  message: string;
}

export type DesktopResult<T> = { ok: true; value: T } | { ok: false; error: DesktopError };

export interface CommandParam {
  name: string;
  type: "string" | "integer" | "number" | "boolean";
  required: boolean;
  description: string;
  enum: string[] | null;
}

export interface CommandSpec {
  name: string;
  description: string;
  danger: "read" | "action" | "sensitive" | "blocked";
  requiresConfirmation: boolean;
  params: CommandParam[];
}

export interface CommandApprovalRequest {
  requestId: string;
  command: string;
  summary: string;
  expiresInSeconds: number;
}

export interface CommandOutcome {
  ok: boolean;
  status: "ok" | "unsupported" | "failed" | "confirmation_required" | string;
  command: string;
  summary?: string;
  detail?: string;
  verified?: boolean;
  data?: Record<string, unknown>;
  /** Present only when status is "confirmation_required". */
  request?: CommandApprovalRequest;
}

export type ServiceState =
  | "stopped"
  | "starting"
  | "ready"
  | "restarting"
  | "unavailable"
  | "crashed";

export interface ServiceSnapshot {
  state: ServiceState;
  running: boolean;
  pid: number | null;
  port: number | null;
  restarts?: number;
  /** Human-readable reason for a non-ready state, never a stack trace. */
  lastError?: string | null;
  errorCode?: string | null;
  logs?: string[];
}

export interface SpeechStatus {
  listening: boolean;
  muted: boolean;
  awaitingText: boolean;
  wakeThreshold: number;
  wakeEngine: string | null;
  sttEngine: string | null;
  ttsEngine: string | null;
  lastWakeAt: number | null;
  error: string | null;
  errorCode: string | null;
  /** Importable optional packages in the local service environment. */
  dependencies: Record<string, boolean>;
}

export interface LocalStatus {
  ok: boolean;
  service: string;
  protocol: string;
  pid: number;
  uptimeSeconds: number;
  llm: { configured: boolean; model: string | null };
  speech: SpeechStatus;
  sites: string[];
  pendingApprovals: CommandApprovalRequest[];
  platform: { windows: boolean; os: string; python: string };
}

export interface DesktopSettings {
  startServiceOnLaunch: boolean;
  listenOnLaunch: boolean;
  voiceReplies: boolean;
  wakeThreshold: number;
  searchRoots: string[];
  siteAllowlist: string[];
}

export interface DesktopStatusPayload {
  service: ServiceSnapshot;
  settings: DesktopSettings;
}

export interface ServiceEvent {
  seq: number;
  at: number;
  type: string;
  [key: string]: unknown;
}

export interface MessageReply {
  ok: boolean;
  kind: "command" | "answer" | "proposal" | string;
  text?: string;
  spoken?: string | null;
  source?: string;
  model?: string;
  understoodLocally?: boolean;
  proposal?: { name: string; args: Record<string, unknown> };
  [key: string]: unknown;
}

export interface JarvisDesktopApi {
  readonly platform: string;
  readonly desktop: true;
  status(): Promise<DesktopResult<DesktopStatusPayload>>;
  startService(): Promise<DesktopResult<ServiceSnapshot>>;
  stopService(): Promise<DesktopResult<ServiceSnapshot>>;
  restartService(): Promise<DesktopResult<ServiceSnapshot>>;
  catalog(): Promise<DesktopResult<{ ok: boolean; commands: CommandSpec[] }>>;
  command(payload: {
    name: string;
    args?: Record<string, string | number | boolean>;
    requestId?: string;
  }): Promise<DesktopResult<CommandOutcome>>;
  confirm(payload: { requestId: string; approve: boolean }): Promise<DesktopResult<CommandOutcome>>;
  message(payload: {
    text: string;
    history?: { role: "user" | "assistant"; content: string }[];
  }): Promise<DesktopResult<MessageReply>>;
  speechStart(): Promise<DesktopResult<{ ok: boolean; speech: SpeechStatus }>>;
  speechStop(): Promise<DesktopResult<{ ok: boolean; speech: SpeechStatus }>>;
  speechMute(payload: { muted: boolean }): Promise<DesktopResult<{ ok: boolean; speech: SpeechStatus }>>;
  speechSay(payload: { text: string }): Promise<DesktopResult<{ ok: boolean; spoken: boolean }>>;
  getSettings(): Promise<DesktopResult<DesktopSettings>>;
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopResult<DesktopSettings>>;
  onEvent(listener: (event: ServiceEvent) => void): () => void;
  onServiceState(listener: (snapshot: ServiceSnapshot) => void): () => void;
}

declare global {
  interface Window {
    jarvis?: JarvisDesktopApi;
  }
}

/** The bridge, or null when this bundle is not running inside the shell. */
export function getDesktopBridge(): JarvisDesktopApi | null {
  if (typeof window === "undefined") return null;
  const bridge = window.jarvis;
  if (!bridge || bridge.desktop !== true) return null;
  return bridge;
}

export function isDesktopShell(): boolean {
  return getDesktopBridge() !== null;
}

export const DESKTOP_REQUIRED_MESSAGE =
  "The local console needs the JARVIS desktop app — this browser page can't reach the microphone, the allowlisted actions, or the local service.";

/** Unwrap a bridge call, turning both bridge errors and absent bridges into text. */
export async function unwrap<T>(
  call: (api: JarvisDesktopApi) => Promise<DesktopResult<T>>,
): Promise<{ value: T } | { error: DesktopError }> {
  const bridge = getDesktopBridge();
  if (!bridge) {
    return { error: { code: "service_unavailable", message: DESKTOP_REQUIRED_MESSAGE } };
  }
  try {
    const result = await call(bridge);
    if (result && result.ok) return { value: result.value };
    return { error: result?.error ?? { code: "ipc_error", message: "the desktop shell did not answer" } };
  } catch {
    return { error: { code: "ipc_error", message: "the desktop shell could not be reached" } };
  }
}

export function errorText(error: DesktopError | null): string | null {
  return error ? error.message : null;
}
