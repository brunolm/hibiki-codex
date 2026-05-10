// Curated list of whisper.cpp models the user can download from the app.
// Each entry is pinned to a specific HuggingFace repo revision so URLs are
// reproducible. Sizes are exact bytes verified against the HF API at pin time.

const officialUrl = (file: string): string =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/${file}`

const animeWhisperUrl = (file: string): string =>
  `https://huggingface.co/Aratako/anime-whisper-ggml/resolve/35b467f144c62a3ab2d84bfbb517d6af5135444a/${file}`

const kotobaWhisperV2Url = (file: string): string =>
  `https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0-ggml/resolve/e3a0cf6a62b95911703cfb97d819292e058f12c3/${file}`

export type WhisperCatalogModel = {
  id: string
  filename: string
  sizeBytes: number
  group: 'multilingual' | 'japanese' | 'english'
  label: string
  description: string
  url: string
  recommended?: boolean
}

export const WHISPER_CATALOG: WhisperCatalogModel[] = [
  {
    id: 'tiny',
    filename: 'ggml-tiny.bin',
    sizeBytes: 77691713,
    group: 'multilingual',
    label: 'Tiny',
    description: 'Smallest, fastest. Lowest accuracy.',
    url: officialUrl('ggml-tiny.bin')
  },
  {
    id: 'base',
    filename: 'ggml-base.bin',
    sizeBytes: 147951465,
    group: 'multilingual',
    label: 'Base',
    description: 'Fast. Decent for English, weak for Japanese.',
    url: officialUrl('ggml-base.bin')
  },
  {
    id: 'small',
    filename: 'ggml-small.bin',
    sizeBytes: 487601967,
    group: 'multilingual',
    label: 'Small',
    description: 'Balanced. Good speed/quality trade-off.',
    url: officialUrl('ggml-small.bin')
  },
  {
    id: 'large-v3-turbo-q8_0',
    filename: 'ggml-large-v3-turbo-q8_0.bin',
    sizeBytes: 874188075,
    group: 'multilingual',
    label: 'Large v3 Turbo (q8_0)',
    description: 'Quantized turbo. Best Japanese quality at this size.',
    url: officialUrl('ggml-large-v3-turbo-q8_0.bin'),
    recommended: true
  },
  {
    id: 'large-v3-turbo',
    filename: 'ggml-large-v3-turbo.bin',
    sizeBytes: 1624555275,
    group: 'multilingual',
    label: 'Large v3 Turbo',
    description: 'Higher-quality turbo. Slower.',
    url: officialUrl('ggml-large-v3-turbo.bin')
  },
  {
    id: 'large-v3',
    filename: 'ggml-large-v3.bin',
    sizeBytes: 3095033483,
    group: 'multilingual',
    label: 'Large v3',
    description: 'Highest accuracy. Significantly slower.',
    url: officialUrl('ggml-large-v3.bin')
  },
  {
    id: 'anime-whisper-q5_k',
    filename: 'ggml-anime-whisper-q5_k.bin',
    sizeBytes: 537819875,
    group: 'japanese',
    label: 'Anime Whisper (q5_k)',
    description: 'Fine-tuned for anime / galge dialogue. Quantized.',
    url: animeWhisperUrl('ggml-anime-whisper-q5_k.bin')
  },
  {
    id: 'anime-whisper',
    filename: 'ggml-anime-whisper.bin',
    sizeBytes: 1519521155,
    group: 'japanese',
    label: 'Anime Whisper',
    description: 'Fine-tuned for anime / galge dialogue. Full precision.',
    url: animeWhisperUrl('ggml-anime-whisper.bin')
  },
  {
    id: 'kotoba-whisper-v2.0',
    filename: 'ggml-kotoba-whisper-v2.0.bin',
    sizeBytes: 1519521155,
    group: 'japanese',
    label: 'Kotoba Whisper v2.0',
    description: 'Distilled large-v2. General Japanese (news, lectures).',
    url: kotobaWhisperV2Url('ggml-kotoba-whisper-v2.0.bin')
  },
  {
    id: 'base.en',
    filename: 'ggml-base.en.bin',
    sizeBytes: 147964211,
    group: 'english',
    label: 'Base.en',
    description: 'Fast. English-only.',
    url: officialUrl('ggml-base.en.bin')
  },
  {
    id: 'small.en',
    filename: 'ggml-small.en.bin',
    sizeBytes: 487614201,
    group: 'english',
    label: 'Small.en',
    description: 'Balanced. English-only.',
    url: officialUrl('ggml-small.en.bin')
  }
]
