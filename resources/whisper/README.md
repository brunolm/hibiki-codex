# Bundled VAD model

This directory is **auto-populated** by `scripts/fetch-whisper.mjs` (run via
`bun run fetch:whisper`, or transitively by `bun run dev` / `bun run build`).

It currently holds the Silero VAD model used when `--vad` is enabled:

```
ggml-silero-v5.1.2.bin
```

Pin lives in `scripts/whisper.config.json`. The file is gitignored — only
this README is tracked. It's packaged into the installer at build time via
`package.json` → `build.extraResources`.

`whisper-cli.exe` and its DLLs are **not** bundled: users pick a variant
(CPU / OpenBLAS / CUDA 11.8 / CUDA 12.4) via the in-app runtime downloader
because they target different hardware and range from 4 MB to ~450 MB.
