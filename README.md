# J.A.R.V.I.S.

A voice-first personal assistant in two runtimes that share one UI:

| | Cloud assistant (web) | Local console (Windows desktop) |
| --- | --- | --- |
| Where it runs | Vite + React app, Convex backend | Electron shell + local Python core on `127.0.0.1` |
| Account | required (email + password) | none — it is a local tool |
| Voice | browser Web Speech API | openWakeWord + Vosk + Windows SAPI5, fully offline |
| Capabilities | chat, reminders, notes, function calling | eight allowlisted OS actions, each permission-gated |
| Works offline | no | yes (except optional AI answers) |

Both are built from the same `src/` bundle; the desktop shell serves the built
renderer from disk and injects a `window.jarvis` bridge that only exists inside
the app.

## Quick start — web app

```bash
bun install
bunx convex dev --once     # generates VITE_CONVEX_URL
bun run dev                # vite + convex
```

Open the printed URL. `/` is the landing page, `/auth` handles sign-in, and
`/assistant` is the protected assistant.

## Quick start — desktop app

See **[docs/WINDOWS-SETUP.md](docs/WINDOWS-SETUP.md)** for the full guide.

```powershell
bun install                     # repo root: the UI build's dependencies
cd desktop
npm install
py -3.11 -m venv python\.venv   # the shell looks for this path
python\.venv\Scripts\python -m pip install -r python\requirements.txt
npm start                       # opens the console; the core starts on demand
```

Build the installer with `npm run dist:win` (output:
`desktop\dist\JARVIS-0.1.0-setup.exe`, unsigned).

## How the desktop app is wired

```
src/pages/DesktopApp.tsx      the console UI (service, mic, allowlist, log)
  ↓ window.jarvis             src/lib/desktop.ts, src/hooks/useJarvisDesktop.ts
desktop/electron/preload.cjs  contextBridge — invoke-only, no token
  ↓ ipc allowlist             desktop/electron/ipc.mjs (validates every payload)
desktop/electron/main.mjs     owns the token, the child process, the window
  ↓ 127.0.0.1 + X-Jarvis-Token
desktop/python/jarvis_service the local core: registry, permissions, speech
```

Safety properties worth knowing before you trust it:

* only **eight** commands exist, and everything destructive, privileged or
  script-like is refused by name even if it were ever registered;
* sensitive actions return a **single-use approval** bound to the exact command
  and arguments, with a 90-second expiry;
* the service binds to loopback only, requires a per-session token, checks the
  request origin, and caps the body size and the command rate;
* file search is confined to folders you list, and websites open over HTTPS
  only, with a new host needing approval;
* audio never leaves the machine and is never written to disk — the only
  optional network call is the AI completion, and its base URL must be HTTPS.

More detail: **[docs/DESKTOP-AUDIT.md](docs/DESKTOP-AUDIT.md)** (design, trust
boundaries, evidence) and
**[docs/WINDOWS-TEST-CHECKLIST.md](docs/WINDOWS-TEST-CHECKLIST.md)** (manual
verification on real hardware).

## Tests

```bash
cd desktop/python && python3 -m unittest discover -s tests -t .   # 119 tests
cd desktop && npm run test:node                                    # 13 tests
bunx tsc --noEmit -p tsconfig.json                                 # web app types
```

The Python and Node suites cover allowlisting, payload validation, permissions,
approval freshness, and service failure handling. Two Node tests are
end-to-end against the real Python service (IPC contract and service
lifecycle) and skip themselves when no interpreter is available. The Windows
actions and the live microphone path need real hardware — the checklist covers
those.

## Layout

```
src/            web + desktop UI (React, Tailwind, React Router)
src/convex/     Convex backend: auth, chat, notes, reminders
desktop/        Electron shell, local Python core, shell tests, packaging
docs/           audit, Windows setup, manual test checklist
scripts/        smoke tests for the web app
```
