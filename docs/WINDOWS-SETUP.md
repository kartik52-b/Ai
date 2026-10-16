# Windows setup

Everything below runs on Windows 10/11 x64. Commands are written for
**PowerShell**; the equivalent Command Prompt commands are the same.

What you need first:

| Requirement | Why | Check |
| --- | --- | --- |
| Node.js 20 or newer | runs the Electron shell and builds the UI | `node -v` |
| Python 3.10 or 3.11, 64-bit | runs the local core | `py -3.11 --version` |
| A microphone | wake word and speech recognition | Windows → Settings → Privacy → Microphone |

## 1. Install the web app dependencies

From the repository root (needed because the desktop reuses the same UI):

```powershell
bun install          # or: npm install
```

## 2. Create the local core's virtual environment

The shell looks for a virtual environment at `desktop\python\.venv` — put it
there, and the app finds it automatically. The command engine works with the
standard library alone, so this step is only needed for speech and volume.

```powershell
cd desktop\python
py -3.11 -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements.txt
```

If you keep the environment somewhere else, point the app at it instead:

```powershell
$env:JARVIS_PYTHON = "D:\venvs\jarvis\Scripts\python.exe"
```

### Optional packages

| Package | Enables | Skip it if |
| --- | --- | --- |
| `openwakeword`, `sounddevice`, `numpy` | “Hey JARVIS” detection and microphone capture | you only want the typed console |
| `vosk` | offline speech recognition | you are happy to type commands after the wake word |
| `pyttsx3` | spoken replies | you prefer silent answers |
| `pycaw` | `set_volume` | you never change the volume by voice |
| `psutil` | verifying a launched process | you are fine with unverified launches |

## 3. Download the two speech models (once, while online)

**Wake word.** openWakeWord ships the code but not the `hey_jarvis` model:

```powershell
cd desktop\python
.\.venv\Scripts\python -m openwakeword.utils download_models hey_jarvis_v0.1
```

> Licensing: the openWakeWord library is Apache-2.0, but the pretrained
> `hey_jarvis` model is **CC BY-NC-SA 4.0** (non-commercial). It is fine for
> personal use; swap in your own trained model before distributing commercially.

**Speech recognition.** Download the small English Vosk model, unzip it, and
place the folder where the core expects it:

```powershell
# default location used by the shell (dev run)
#   %APPDATA%\jarvis-desktop\local-service\models\vosk-model-small-en-us-0.15
# packaged install
#   %APPDATA%\JARVIS\local-service\models\vosk-model-small-en-us-0.15
```

Get it from <https://alphacephei.com/vosk/models> —
`vosk-model-small-en-us-0.15` (≈40 MB). Simpler alternative: keep the model
anywhere and set an absolute path:

```powershell
$env:JARVIS_VOSK_MODEL = "D:\models\vosk-model-small-en-us-0.15"
```

## 4. Run it

```powershell
cd desktop
npm install
npm start
```

`npm start` opens the window and leaves the local core **stopped**: the
microphone and the Python process only start when you press **Start core**, or
when you turn on “Start the local core on launch” in the console preferences.

The app opens the console directly (route `/desktop`); the landing page and the
cloud assistant are one click away. A plain browser cannot reach the bridge, so
that same route shows setup instructions instead.

## 5. Build the Windows installer

```powershell
cd desktop
npm run bundle:renderer   # builds ../dist and copies it into desktop\renderer
npm run dist:win          # electron-builder --win nsis
```

Output: `desktop\dist\JARVIS-0.1.0-setup.exe`.

Notes:

* The build is **unsigned**. Windows SmartScreen will show “Windows protected
  your PC” on first run — choose *More info → Run anyway*, or sign it. Signing
  needs an Authenticode certificate; `electron-builder` accepts one through the
  `CSC_LINK` / `CSC_KEY_PASSWORD` environment variables (or an EV certificate,
  which also clears SmartScreen reputation immediately).
* The installed app starts the core with the Python interpreter on your `PATH`
  (a virtual environment is not bundled). Install the requirements system-wide,
  or set `JARVIS_PYTHON` to your virtual environment before launching so the
  packaged app uses it.
* `nsis` config keeps elevation off (`allowElevation: false`): the installer
  never asks for administrator rights.

## 6. Optional: connect the online AI

The local core answers questions with an OpenAI-compatible chat API when a key
is present. Only answers need it — every local command works without it.

```powershell
$env:LLM_API_KEY  = "your-key"                       # required to enable answers
$env:LLM_BASE_URL = "https://openrouter.ai/api/v1"   # any https, OpenAI-compatible
$env:LLM_MODEL    = "openai/gpt-4o-mini"
```

The service refuses a non-`https` base URL so the key is never sent in the
clear, and the key is read from the environment only — it is never written to
disk or logged.

## 7. Environment variables at a glance

| Variable | Default | Purpose |
| --- | --- | --- |
| `JARVIS_PYTHON` | auto-detected | interpreter for the local core |
| `JARVIS_STATE_DIR` | `%LOCALAPPDATA%\jarvis` | token/state directory (the shell overrides this) |
| `JARVIS_HOST` | `127.0.0.1` | any non-loopback value is refused |
| `JARVIS_PORT` | `0` (ephemeral) | fixed port for manual runs |
| `JARVIS_TOKEN` | generated | required outside the shell |
| `JARVIS_SEARCH_ROOTS` | empty | folders `find_file` may search (separated by `;`) |
| `JARVIS_SITE_ALLOWLIST` | empty | hosts that open without asking |
| `JARVIS_VOSK_MODEL` | state dir | Vosk model folder |
| `JARVIS_WAKE_THRESHOLD` | `0.55` | wake-word sensitivity (0.1–0.95) |
| `JARVIS_COMMAND_MIN_INTERVAL` | `0.35` | minimum seconds between commands |
| `LLM_API_KEY` / `JARVIS_LLM_API_KEY` | empty | enables online answers |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible endpoint |
| `LLM_MODEL` | `openai/gpt-4o-mini` | model name |
| `LLM_TIMEOUT_SECONDS` | `30` | request timeout |

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| “Python was not found” in the console | no interpreter on `PATH` and no `desktop\python\.venv` | create the virtual environment (§2) or set `JARVIS_PYTHON` |
| “the local service did not report ready” | a requirement is missing, or startup is slow | run the core by hand to see the error: `cd desktop\python && .\.venv\Scripts\python -m jarvis_service` |
| Wake word never fires | model not downloaded, or the threshold is too high | redo §3, then lower wake sensitivity in the console |
| Wake word fires but nothing is transcribed | Vosk model missing | redo §3, check the path |
| Replies are silent | `pyttsx3` missing or the console is muted | install it in the venv, press **Unmute** |
| Volume command refuses to run | it is a sensitive action | approve the exact action in the dialog |
| “another JARVIS local service is already running” | a stale process from a previous run | the shell kills it automatically on the next start; if it persists, close the app and retry |
