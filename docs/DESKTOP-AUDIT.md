# Desktop & local-core audit

This document is the audit of what existed before the desktop work, the design
that was added, and the evidence behind the safety claims. It is written for a
reviewer who wants to check the boundaries, not just the feature list.

## 1. What already existed

The repository held one product: a hosted, account-based voice assistant.

| Area | Files | Reuse verdict |
| --- | --- | --- |
| Shell & routing | `index.html`, `src/main.tsx`, `src/App.tsx`, `src/components/RequireAuth.tsx` | Kept; `App` now takes `cloudReady` and gained the `/desktop` route |
| Visual system | `src/index.css`, `tailwind.config.ts`, `src/components/ui/{button,card,input,badge}.tsx`, `src/components/ArcReactor.tsx` | Reused as-is for the console |
| Landing & auth | `src/pages/Landing.tsx`, `src/pages/AuthPage.tsx`, `src/components/SetupNotice.tsx` | Kept; landing gained a *local core* section and CTAs |
| Cloud assistant | `src/pages/AssistantPage.tsx`, `src/hooks/useJarvis.ts`, `src/convex/*` | Untouched; still the online experience |
| Tooling | `scripts/{smoke-test,browser-smoke,style-audit}.mjs` | Untouched |

Gaps found: nothing ran without a Convex deployment URL, nothing ran offline,
there was no wake-word engine outside the browser, and no operating-system
action was available at all — let alone an allowlisted one.

## 2. What was added

```
desktop/
  package.json                 Electron app package (separate from the web app)
  electron-builder.yml         Windows NSIS installer configuration
  electron/
    main.mjs                   window, single-instance lock, permission policy
    preload.cjs                contextBridge surface (invoke-only, no token)
    ipc.mjs                    channel allowlist + payload validation
    service-manager.mjs        spawn / health / restart / stop, never two at once
    bridge-client.mjs          token-authed HTTP client to 127.0.0.1
    renderer-server.mjs        loopback static server with a strict CSP
    settings.mjs               validated, non-secret preferences
    config.mjs                 paths, ports, Python resolution
  python/jarvis_service/       the local core (standard library + optional extras)
  python/tests/                119 unit tests
  node-tests/                  IPC, approval and service-failure tests
src/lib/desktop.ts             typed bridge accessor with a browser fallback
src/hooks/useJarvisDesktop.ts  console state: service, catalog, log, approvals
src/components/ApprovalDialog.tsx  single-use approval UI
src/pages/DesktopApp.tsx       the local console
```

The web app keeps its own dependencies; the desktop shell has its own
`package.json`, so the browser bundle never grows Electron code.

## 3. Trust boundaries

```
renderer (untrusted)                 main process (trusted)            python core (policy owner)
  window.jarvis.*   --ipc invoke-->  channel allowlist                 token check + local origin
                                     payload validation                JSON primitive validation
                                     token held here only   --http-->   registry allowlist
                                                                       permission tier
                                                                       approval store (single use)
```

Rules that hold at each boundary:

* **Renderer → main.** Only the 14 channels in `IPC_CHANNELS` exist; every
  payload is normalised (`validateCommandPayload`, `validateArgs`,
  `validateMessagePayload`). `__proto__`, `constructor`, non-primitive
  arguments, over-long strings and unknown fields are rejected before the
  service is contacted. The renderer never sees the service token, a file path
  or a raw `ipcRenderer`.
* **Main → service.** The service token is generated per session with
  `randomBytes(32)`, passed through the child environment, and sent as
  `X-Jarvis-Token`. The Python side rejects any request without it, any remote
  `Origin`, and any non-loopback `Host`, and refuses to bind anywhere except
  `127.0.0.1`.
* **Service → OS.** Commands only exist if registered in `registry.py`. Names
  matching `DENIED_NAME_PATTERN` (delete, remove, install, elevate, registry,
  powershell, cmd, shell, script, credential, defender, firewall, …) are refused
  with `403 command_blocked` even if a handler were ever registered for them.
* **Speech.** Microphone access happens through PortAudio inside the Python
  process. Audio frames are used for wake detection and recognition locally and
  are never transmitted; the only network call the core can make is the optional
  chat completion, and `LLM_BASE_URL` must be `https` (loopback is exempt for
  local testing).

## 4. The permission ladder

| Tier | Behaviour | Commands |
| --- | --- | --- |
| `read` | Runs immediately | `get_current_time`, `get_system_info`, `find_file` (restricted to `JARVIS_SEARCH_ROOTS`) |
| `action` | Runs immediately after argument validation | `open_calculator`, `open_notepad`, `open_file_explorer` (only a folder you can already reach), `open_website` (https only; a new host needs approval) |
| `sensitive` | Returns `confirmation_required` with a fresh single-use request id | `set_volume` |
| `blocked` | Never implemented | deletion, installation, privilege escalation, registry/system settings, scripts, shells |

Approvals are stored server-side with the SHA-256 fingerprint of the command
plus its validated arguments and a 90-second TTL (`permissions.py`). Approving
one action cannot authorise a different one, and the same request id cannot be
replayed — both properties are unit-tested.

## 5. Speech stack

| Stage | Engine | Note |
| --- | --- | --- |
| Wake word | openWakeWord, `hey_jarvis` model | Runs offline. The library is Apache-2.0; the pretrained model is **CC BY-NC-SA 4.0** — fine for personal/local use, and it must be replaced before any commercial distribution. |
| Speech-to-text | Vosk (small English model) | Fully offline; the model is downloaded once, see `WINDOWS-SETUP.md`. |
| Speech output | `pyttsx3` → Windows SAPI5 | Uses the voices already installed on the machine. |
| Conversation | OpenRouter-compatible chat completions | Optional. Without a key, commands still work; questions fall back to a local reply that says the online model is unavailable. |

Model output is never executed directly: an AI *proposal* is resolved through
`require_command` and `validate_args` exactly like a typed command, and anything
that fails validation is reported as an answer instead.

## 6. Verification

Run from the repository root unless stated otherwise.

| Check | Command | Result |
| --- | --- | --- |
| Python core | `cd desktop/python && python3 -m unittest discover -s tests -t .` | 119 tests pass |
| Electron shell | `cd desktop && npm run test:node` | 13 tests pass |
| TypeScript | `bunx tsc --noEmit -p tsconfig.json` | clean |

The Python suite covers the security layer (token, origin, body limits, JSON
shape, rate limiting), the registry allowlist and argument bounds, the
permission tiers and approval freshness, command execution and failure
reporting, the HTTP surface, the speech adapter selection/fallbacks, and the
LLM adapter's offline behaviour. The Node suite covers channel allowlisting,
payload validation, structured error translation, and service failure handling.
Two of its tests are end-to-end and drive the **real** Python service: one goes
through the IPC handlers (catalog shape, `confirmation_required` request ids,
approval replay refusal, error codes, offline fallback), the other through the
service manager (spawn, ready handshake, reported port, idempotent start,
graceful stop). Both skip themselves when no Python interpreter is present.

**Not verifiable in this environment:** the Windows-only actions
(`open_*`, `set_volume`, `system_info`) and the live microphone path need a real
Windows machine with a microphone. Those are covered by the manual checklist in
`WINDOWS-TEST-CHECKLIST.md`; the code paths behind them are unit-tested with
fakes, but the OS integration itself has not been executed here.

## 7. Deliberate limits

* No cloud sync of the local log, no telemetry, no analytics.
* The desktop console is not behind an account. It is a local tool: the bridge
  only exists inside the shell, and signed-out users on the web can only see a
  page that explains how to run it.
* The installer is unsigned, so Windows SmartScreen will warn on first run —
  see `WINDOWS-SETUP.md` for what that means and how to sign it later.
