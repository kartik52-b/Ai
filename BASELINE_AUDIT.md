# BASELINE_AUDIT.md — Task 1

**Task:** 1 — Existing project audit and baseline
**Status:** PASS (with 4 known BLOCKED verification levels, listed in §8)
**Date:** 2026-10-16
**Source changes made by this task:** none. The only file written is this audit.

---

## 1. What this environment actually is

| Question | Finding |
| --- | --- |
| Project root | `/home/daytona/codebase` (workspace root) |
| Host OS | Ubuntu 22.04.5 (Linux `e2b.local`, x86_64) — **not Windows** |
| Graphics/display | `DISPLAY` is empty; no X server, no Wine |
| Runtimes available | Bun 1.4.2, Node 22.23.2, Python 3.10.12 |
| Repo remote | `origin https://github.com/kartik52-b/Ai.git`, branch `main` |
| Git state before Task 1 | 1 tracked file (`README.md`, locally modified); **everything else untracked**; the remote has a single `Initial commit` |

Consequence: the project is available as real local source code, but it is a
**remote Linux sandbox**. Windows desktop development (running Electron, opening
Notepad/Calculator, touching the microphone, building an NSIS installer) cannot
be performed or observed from here. Every claim below is therefore labelled by
verification level (§8). Nothing in this audit is based on the user's physical
laptop.

## 2. Project structure

Two runtimes that share one UI bundle:

```
package.json            web app (Bun): Vite + React + Convex + Convex Auth
src/                    React UI + Convex backend            (~4,428 lines TS/TSX)
  pages/                Landing, AuthPage, AssistantPage, DesktopApp
  hooks/                useJarvis (cloud), useJarvisDesktop (local console)
  lib/desktop.ts        typed accessor for the Electron bridge
  components/           ui/{button,card,input,badge}, ApprovalDialog, RequireAuth, SetupNotice, ArcReactor
  convex/               schema, auth, http, assistant, messages, notes, reminders, users
desktop/                Windows desktop app (npm): Electron shell + Python core
  electron/             7 ESM modules + preload.cjs                  (~1,790 lines)
  python/jarvis_service the local core, stdlib-first                (~2,773 lines)
  python/tests/         119 unit tests                              (~1,663 lines)
  node-tests/           13 tests (unit + 2 live-service integration)
  scripts/              bundle-renderer.mjs (vite build -> desktop/renderer)
  electron-builder.yml  NSIS installer config
docs/                   DESKTOP-AUDIT.md, WINDOWS-SETUP.md, WINDOWS-TEST-CHECKLIST.md
scripts/                smoke-test.mjs, browser-smoke.mjs, style-audit.mjs
```

Package managers: **Bun** at the root (existing convention, `bun.lock` present),
**npm** inside `desktop/` (the README documents `npm install` / `npm start`
there). Root scripts: `dev`, `build`, `preview`, `typecheck`, `codegen`.

## 3. Existing features (working, verified)

Web/cloud path:

- `/` landing page (hero, capabilities, roadmap, desktop section, safety, CTA).
- `/auth` email + password sign-up/sign-in through Convex Auth; `RequireAuth`
  preserves the intended path via `/auth?returnTo=…`.
- `/assistant` protected chat with conversation history, notes and reminders,
  backed by Convex with function calling.

Local desktop path (already present in the working tree — see §6):

- `/desktop` console: service control, command catalog, typed command runner,
  conversation, activity log, permission boundaries, mic engines + dependency
  probe, wake sensitivity, cloud-AI opt-in, mute / stop-listening.
- Electron shell: single-instance window, loopback static renderer server with a
  strict CSP, context-isolated preload bridge, IPC allowlist with payload
  validation, managed Python child process with ready handshake / restart caps.
- Python core: 8 allowlisted commands (`get_current_time`, `get_system_info`,
  `open_notepad`, `open_calculator`, `open_file_explorer`, `open_website`,
  `find_file`, `set_volume`); loopback-only HTTP with per-session token, origin
  check, body-size cap and rate limit; permission tiers with single-use,
  90-second approvals; path confinement to approved folders.

Planned / not implemented in this task: nothing in Task 1. See §7 for what the
later roadmap tasks would still add on top of the current tree.

## 4. Integrations, configuration, secrets

| Concern | Where | Names (values never printed) |
| --- | --- | --- |
| Backend / DB | Convex (`convex.json` → `src/convex`) | `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` in `.env.local`; auth keys via `scripts/generate-auth-keys.mjs` |
| Auth | `@convex-dev/auth`, password provider | — |
| Cloud AI | Convex action `assistant:*` (HTTP call to an OpenAI-compatible API) | deployment-level `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TIMEOUT_SECONDS`. `assistant:status` reports `llmConfigured: false` right now, so no key is set |
| Local AI (optional) | `desktop/python/jarvis_service/llm.py` | same `LLM_*` names, read from the desktop process environment |
| Python override | `desktop/electron/config.mjs` | `JARVIS_PYTHON` (path to an interpreter) |

No secrets are hardcoded in source; the frontend only ever receives
`VITE_CONVEX_URL`. Nothing sensitive was printed while producing this audit.

## 5. Baseline checks — commands and real results

All commands were run from the workspace root on the current tree.

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `bun tsc -b --noEmit` | 0 | **clean** — no type errors |
| 2 | `cd desktop && python3 -m unittest discover -s python/tests -t python` | 0 | **119 tests, OK** (1.09 s) |
| 3 | `cd desktop && node --test "node-tests/*.test.mjs"` | 0 | **13 pass, 0 fail, 0 skipped** (4.7 s, includes 2 live-service tests) |
| 4 | `node scripts/smoke-test.mjs` (Convex E2E: status → auth → chat → notes) | 0 | **SMOKE OK**; chat reply correctly reports offline core because `LLM_API_KEY` is unset |
| 5 | `node scripts/browser-smoke.mjs` (Playwright: landing → sign-up → chat → reload) | 0 | **PASS**, run twice; 0 console errors, 0 page errors, 0 failed requests |
| 6 | `node scripts/style-audit.mjs` (Playwright: tokens, overflow, sections) | 0 | **PASS** — dark theme applied, 7 sections, no horizontal overflow at 1440 px or 390 px |
| 7 | `freebuff-preview status` | 0 | Preview healthy: `running: true`, HTTP 200 on port 5173, Vite ready, Convex functions ready |

There is **no linter configured** in this repository (no ESLint config, no `lint`
script), so "lint status" is "not configured" rather than "passing".

Existing failures: **none** in this run. One intermittent condition is recorded
in §6.

## 6. Failures, blockers, and honest notes

1. **Electron is not installed here** — `desktop/node_modules` does not exist
   and Electron cannot launch on a headless Linux box anyway. The shell has
   never been executed in this environment; its logic is covered by the 13 Node
   tests (12 unit + 2 that drive the real Python service, with fakes for the
   Electron runtime).
2. **Windows-only commands are untested at runtime** — `open_notepad`,
   `open_calculator`, `open_file_explorer`, `open_website`, `set_volume`,
   `get_system_info` need Windows. They are unit-tested against fakes; real
   behaviour is on `docs/WINDOWS-TEST-CHECKLIST.md`.
3. **Live microphone / wake word untested** — no audio device, and none of the
   optional speech packages (`openwakeword`, `vosk`, `pyttsx3`, `pycaw`,
   `sounddevice`, `psutil`) are installed in this sandbox. The service runs
   stdlib-only, which is why the 119 tests pass without them.
4. **No Windows installer has been produced** — `npm run dist:win` requires
   Windows tooling.
5. **Intermittent, pre-existing:** the local Convex deployment logs
   `[CONVEX A(auth:signIn)] Function execution timed out (maximum duration: 1s)`
   (seen at 09:45 in the preview log from the previous session). The two
   `browser-smoke.mjs` runs during this audit completed the account-creation step
   successfully, so it is close to the 1-second function limit rather than
   broken. Recorded as flaky, not as a pass on a hypothesis.

## 7. Existing vs. planned, and what remains for the roadmap

The tree already contains the work of Tasks 3–10 (shell, command engine, typed
interaction, cloud AI adapter, speech, wake word, knowledge base, settings and
packaging config) — written earlier in this project and **not yet committed**.
Task 1 deliberately changed none of it.

What genuinely still remains, and must be proven on Windows rather than claimed:

| Level | Requirement | Current evidence |
| --- | --- | --- |
| 1 | Static / automated (any OS) | **PASS** — rows 1–6 above |
| 2 | Desktop runtime (Electron on Windows) | **BLOCKED** — no Windows, no Electron here |
| 3 | Real microphone + wake word | **BLOCKED** — no audio hardware / models |
| 4 | Packaged installer on Windows | **BLOCKED** — no Windows build tooling |

## 8. Recommended next step

**Task 2 — Stabilize the existing application.** One real item to fix belongs
there rather than here, plus one hygiene item:

1. The Convex `auth:signIn` 1-second timeout (§6.5) is the only recurring
   failure signal in the project. It is not a type/build error and not caused by
   this tree's edits; it should be characterised (and either fixed or documented
   as an environment limit) with measurements rather than guesses.
2. The repository has only `README.md` committed. Committing the working tree is
   required before any further change so that new failures stay distinguishable
   from pre-existing ones — the user has asked for the code to be pushed to
   GitHub, which is happening alongside this audit.

Nothing else is broken: typecheck, Python (119), Node (13), Convex E2E, browser
E2E and style audit all pass on this tree. Task 2 therefore has a narrow,
verifiable scope instead of a speculative rewrite, and the Windows verification
levels stay clearly marked BLOCKED until hardware is available.

**Gate:** Task 1 is complete. No further task was started. Awaiting the user's
`PASS — NEXT TASK` before Task 2.
