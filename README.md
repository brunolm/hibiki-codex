# Hibiki Codex

> 響 (*hibiki*: echo / resonance) + *codex* (book of knowledge) — a wise codex of what your computer just heard.
>
> [hibikicodex.com](https://hibikicodex.com)

A Windows desktop app that:

1. Captures **WASAPI loopback** from your default playback device.
2. Transcribes it locally with **whisper.cpp** (auto-detected, Japanese, or
   English) into a live chat-style scrolling transcript.
3. Lets you ask **Claude** (`claude`) or **OpenAI Codex** (`codex exec`) — or
   both at once — about what you've been hearing. Responses appear in a side
   panel with the recent transcript automatically attached as context.

The renderer is **React + TypeScript**; the main process is bundled by
**electron-vite**; a small **Rust** native module (via napi-rs) is wired up for
future native work.

## Architecture

```
src/main/
  audio.ts                     WASAPI loopback + mic capture, mix pump, device enumeration
  transcribe.ts                whisper-cli wrapper, cancel-on-Stop, --tinydiarize routing
  transcribeLoop.ts            interval scheduler that feeds transcribe.ts
  transcript.ts                in-memory transcript store
  ai.ts                        spawns claude / codex exec, WSL wrapper
  aiDetect.ts                  async parallel probes for claude/codex on PATH + WSL
  aiInstall.ts                 winget install of Claude Code on Windows
  paths.ts                     bundled VAD + userData/{whisper-runtime,models}/ paths
  whisperCatalog.ts            curated whisper.cpp model catalog (incl. TinyDiarize)
  modelDownload.ts             streaming model downloader with cancel
  whisperRuntimeCatalog.ts     CPU / OpenBLAS / CUDA 11.8 / CUDA 12.4 variants
  whisperRuntimeDownload.ts    streams zip + pwsh Expand-Archive
  updater.ts                   electron-updater wiring against GitHub Releases
  settings.ts                  persisted Settings type + JSON file
  index.ts                     IPC handlers, app lifecycle
src/preload/                   contextBridge → window.api (typed)
src/renderer/                  React + TS UI (Chat / Settings views, Whisper Help tour)
native/                        Rust crate (napi-rs) compiled to a Node-API .node
resources/
  wasapi-loopback.ps1          WASAPI loopback + microphone capture, device list
  wasapi-process.ps1           per-app loopback via AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
  whisper/                     auto-fetched Silero VAD (.bin) — runtime is NOT bundled
scripts/
  fetch-whisper.mjs            build-time fetch of the bundled VAD
  whisper.config.json          VAD pin
```

## Setup with AI

Paste the prompt below into Claude Code (`claude`) or OpenAI Codex (`codex`)
from the project root. The agent installs every prerequisite and builds the
project; the **whisper-cli runtime and model are downloaded from inside the
app** on first launch, so the agent doesn't need to fetch them.

```text
You are setting up the Hibiki Codex project on Windows 11 with PowerShell 7+.
Work from the current repository root. Be idempotent: skip anything already
installed, and verify each step before moving on.

1. Ensure prerequisites are installed (install only what is missing):
   - Git (winget install --id Git.Git -e)
   - PowerShell 7+ as `pwsh` (winget install --id Microsoft.PowerShell -e)
   - mise (winget install jdx.mise) — verify with `mise --version`
   - Visual Studio Build Tools with the "Desktop development with C++" workload
     (needed by Rust on Windows). Install via:
     winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   After each install, refresh PATH for the current session before continuing.

2. Install Bun and Rust via mise (versions are pinned in mise.toml):
     mise trust
     mise install
   Verify with `mise exec -- bun --version` and `mise exec -- cargo --version`.

3. Install at least one AI CLI (skip whichever ones are already there).
   Either Windows-side on PATH, or inside the default WSL distro — the app
   detects both and offers a "Use WSL" toggle per engine.
   - Claude Code:   winget install Anthropic.ClaudeCode
                    (or leave it missing here; the app's Settings → Claude
                    tab will offer a one-click install button when the user
                    opens it.)
   - OpenAI Codex:  npm install -g @openai/codex   (no in-app installer)
   Verify with `claude --version` and/or `codex --version`.

4. Install JS deps and build the Rust native module (run inside `mise exec --`
   or after `mise activate` so the pinned toolchain is on PATH):
     bun install
     bun install --cwd native
     bun run build:rust
   Note: `bun install` does not fetch any whisper artifacts. `bun run dev`
   and `bun run build` are chained with `node scripts/fetch-whisper.mjs`,
   which downloads the bundled Silero VAD (~885 KB) into
   `resources/whisper/` if it isn't there yet. That fetch is idempotent.

5. Verify the build:
     bun run typecheck

6. Do NOT fetch `whisper-cli.exe` or any GGML model manually. The app
   downloads both from Settings on first launch:
   - Settings → Whisper → Whisper executable → "Download…" opens a chooser
     of four pinned whisper.cpp v1.8.4 variants — CPU (4 MB, ~2 GB RAM at
     inference), OpenBLAS (17 MB), CUDA 11.8 (59 MB), CUDA 12.4 (457 MB,
     recommended for NVIDIA GPUs because it drops system RAM to ~200 MB).
     Installs into `%APPDATA%\Hibiki Codex\whisper-runtime\<variant>\`.
   - Settings → Whisper → Whisper model → "Download…" picks from a curated
     catalog: Tiny / Base / Small / **Large v3 Turbo (q8_0) — recommended**
     / Large v3 Turbo / Large v3 / Anime Whisper (q5_k) / Anime Whisper /
     Kotoba Whisper v2.0 / Base.en / Small.en. Saved into
     `%APPDATA%\Hibiki Codex\models\`. Already-installed entries show an
     "installed" badge; the modal lets the user pick "Use existing" or
     "Re-download".

Report a short summary at the end: versions of bun / cargo / pwsh, which AI
CLIs you installed, and whether they're on Windows PATH or in WSL. Do not
start the dev server.
```

## Setup

Requires **Windows + PowerShell 7+ (`pwsh`)**. Bun and Rust versions are
pinned in [`mise.toml`](mise.toml) — install [mise](https://mise.jdx.dev) once
and let it manage the toolchain:

```powershell
winget install jdx.mise   # one-time
mise install              # reads mise.toml, installs Bun + Rust at the pinned versions
mise trust                # allow the project's mise.toml in this directory
```

If you'd rather install Bun and Rust yourself, that works too — just match the
versions in `mise.toml`. Then build:

```powershell
bun install
bun install --cwd native
bun run build:rust
bun run dev
```

On first launch, open **Settings** and:

1. **Whisper executable → Download…** picks the whisper.cpp runtime variant
   matching your hardware. The CUDA 12.4 build is recommended for NVIDIA GPUs
   (~200 MB system RAM at runtime); the CPU build is universal but uses
   ~2 GB RAM. Installs into `%APPDATA%\Hibiki Codex\whisper-runtime\<id>\`.
2. **Whisper model → Download…** picks a GGML model from the curated catalog.
   Defaults to Large v3 Turbo (q8_0). Saves into
   `%APPDATA%\Hibiki Codex\models\`.
3. **VAD model** is already bundled with the installer — leave the field
   empty to use it.
4. **Language** defaults to `auto` (whisper detects per chunk). Pick `ja` or
   `en` to skip detection latency.
5. **Claude / Codex tabs** auto-detect whether each CLI is on `PATH` or
   inside WSL and pulse the tab if neither is usable. The Claude tab has an
   **Install via winget** button on Windows; both tabs have a **Use WSL**
   checkbox if your install lives in your default WSL distro.

Press **Start** on the Chat view, play some audio, type a question, hit Enter.
With both engines selected you get parallel response cards, one per engine.

Settings live at `%APPDATA%\Hibiki Codex\settings.json`. (If you used the
previous name `ai-transcribe-prompt`, your old settings are migrated
automatically on first launch.)

## Run

```powershell
bun run dev      # launch with HMR + devtools
bun run build    # production bundle
bun run typecheck
```

## Configurable in Settings

Settings has four top-level tabs: **General**, **Whisper**, **Claude**, **Codex**.

**General tab**

| Field | Notes |
|-------|------|
| Request timeout (seconds) | Hard ceiling on a single AI request (default 300). When it fires, the spawned `claude`/`codex` process is killed and the request errors out. |
| Prompt templates editor | Edit user-defined slash-command templates that appear in the chat composer's `/` palette. Per-row name + body; entries override built-ins (`/summarize`, `/translate-en`, `/translate-ja`, `/glossary`, `/explain`, `/quote`) by name. Persists as `promptTemplates` in `settings.json`. |

**Whisper tab** has three sub-tabs (General → Models → Capture & runtime) and a `? Help` button that launches a 13-step guided tour. Each step auto-switches to the right sub-tab, spotlights the field, and explains it inline.

*Whisper → General*

| Field | Notes |
|-------|------|
| Language | `auto` (default), `ja`, `en`. Auto-detect adds a little latency. Single-language-tuned models (Anime Whisper, Kotoba Whisper, `*.en`) ignore this. |
| Whisper threads | Match your fast cores (default 4). |
| Parallel lanes | Concurrent whisper-cli inferences (default 2, max 8). >1 lets a new chunk start while the previous one finishes — useful when inference > interval. Peak CPU = lanes × threads. |
| Transcribe interval (s) | Lower = lower latency, more CPU. |
| Audio buffer (s) | Rolling buffer length (default 300). |

*Whisper → Models*

| Field | Notes |
|-------|------|
| Whisper executable | Path to `whisper-cli.exe`. Required. `Download…` opens the runtime variant chooser (CPU / OpenBLAS / CUDA 11.8 / CUDA 12.4 — CUDA 12.4 is the recommended pick). |
| Whisper model | Path to a `ggml-*.bin`. Required. `Download…` opens the curated model catalog. |
| VAD model | Optional. Empty → falls back to the bundled Silero VAD. |
| TinyDiarize model | Optional `.bin` used only when **Speaker diarization** is on. `Download…` opens a tdrz-filtered catalog (currently only `small.en-tdrz`). When set, it overrides the main Whisper model during diarized runs so users can keep a high-quality default and only swap to the smaller tdrz when they need speaker turns. |

*Whisper → Capture & runtime*

| Field | Notes |
|-------|------|
| Microphone device | Picks which input device the mic-mix uses. **The mic-mix toggle itself lives on the chat pane header**, not here — this dropdown only chooses the device. `Test` runs a 2 s capture and shows a dBFS level meter. |
| Audio output device (loopback source) | Picks which playback endpoint WASAPI loopback captures from. Default = whatever Windows is currently playing through. Has no effect when *Capture from process* is set — per-app loopback isn't bound to one endpoint. |
| Capture from process (beta) | When set to an executable basename (e.g. `Discord.exe`), captures audio from that process via `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` instead of system-wide loopback. Requires Windows 10 2004+. `include` mode captures the target + descendants; `exclude` captures everything else. `Refresh` lists running processes from `tasklist`. |
| Speaker diarization (beta) | Passes `--tinydiarize` to whisper-cli; emitted `[SPEAKER_TURN]` tokens render as a horizontal divider between message bubbles in the chat view. Only works on tdrz-tuned models — set the **TinyDiarize model** under *Models* first. |

**Claude tab** (override `~/.claude/settings.json` defaults)

| Field | Notes |
|-------|------|
| Detection row | Shows whether `claude` is on Windows PATH and/or in WSL. The tab pulses if neither side is usable. |
| Use WSL | Run `wsl claude …` instead of the Windows-side binary. |
| Use print mode (`-p`) | Off by default — claude runs in `--permission-mode auto` with empty-EOF stdin so it doesn't block on permission prompts. On = passes `-p`, which counts against a separate usage quota from the interactive Claude Code REPL. |
| Install panel | Shown when Claude isn't detected on the active backend. On Windows, **Install via winget** runs the install live. |
| Model | e.g. `opus` / `sonnet` / `haiku`, or a model id. Empty = engine default. |
| Effort | `low` / `medium` / `high` / `xhigh`. Empty = engine default. |

**Codex tab** (override `~/.codex/config.toml` defaults)

| Field | Notes |
|-------|------|
| Detection row | Windows PATH + WSL probes, same as the Claude tab. |
| Use WSL | Run through `wsl codex exec …` (the output-last-message file path is auto-translated to `/mnt/c/...`). |
| Use `--dangerously-bypass-approvals-and-sandbox` | Off by default — codex runs with `-a on-request` and decides when to pause for approval (it'll hang if it does, since there's no stdin to answer on). On = skips every approval prompt and the sandbox. |
| Model | e.g. `gpt-5` / `o3`. Empty = engine default. |

**Bottom actions**

- **Save** persists the draft. **Cancel** reverts every tab's unsaved
  changes. **Reset to defaults** asks for confirmation and only resets the
  *current* tab's fields.

## Chat view

The Chat view holds several persisted controls that don't live in the
Settings tab.

**Chat pane header** (next to Start/Stop/Clear):

| Control | Notes |
|---------|------|
| 🎤 Mic toggle | Mixes your default microphone (or the device picked under Settings → Whisper → Capture & runtime) into the audio whisper sees. Flippable **live mid-capture** — the main process keeps a runtime flag and spawns/kills the mic process + mix pump on the fly. Persists as `captureMicrophone` in `settings.json`. |

**Composer**:

| Control | Notes |
|---------|------|
| Engine picker | Toggle Claude and Codex on/off. At least one stays selected. With both on, every prompt fans out and lands as a card per engine. Persists as `aiEngines` in settings.json. |
| Context | Latest N transcript messages sent along with the prompt (and highlighted in the live transcript). 0 = no context, 50 by default. Persists as `transcriptContextMessages` in settings.json. |
| `/` slash palette | Typing `/` at the start of the composer opens a palette of prompt templates. Built-ins (`/summarize`, `/translate-en`, `/translate-ja`, `/glossary`, `/explain`, `/quote`) and user entries from Settings → General both show up. ↑/↓ to navigate, Enter or Tab to insert, Esc to clear. |
| Input history | Like a shell — ↑ at the start of an empty composer walks back through the last 50 prompts; ↓ walks forward. |

**Per-card actions** on completed AI response cards:

- **copy** — response text only.
- **copy md** — full exchange (engine, timestamp, prompt, response) as a Markdown block, ready to paste into a doc or chat thread.

**Auto-scroll lock**: the transcript pane pauses auto-scroll when you scroll up. A floating **↓ Jump to latest** pill appears; click it (or scroll back to the bottom yourself) to re-arm auto-scroll.

**Speaker turns** (only when *Speaker diarization* is on): a horizontal divider with an `⏵ SPEAKER CHANGE` pill renders in the gap between message bubbles where whisper emitted a `[SPEAKER_TURN]` token. A single whisper output containing a turn splits into two visually separate bubbles.

The **Send** button auto-disables with a context-specific tooltip when the
Whisper executable, Whisper model, or all selected AI engines are missing
— the same conditions that make the Settings tab glow.

## Topbar

- **Pin on top** (📌 button on the right): toggles
  `BrowserWindow.setAlwaysOnTop` so the app floats above other windows.
  State persists across launches.
- The app **remembers its size and position** between launches. If the
  saved position would leave less than 5% of the window visible (e.g. a
  monitor was unplugged), it falls back to centered defaults.

## Auto-update

Packaged builds (NSIS installer and portable) self-update against this
repo's GitHub Releases via `electron-updater`. On launch the main process
checks for a newer release; when one is found it downloads in the
background and the chat view shows a small banner. Click **Restart &
install** to apply it. Dev runs (`bun run dev`) skip the updater so there
are no spurious "no update.yml found" errors locally.
