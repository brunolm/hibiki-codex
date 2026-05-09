# Hibiki Codex

> 響 (*hibiki*: echo / resonance) + *codex* (book of knowledge) — a wise codex of what your computer just heard.
>
> [hibikicodex.com](https://hibikicodex.com)

A Windows desktop app that:

1. Captures **WASAPI loopback** from your default playback device.
2. Transcribes it locally with **whisper.cpp** (Japanese or English) into a live
   chat-style scrolling transcript.
3. Lets you ask **Claude** (`claude -p`) or **OpenAI Codex** (`codex exec`) — or
   both at once — about what you've been hearing. Responses appear in a side
   panel with the recent transcript automatically attached as context.

The renderer is **React + TypeScript**; the main process is bundled by
**electron-vite**; a small **Rust** native module (via napi-rs) is wired up for
future native work.

## Architecture

```
src/main/        Electron main: settings, audio capture, transcribe loop, AI shell
src/preload/     contextBridge → window.api
src/renderer/    React + TS UI (Chat / Settings views)
native/          Rust crate (napi-rs) compiled to a Node-API .node
resources/       wasapi-loopback.ps1 — WASAPI loopback capture script
```

## Setup with AI

Paste the prompt below into Claude Code (`claude`) or OpenAI Codex (`codex`)
from the project root. The agent will install every prerequisite, build the
native module, fetch `whisper-cli.exe` plus a model, and write the paths into
the app's settings file so the Whisper tab is pre-filled on first launch.

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

3. Install JS deps and build the Rust native module (run inside `mise exec --`
   or after `mise activate` so the pinned toolchain is on PATH):
     bun install
     bun install --cwd native
     bun run build:rust

4. Download whisper.cpp CLI and a model into `tools\whisper\` at the repo root:
   - Fetch the latest Windows whisper.cpp release zip from
     https://github.com/ggerganov/whisper.cpp/releases (pick the cuBLAS build
     if the machine has an NVIDIA GPU, otherwise the plain Windows build),
     extract it, and locate `whisper-cli.exe`.
   - Download a model from https://huggingface.co/ggerganov/whisper.cpp/.
     Default to `ggml-large-v3-turbo.bin` for quality; if disk or RAM is tight,
     fall back to `ggml-medium.bin` or `ggml-small.bin`. Do NOT pick `.en`
     variants — this app supports Japanese too.
   - Also download the Silero VAD model `ggml-silero-v5.1.2.bin` from the same
     repo and place it next to the whisper model.

5. Write the discovered absolute paths into
   `%APPDATA%\Hibiki Codex\settings.json`, creating the file if missing and
   merging with any existing JSON. Use these exact keys (they match the
   `Settings` type in src/main/settings.ts):
     whisperExe        → full path to whisper-cli.exe
     whisperModel      → full path to the downloaded ggml-*.bin
     whisperVadModel   → full path to ggml-silero-v5.1.2.bin
     whisperLanguage   → "ja"  (leave existing value if already set)

6. Verify the build works:
     bun run typecheck

Report a short summary at the end: versions of bun / cargo / pwsh, the model
chosen, and the settings.json path you wrote. Do not start the dev server.
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
```

Download whisper.cpp + a model from
<https://github.com/ggerganov/whisper.cpp/releases> and
<https://huggingface.co/ggerganov/whisper.cpp/>. The Settings page lets you
point at:

- `whisper-cli.exe`
- a `ggml-*.bin` model (do **not** pick `.en` variants if you want Japanese)
- optionally a Silero VAD model (`ggml-silero-v5.1.2.bin`)

Settings live at `%APPDATA%\Hibiki Codex\settings.json`. (If you used the
previous name `ai-transcribe-prompt`, your old settings are migrated
automatically on first launch.)

## Run

```powershell
bun run dev      # launch with HMR + devtools
bun run build    # production bundle
bun run typecheck
```

Open Settings, fill in the whisper paths, pick a language and engine(s), then
go to Chat and press **Start**. Play some audio. Type a question into the
input, hit Enter — the answer appears in the right panel. With both engines
selected you get parallel cards, one per engine, for comparison.

## Configurable in Settings

**Whisper tab**

| Field | Notes |
|-------|------|
| Whisper exe / model / VAD | Paths to the binaries |
| Language | `ja` or `en` |
| Whisper threads | Match your fast cores |
| Transcribe interval (s) | Lower = lower latency, more CPU |
| Audio buffer (s) | Rolling buffer length |

**Claude tab** (override `~/.claude/settings.json` defaults)

| Field | Notes |
|-------|------|
| Model | e.g. `opus` / `sonnet` / `haiku`, or a model id. Empty = use default. |
| Effort | `low` / `medium` / `high` / `xhigh`. Empty = use default. |

**Codex tab** (override `~/.codex/config.toml` defaults)

| Field | Notes |
|-------|------|
| Model | e.g. `gpt-5` / `o3`. Empty = use default. |
