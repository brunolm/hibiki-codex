// Available whisper.cpp prebuilt runtime variants pinned to v1.8.4. Each
// zip contains whisper-cli.exe + a different GGML backend DLL set; sizes
// vary wildly because the CUDA variants statically include the CUDA
// toolchain. Users pick a variant based on their hardware.

export type WhisperRuntimeVariant = {
  id: string
  label: string
  description: string
  asset: string
  sizeBytes: number
  url: string
  recommended?: boolean
}

const VERSION = 'v1.8.4'
const RELEASE_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}`

function variant(asset: string): string {
  return `${RELEASE_BASE}/${asset}`
}

export const WHISPER_RUNTIME_VERSION = VERSION

export const WHISPER_RUNTIME_VARIANTS: WhisperRuntimeVariant[] = [
  {
    id: 'cpu',
    label: 'CPU only',
    description:
      'Universal CPU build. Works on any x64 PC, no GPU required. Uses ~2 GB system RAM during inference.',
    asset: 'whisper-bin-x64.zip',
    sizeBytes: 4_078_768,
    url: variant('whisper-bin-x64.zip')
  },
  {
    id: 'blas',
    label: 'OpenBLAS (CPU + SIMD)',
    description:
      'Accelerated CPU build using OpenBLAS. Faster than plain CPU when no GPU is available.',
    asset: 'whisper-blas-bin-x64.zip',
    sizeBytes: 16_645_654,
    url: variant('whisper-blas-bin-x64.zip')
  },
  {
    id: 'cublas-11.8',
    label: 'CUDA 11.8 (NVIDIA GPU)',
    description:
      'GPU acceleration for NVIDIA cards via cuBLAS / CUDA 11.8 runtime. Drops system RAM to ~200 MB; uses VRAM instead.',
    asset: 'whisper-cublas-11.8.0-bin-x64.zip',
    sizeBytes: 58_787_783,
    url: variant('whisper-cublas-11.8.0-bin-x64.zip')
  },
  {
    id: 'cublas-12.4',
    label: 'CUDA 12.4 (NVIDIA GPU)',
    description:
      'GPU acceleration for NVIDIA cards via cuBLAS / CUDA 12 runtime. Same RAM drop as CUDA 11.8; larger download (statically links the CUDA 12 toolchain).',
    asset: 'whisper-cublas-12.4.0-bin-x64.zip',
    sizeBytes: 457_024_596,
    url: variant('whisper-cublas-12.4.0-bin-x64.zip'),
    recommended: true
  }
]
