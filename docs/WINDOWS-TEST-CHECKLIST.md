# Windows manual test checklist

The automated suites cover validation, permissions and failure handling with
fakes. This checklist covers what a fake cannot: the microphone, the Windows
actions, and the packaged app. Run it on a real Windows 10/11 machine with a
microphone after following `WINDOWS-SETUP.md`.

Record the build under test next to each run:

```
Version / commit: ...........................
Windows build:    ...........................
Mic / headset:    ...........................
Tester / date:    ...........................
```

Expected results are written as **E:** lines. Anything that does not match is a
defect — note it with the activity-log line it produced.

---

## 1. Startup and lifecycle

| # | Step | Expected |
| --- | --- | --- |
| 1.1 | `cd desktop && npm start` | Window “JARVIS” opens; mode badge reads **Core offline**; no Python process exists yet. |
| 1.2 | Task Manager → details, look for `python.exe` | **E:** none spawned before you press Start core. |
| 1.3 | Press **Start core** | Badge changes to **Starting** then **Core ready**; the Local core panel shows a pid and a port; a `Core started` line appears in the log. |
| 1.4 | Open a second copy of the app (double-click the exe again) | **E:** the existing window is focused; no second window, no second service. |
| 1.5 | Task Manager, count `python.exe` running `jarvis_service` | **E:** exactly one. |
| 1.6 | Press **Restart core** | **E:** a new pid appears; the old process is gone; listening state is re-established if it was on. |
| 1.7 | Press **Stop core** | **E:** badge reads **Core offline**; the pid disappears from Task Manager; the microphone indicator in Windows turns off. |
| 1.8 | Close the window (X) | **E:** the app exits and no `python.exe` is left behind. |

## 2. Microphone and wake word

| # | Step | Expected |
| --- | --- | --- |
| 2.1 | Start the core, then press **Start listening** | Badge reads **Listening for wake word**; Windows shows the microphone-in-use indicator; the engines line names `openwakeword:hey_jarvis` and `vosk:small-en-us`. |
| 2.2 | Stay silent for 60 seconds | **E:** no wake events, no false triggers. |
| 2.3 | Say **“Hey JARVIS”** clearly | Badge flashes **Capturing speech**; a `Wake word` line with a score ≥ 0.55 appears; after you stop speaking, a `Heard` line shows the transcript. |
| 2.4 | Say **“Hey JARVIS, what time is it”** in one breath | **E:** the transcript appears, then a `JARVIS · action` line with the current local time; the time is spoken if voice replies are on. |
| 2.5 | Read the transcript quality aloud as a note | Not a code defect, but record it — small-model accuracy depends on the microphone. |
| 2.6 | Press **Mute**, then say “Hey JARVIS” | **E:** the wake event still appears, but nothing is spoken and no action runs. |
| 2.7 | Press **Unmute**, then press **Stop listening** | **E:** the Windows microphone indicator turns off; the badge returns to **Core ready**. |
| 2.8 | Unplug / disable the microphone, then press **Start listening** | **E:** the log records a microphone error with a plain message; the app remains usable for typed commands; nothing crashes. |
| 2.9 | Re-plug the microphone and press **Start listening** again | **E:** listening resumes. |

## 3. Voice command round trip

| # | Step | Expected |
| --- | --- | --- |
| 3.1 | Say “Hey JARVIS, open the calculator” | **E:** Calculator launches; the log shows `open_calculator` with “verified” when the process was confirmed. Close Calculator afterwards. |
| 3.2 | Say “Hey JARVIS, open notepad” | **E:** Notepad launches. |
| 3.3 | Say “Hey JARVIS, open file explorer” | **E:** Explorer opens at an allowed folder (not at an arbitrary path). |
| 3.4 | Say “Hey JARVIS, how much memory is free” | **E:** a spoken/printed answer with OS, CPU, memory and free disk. |
| 3.5 | Type `what time is it` and send | **E:** the same local interpretation as voice — no network needed. |
| 3.6 | Turn off the local core, type `what time is it` | **E:** the input is disabled and the app asks you to start the core. |

## 4. Allowlist and refusal behaviour

| # | Step | Expected |
| --- | --- | --- |
| 4.1 | Type `delete all my files` | **E:** refused — `command_blocked` (403) with the policy message; nothing happens on disk. |
| 4.2 | Type `install something` | **E:** refused, same policy message. |
| 4.3 | Type `run a powershell script` | **E:** refused, same policy message. |
| 4.4 | Attempt an unknown command from the allowlist panel (you cannot — only registered ones are listed) | **E:** the panel lists exactly the eight registered commands, nothing else. |
| 4.5 | Use a folder that is *not* in “file search folders”: set the search folders to just `C:\Users\<you>\Documents`, then type `find notes in C:\Windows` | **E:** refused — outside the allowed roots. |
| 4.6 | Type `find <a filename you know> ` with the same roots | **E:** matches are returned only from `Documents`. |
| 4.7 | Type `search for ../../etc/passwd` | **E:** refused — path separators are rejected. |
| 4.8 | Type `open https://example.com` with an empty allowed-websites list | **E:** a confirmation dialog appears (“first time visiting example.com”); approving opens it in your default browser. |
| 4.9 | Type `open http://example.com` | **E:** refused — non-HTTPS addresses are not opened. |

## 5. Approval flow (sensitive actions)

| # | Step | Expected |
| --- | --- | --- |
| 5.1 | Run `set_volume` with level `0.2` | **E:** a modal appears naming the command and the exact action (“Set the Windows master volume to 20%”), with a countdown starting near 90 s. |
| 5.2 | Press **Deny** | **E:** the system volume is unchanged; the log records `denied`; nothing was executed. |
| 5.3 | Run `set_volume` with level `0.2` again and press **Approve once** | **E:** the Windows volume moves to about 20% and the log records the approval. |
| 5.4 | Run `set_volume` with level `0.2` and **Approve once** again | **E:** it asks again — the earlier approval does not carry over to a new request. |
| 5.5 | Open a dialog and wait 90 seconds without touching it | **E:** the dialog counts down to zero and refuses approval; ask again for a fresh one. |
| 5.6 | Change the volume level in the dialog to a different value before approving | **E:** approval is bound to the action you see; a different value needs its own approval. |
| 5.7 | Restart the core and try the same pending request | **E:** the request is gone — approvals do not survive the service. |

## 6. Failure handling

| # | Step | Expected |
| --- | --- | --- |
| 6.1 | With the core ready, kill `python.exe` in Task Manager | **E:** the badge shows **Failed**/restarting with a plain message, a restart is attempted with backoff, and listening resumes after the restart. |
| 6.2 | Kill it three times in a row | **E:** after the third restart the log says it stopped restarting; the UI still works and offers **Start core**. |
| 6.3 | Rename `desktop\python\.venv` and start the core | **E:** “Python was not found…” with the pointer to `docs/WINDOWS-SETUP.md`; no crash, no stack trace in the UI. |
| 6.4 | Delete a required package from the venv (e.g. `vosk`), restart the core, say “Hey JARVIS” | **E:** the wake word fires, the log says recognition is unavailable, the badge reads **Waiting for typed input**, and typing a command works. |
| 6.5 | Unplug the network, then use several local commands | **E:** everything local still works; only questions that need the online model report that it is unavailable. |

## 7. Privacy checks

| # | Step | Expected |
| --- | --- | --- |
| 7.1 | With listening on, run `netstat -ano \| findstr <pid of python.exe>` | **E:** only loopback connections (`127.0.0.1`); no external address. |
| 7.2 | With no `LLM_API_KEY` set, keep listening for a few minutes | **E:** no outbound connections at all. |
| 7.3 | Search the state directory (`%APPDATA%\jarvis-desktop\local-service`) for `.wav`/`.pcm` files after speaking | **E:** none — audio is never written to disk. |
| 7.4 | Open DevTools in the renderer (`Ctrl+Shift+I`) and run `window.jarvis` | **E:** only the named functions; no token, no path, no `ipcRenderer`, no `require`. |
| 7.5 | In the console, run `process` or try a non-listed channel through `window.jarvis` | **E:** undefined / no such function. |

## 8. Preferences

| # | Step | Expected |
| --- | --- | --- |
| 8.1 | Toggle “Start listening when the app launches” on, quit, relaunch | **E:** listening starts by itself with the core. |
| 8.2 | Toggle “Start the local core on launch” on, quit, relaunch | **E:** the core is ready shortly after the window opens. |
| 8.3 | Change wake sensitivity to 0.85, restart listening | **E:** false triggers become rarer; the value persists across restarts. |
| 8.4 | Add an allowed website host and a search folder, quit, relaunch | **E:** both are still set. |

## 9. Packaged installer

| # | Step | Expected |
| --- | --- | --- |
| 9.1 | `npm run dist:win`, then run `desktop\dist\JARVIS-0.1.0-setup.exe` | **E:** installer runs without asking for administrator rights; SmartScreen may warn (see `WINDOWS-SETUP.md`). |
| 9.2 | Launch the installed app | **E:** the console loads; no `file://` errors; the renderer page is served from loopback. |
| 9.3 | Start the core from the installed app | **E:** works with the Python on `PATH`; if Python is missing, the message points at `docs/WINDOWS-SETUP.md`. |
| 9.4 | Verify the packaged resources | **E:** `resources\python\jarvis_service` exists and contains no `tests/`, `.venv/` or `__pycache__/` folders. |
| 9.5 | Run one local command and one denial from the installed app | **E:** same behaviour as the dev run. |
| 9.6 | Uninstall | **E:** the app and start-menu shortcut are removed; your settings under `%APPDATA%\JARVIS` are left in place (delete them manually if you want a clean slate). |

---

## Sign-off

```
All sections executed .............. yes / no
Defects found (list) .............. .................................
Verified by / date ................. .................................
```

Defects should be filed with: the section number above, the exact step, the
action attempted, what happened, and the relevant activity-log line.
