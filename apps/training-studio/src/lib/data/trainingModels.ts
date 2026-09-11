/**
 * Trainable base-model catalog — a VENDORED SNAPSHOT of the in-app trainer's
 * `trainingModelInfo` at `src/utils/training.ts` in this monorepo (mirrored
 * 2026-08-27). That module lives in the main Next.js app's `src/`, which an
 * `apps/*` package can't import, so it's mirrored here; when the trainer adds or
 * changes a base model, re-mirror it by hand — keep the same version `key`,
 * `air`, `baseModel`, ecosystem and `modelVariant`. (If `trainingModelInfo` ever
 * moves into a shared `packages/civitai-*`, import it instead of this snapshot.)
 *
 * Shape difference from the source: the trainer keys every entry flat; here we
 * GROUP entries into one card per family, and the flat entries become that
 * card's `versions` — which is how the redesign's Select step presents them
 * (SD 1.5 → Standard/…; SDXL → Standard/Pony/Illustrious; Wan → 2.2/2.1;
 * LTX → 2.5/2.3/2.0). Where the trainer splits a family across several `type`s
 * (LTX, ZImage, ACE-Step), we keep the per-version `ecosystem` (which is what
 * the orchestrator needs) and give the card a synthetic id. See
 * docs/prototype/training-flow.html.
 *
 * Label type (tags vs captions) is DERIVED, not stored in the source: the
 * booru-tag families (SD 1.5, SDXL and its Pony/Illustrious variants) caption
 * with tags; everything newer uses natural-language captions. The Data step
 * reads this to auto-pick the labeler — never asked.
 *
 * Coverage: every non-commented, non-disabled `trainingModelInfo` entry as of
 * the mirror date. `sd3_medium/large` (commented out) and `wan_2_1_i2v_14b_720p`
 * (`disabled: true`) are intentionally omitted; the Flux.2 Edit entry is
 * commented out upstream. AIRs for AI-Toolkit-only ecosystems that upstream
 * flags as placeholders (boogu, ideogram4, ltx25, minimaxh3) are copied as-is.
 */

export type LabelType = 'tag' | 'caption';
export type Media = 'image' | 'video' | 'audio';

/** One selectable base-model version (a flat `trainingModelInfo` entry). */
export interface ModelVersionInfo {
  /** The `trainingModelInfo` key in the source (e.g. `flux_dev`, `pony`). */
  key: string;
  label: string;
  note?: string;
  air: string;
  baseModel: string;
  /** AI-Toolkit ecosystem + optional discriminated variant (source `aiToolkit`). */
  ecosystem: string;
  modelVariant?: string;
  /** Training engine when it is NOT the default `ai-toolkit` — e.g. `flux2-dev` for Flux.2, which has no
   * ai-toolkit ecosystem and trains via the `imageResourceTraining` path with an explicit base AIR. */
  engine?: string;
  /** Ecosystem-specific version selector (the `qwen` ecosystem's `version` field). The default and
   * `latest` both resolve to the currently-unresolvable `2512` resource, so we pin `2509` (verified). */
  version?: string;
  isNew?: boolean;
}

/** One base-model card (a family group). */
export interface ModelCard {
  /** Card id — the base-model `type`, or a synthetic family id where the source splits it. */
  type: string;
  name: string;
  code: string;
  media: Media;
  /** The dataset label format this model's auto-labeler defaults to. */
  label: LabelType;
  /** True when the model can train on EITHER tags or captions — the Data step then offers a choice,
   *  defaulting to `label`. Most models are single-format. */
  bothLabels?: boolean;
  description: string;
  /** Free-text badge on the card — 'recommended', 'anime', 'latest', anything. Absent means no badge.
   *  Independent of `TYPES[].recommended`, which picks the default selection rather than labelling it. */
  flag?: string;
  /** Newest / preferred first — `versions[0]` is the default selection. */
  versions: ModelVersionInfo[];
}

export const MODEL_CARDS: ModelCard[] = [
  // ---- Image · captions ----
  {
    type: 'flux',
    name: 'Flux',
    code: 'FL',
    media: 'image',
    label: 'caption',
    description: 'High-quality images and accurate text. Great all-rounder.',
    versions: [
      {
        key: 'flux_dev',
        label: 'Dev',
        note: 'best quality',
        air: 'urn:air:flux1:checkpoint:civitai:618692@691639',
        baseModel: 'Flux.1 D',
        ecosystem: 'flux1',
        modelVariant: 'dev',
      },
    ],
  },
  {
    type: 'flux2',
    name: 'Flux.2',
    code: 'F2',
    media: 'image',
    label: 'caption',
    description: 'Next-gen Flux. Highest fidelity.',
    versions: [
      {
        key: 'flux2_dev',
        label: 'Dev',
        note: 'latest',
        air: 'urn:air:flux2:checkpoint:civitai:2165902@2439067',
        baseModel: 'Flux.2 D',
        ecosystem: 'flux2',
        engine: 'flux2-dev',
        isNew: true,
      },
    ],
  },
  {
    type: 'flux2klein',
    name: 'Flux.2 Klein',
    code: 'FK',
    media: 'image',
    label: 'caption',
    description: 'Efficient Flux.2 Klein base models.',
    versions: [
      {
        key: 'flux2klein_9b',
        label: '9B Base',
        note: 'higher quality',
        air: 'urn:air:flux2klein:checkpoint:civitai:2322332@2612548',
        baseModel: 'Flux.2 Klein 9B-base',
        ecosystem: 'flux2klein',
        modelVariant: '9b',
      },
      {
        key: 'flux2klein_4b',
        label: '4B Base',
        note: 'efficient',
        air: 'urn:air:flux2klein:checkpoint:civitai:2322332@2612552',
        baseModel: 'Flux.2 Klein 4B-base',
        ecosystem: 'flux2klein',
        modelVariant: '4b',
      },
    ],
  },
  {
    type: 'chroma',
    name: 'Chroma',
    code: 'CH',
    media: 'image',
    label: 'caption',
    description: 'Open-source, uncensored, community-built.',
    versions: [
      {
        key: 'chroma',
        label: '1.0 HD',
        air: 'urn:air:chroma:checkpoint:civitai:1330309@2164239',
        baseModel: 'Chroma',
        ecosystem: 'chroma',
      },
    ],
  },
  {
    type: 'qwen',
    name: 'Qwen-Image',
    code: 'QW',
    media: 'image',
    label: 'caption',
    description: 'High-quality generation with strong understanding.',
    versions: [
      {
        key: 'qwen_image',
        label: 'Qwen-Image',
        air: 'urn:air:qwen:checkpoint:civitai:1864281@2110043',
        baseModel: 'Qwen',
        ecosystem: 'qwen',
        version: '2509',
      },
    ],
  },
  {
    type: 'zimage',
    name: 'ZImage',
    code: 'ZI',
    media: 'image',
    label: 'caption',
    description: 'High-speed image generation.',
    flag: 'recommended',
    versions: [
      {
        key: 'zimageturbo',
        label: 'Turbo',
        note: 'fast',
        air: 'urn:air:zimageturbo:checkpoint:civitai:2168935@2442439',
        baseModel: 'ZImageTurbo',
        ecosystem: 'zimageturbo',
      },
      {
        key: 'zimagebase',
        label: 'Base',
        air: 'urn:air:zimagebase:checkpoint:civitai:2342797@2635223',
        baseModel: 'ZImageBase',
        ecosystem: 'zimagebase',
      },
    ],
  },
  {
    type: 'hidream-o1',
    name: 'HiDream O1',
    code: 'HD',
    media: 'image',
    label: 'caption',
    description: "HiDream.ai's 8B unified transformer for text-to-image.",
    versions: [
      {
        key: 'hidream_o1',
        label: 'Standard',
        air: 'urn:air:hidreamo1:checkpoint:civitai:2618495@2939946',
        baseModel: 'HiDream-O1',
        ecosystem: 'hidream-o1',
        isNew: true,
      },
    ],
  },
  {
    type: 'ernie',
    name: 'Ernie',
    code: 'ER',
    media: 'image',
    label: 'caption',
    description: "Baidu's ERNIE image generation model.",
    versions: [
      {
        key: 'ernie',
        label: 'Ernie',
        air: 'urn:air:ernie:checkpoint:civitai:2548387@2863858',
        baseModel: 'Ernie',
        ecosystem: 'ernie',
      },
    ],
  },
  {
    type: 'anima',
    name: 'Anima',
    code: 'AN',
    media: 'image',
    label: 'tag',
    bothLabels: true,
    description: "CircleStone Labs' Anima image model (Base v1.0).",
    flag: 'anime',
    versions: [
      {
        key: 'anima',
        label: 'Base',
        air: 'urn:air:anima:checkpoint:civitai:2458426@2945208',
        baseModel: 'Anima',
        ecosystem: 'anima',
        isNew: true,
      },
    ],
  },
  {
    type: 'boogu',
    name: 'Boogu',
    code: 'BO',
    media: 'image',
    label: 'caption',
    description: "Boogu's unified multimodal image model (Base v0.1).",
    versions: [
      {
        key: 'boogu',
        label: 'Base',
        air: 'urn:air:boogu:repository:huggingface:Boogu/Boogu-Image-0.1-Base@main.tar',
        baseModel: 'Boogu',
        ecosystem: 'boogu',
        isNew: true,
      },
    ],
  },
  {
    type: 'krea2',
    name: 'Krea 2',
    code: 'K2',
    media: 'image',
    label: 'caption',
    description: "Krea AI's in-house image generation model.",
    flag: 'latest',
    versions: [
      {
        key: 'krea2',
        label: 'Base',
        air: 'urn:air:krea2:checkpoint:civitai:2656567@2983022',
        baseModel: 'Krea 2',
        ecosystem: 'krea2',
        isNew: true,
      },
    ],
  },
  {
    type: 'mageflow',
    name: 'Mage-Flow',
    code: 'MF',
    media: 'image',
    label: 'caption',
    description: "Microsoft's 4B native-resolution image model.",
    versions: [
      {
        key: 'mageflow',
        label: '4B Base',
        air: 'urn:air:mageflow:checkpoint:civitai:2812690@3172038',
        baseModel: 'MageFlow',
        ecosystem: 'mageflow',
        isNew: true,
      },
    ],
  },
  {
    type: 'ideogram4',
    name: 'Ideogram 4',
    code: 'ID',
    media: 'image',
    label: 'caption',
    description: "Ideogram's text-to-image model with strong typography.",
    versions: [
      {
        key: 'ideogram4',
        label: 'Base',
        air: 'urn:air:ideogram4:repository:huggingface:ideogram-ai/ideogram-4-nf4@main.tar',
        baseModel: 'Ideogram 4.0',
        ecosystem: 'ideogram4',
        isNew: true,
      },
    ],
  },
  // ---- Image · tags ----
  {
    type: 'sdxl',
    name: 'SDXL',
    code: 'XL',
    media: 'image',
    label: 'tag',
    description: 'Fast, versatile, huge community.',
    versions: [
      {
        key: 'sdxl',
        label: 'Standard',
        note: 'all purposes',
        air: 'urn:air:sdxl:checkpoint:civitai:101055@128078',
        baseModel: 'SDXL 1.0',
        ecosystem: 'sdxl',
      },
    ],
  },
  // Illustrious & Pony are SDXL-derived but treated as their own base models on-site (creators look for
  // them by name), so they're their own cards rather than SDXL versions.
  {
    type: 'illustrious',
    name: 'Illustrious',
    code: 'IL',
    media: 'image',
    label: 'tag',
    description: 'SDXL-based, tuned for illustration / anime.',
    versions: [
      {
        key: 'illustrious',
        label: 'Illustrious',
        air: 'urn:air:sdxl:checkpoint:civitai:795765@889818',
        baseModel: 'Illustrious',
        ecosystem: 'sdxl',
      },
    ],
  },
  {
    type: 'pony',
    name: 'Pony',
    code: 'PN',
    media: 'image',
    label: 'tag',
    description: 'SDXL-based, tuned for anthro / stylized.',
    versions: [
      {
        key: 'pony',
        label: 'Pony',
        air: 'urn:air:sdxl:checkpoint:civitai:257749@290640',
        baseModel: 'Pony',
        ecosystem: 'sdxl',
      },
    ],
  },
  {
    type: 'sd15',
    name: 'SD 1.5',
    code: '1.5',
    media: 'image',
    label: 'tag',
    description: 'Cheapest and fastest. Lower fidelity.',
    versions: [
      {
        key: 'sd_1_5',
        label: 'Standard',
        note: 'all purposes',
        air: 'urn:air:sd1:checkpoint:civitai:127227@139180',
        baseModel: 'SD 1.5',
        ecosystem: 'sd1',
      },
      {
        key: 'semi',
        label: 'Semi Real',
        note: 'anime + realism',
        air: 'urn:air:sd1:checkpoint:civitai:4384@128713',
        baseModel: 'SD 1.5',
        ecosystem: 'sd1',
      },
      {
        key: 'realistic',
        label: 'Realistic',
        air: 'urn:air:sd1:checkpoint:civitai:81458@132760',
        baseModel: 'SD 1.5',
        ecosystem: 'sd1',
      },
      {
        key: 'anime',
        label: 'Anime',
        air: 'urn:air:sd1:checkpoint:civitai:84586@89927',
        baseModel: 'SD 1.5',
        ecosystem: 'sd1',
      },
    ],
  },
  // ---- Video · captions ----
  {
    type: 'wan',
    name: 'Wan',
    code: 'WAN',
    media: 'video',
    label: 'caption',
    description: 'Performant, high-quality video LoRA training.',
    versions: [
      {
        key: 'wan_2_2_t2v_a14b',
        label: '2.2 T2V',
        note: 'latest',
        air: 'urn:air:wanvideo-22-t2v-a14b:checkpoint:civitai:1817671@2114154',
        baseModel: 'Wan Video 2.2 T2V-A14B',
        ecosystem: 'wan',
        modelVariant: '2.2',
        isNew: true,
      },
      {
        key: 'wan_2_1_t2v_14b',
        label: '2.1 T2V',
        air: 'urn:air:wanvideo:vae:huggingface:Wan-AI/Wan2.1-I2V-14B-720P@main/Wan2.1_VAE.pth',
        baseModel: 'Wan Video 14B t2v',
        ecosystem: 'wan',
        modelVariant: '2.1',
      },
    ],
  },
  {
    type: 'hunyuan',
    name: 'Hunyuan',
    code: 'HY',
    media: 'video',
    label: 'caption',
    description: 'Performant video generation (720p).',
    versions: [
      {
        key: 'hy_720_fp8',
        label: '720p [fp8]',
        air: 'urn:air:hyv1:vae:huggingface:tencent/HunyuanVideo@main/hunyuan-video-t2v-720p/vae/pytorch_model.pt',
        baseModel: 'Hunyuan Video',
        ecosystem: 'wan',
        // The `wan` ecosystem is a discriminated union on `modelVariant`; Hunyuan prices under 2.1.
        modelVariant: '2.1',
      },
    ],
  },
  {
    type: 'ltx',
    name: 'LTX',
    code: 'LTX',
    media: 'video',
    label: 'caption',
    description: 'Lightricks video generation.',
    versions: [
      {
        key: 'ltx25',
        label: '2.5',
        note: 'latest',
        air: 'urn:air:ltxv25:repository:huggingface:Lightricks/LTX-Video@main.tar',
        baseModel: 'LTXV 2.5',
        ecosystem: 'ltx25',
        isNew: true,
      },
      {
        key: 'ltx23',
        label: '2.3',
        air: 'urn:air:ltxv23:checkpoint:civitai:2445735@2749908',
        baseModel: 'LTXV 2.3',
        ecosystem: 'ltx23',
      },
      {
        key: 'ltx2',
        label: '2.0',
        air: 'urn:air:ltx2:checkpoint:civitai:2291192@2578325',
        baseModel: 'LTXV2',
        ecosystem: 'ltx2',
      },
    ],
  },
  {
    type: 'minimaxh3',
    name: 'MiniMax H3',
    code: 'H3',
    media: 'video',
    label: 'caption',
    description: 'MiniMax H3 video generation.',
    flag: 'recommended',
    versions: [
      {
        key: 'minimaxh3',
        label: 'Base',
        air: 'urn:air:minimaxh3:repository:huggingface:MiniMaxAI/MiniMax-H3@main.tar',
        baseModel: 'MiniMax H3',
        ecosystem: 'minimaxh3',
        isNew: true,
      },
    ],
  },
  // ---- Audio · captions ----
  {
    type: 'acestep',
    name: 'ACE-Step',
    code: 'ACE',
    media: 'audio',
    label: 'caption',
    description: 'ACE-Step music / audio LoRA training.',
    flag: 'recommended',
    versions: [
      {
        key: 'acestep_15',
        label: '1.5 (3.5B)',
        air: 'urn:air:ace:checkpoint:civitai:2549270@2864864',
        baseModel: 'ACE-Step',
        ecosystem: 'ace_step_15',
      },
      {
        key: 'acestep_15_xl_base',
        label: 'XL Base (4B)',
        air: 'urn:air:ace:checkpoint:civitai:2549270@2864892',
        baseModel: 'ACE-Step',
        ecosystem: 'ace_step_15_xl',
        modelVariant: 'base',
      },
      {
        key: 'acestep_15_xl_sft',
        label: 'XL SFT (4B)',
        air: 'urn:air:ace:checkpoint:civitai:2549270@2864917',
        baseModel: 'ACE-Step',
        ecosystem: 'ace_step_15_xl',
        modelVariant: 'sft',
      },
    ],
  },
];

/** Media the training produces — the primary choice, like the prod trainer's image/video/audio toggle. */
export const MEDIA_OPTIONS: { id: Media; name: string; icon: string }[] = [
  { id: 'image', name: 'Image', icon: '🖼️' },
  { id: 'video', name: 'Video', icon: '🎬' },
  { id: 'audio', name: 'Audio', icon: '🎵' },
];

/** LoRA "type" (Character/Style/Concept/Effect) → per-media recommended card + step tuning. */
export interface LoraType {
  id: string;
  name: string;
  icon: string;
  /** Which media this type applies to. */
  medias: Media[];
  /** Recommended base-model card `type` per media. */
  recommended: Partial<Record<Media, string>>;
  /** Default per-item "seen" target used to compute a starting step count. */
  seen: number;
  /** Warn below this item count for this type. */
  minImg: number;
}

export const LORA_TYPES: LoraType[] = [
  {
    id: 'character',
    name: 'Character',
    icon: '🧍',
    medias: ['image', 'video'],
    recommended: { image: 'zimage', video: 'minimaxh3' },
    seen: 100,
    minImg: 10,
  },
  {
    id: 'style',
    name: 'Style',
    icon: '🎨',
    medias: ['image', 'video', 'audio'],
    recommended: { image: 'zimage', video: 'minimaxh3', audio: 'acestep' },
    seen: 150,
    minImg: 15,
  },
  {
    id: 'concept',
    name: 'Concept',
    icon: '💡',
    medias: ['image', 'video', 'audio'],
    recommended: { image: 'zimage', video: 'minimaxh3', audio: 'acestep' },
    seen: 150,
    minImg: 15,
  },
  {
    id: 'effect',
    name: 'Effect',
    icon: '✨',
    medias: ['video'],
    recommended: { video: 'minimaxh3' },
    seen: 150,
    minImg: 20,
  },
];

export const typesForMedia = (media: Media): LoraType[] =>
  LORA_TYPES.filter((t) => t.medias.includes(media));

/** LoRA type by id, falling back to the first type so callers never read `undefined`. */
export const loraTypeById = (id: string): LoraType =>
  LORA_TYPES.find((t) => t.id === id) ?? LORA_TYPES[0]!;

export const cardByType = (type: string): ModelCard | undefined =>
  MODEL_CARDS.find((c) => c.type === type);

export const cardsForMedia = (media: Media): ModelCard[] =>
  MODEL_CARDS.filter((c) => c.media === media);

/** Resolve a training workflow's exact base model from the `air` on its training step. */
export const findByAir = (
  air: string
): { card: ModelCard; version: ModelVersionInfo } | undefined => {
  for (const card of MODEL_CARDS) {
    const version = card.versions.find((v) => v.air === air);
    if (version) return { card, version };
  }
  return undefined;
};

/** First card in an ecosystem (e.g. `sdxl`) — a coarser fallback when the exact `air` isn't in the catalog. */
export const cardByEcosystem = (ecosystem: string): ModelCard | undefined =>
  MODEL_CARDS.find((c) => c.versions.some((v) => v.ecosystem === ecosystem));

/** Extra Buzz for training on top of a user-supplied custom model. */
export const CUSTOM_MODEL_SURCHARGE = 500;

// ---- Advanced training parameters (AI-Toolkit) ----
// VENDORED from the main app's `trainingSettings` (src/components/Training/Form/TrainingParams.tsx),
// resolved for engine `ai-toolkit` the way the trainer does in getDefaultTrainingParams
// (src/store/training.store.ts:287): `overrides[key].all.default ?? overrides[key]['ai-toolkit'].default ??
// base.default`, keyed by ModelVersionInfo.key (== the main app's TrainingDetailsBaseModel override key).
// Re-mirror by hand when the trainer's numbers change. Flux.2 (imageResourceTraining) takes NO
// hyperparameters, so its version key is intentionally absent (the Review step hides the panel for it).

/** AI-Toolkit epoch (= saved-checkpoint) bounds — flat for every model (TrainingParams.tsx `AI_TOOLKIT_EPOCHS`). */
export const AI_TOOLKIT_EPOCHS = { min: 1, max: 20, step: 1 } as const;

/** Per-run advanced defaults. `textEncoderLr: 0` means text-encoder training is off for that model
 *  (the submit sets `trainTextEncoder = textEncoderLr > 0`). */
export interface RunParamDefaults {
  epochs: number;
  unetLr: number;
  textEncoderLr: number;
  networkDim: number;
  networkAlpha: number;
  resolution: number;
  batchSize: number;
  lrScheduler: string;
  optimizer: string;
}

// Modern caption models cluster on the same values; SD-family and a few others deviate. Every field below
// is the ai-toolkit-resolved value from the source (batchSize already clamped to `aiToolkitBatchMax`, and
// `lrScheduler` normalized off the invalid-for-ai-toolkit `cosine_with_restarts` to `cosine`).
export const PARAM_DEFAULTS: Record<string, RunParamDefaults> = {
  // — SD 1.5 family (tags) —
  sd_1_5: {
    epochs: 10,
    unetLr: 5e-4,
    textEncoderLr: 5e-5,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 512,
    batchSize: 4,
    lrScheduler: 'cosine',
    optimizer: 'Adafactor',
  },
  semi: {
    epochs: 10,
    unetLr: 5e-4,
    textEncoderLr: 5e-5,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 512,
    batchSize: 4,
    lrScheduler: 'cosine',
    optimizer: 'AdamW8Bit',
  },
  realistic: {
    epochs: 10,
    unetLr: 5e-4,
    textEncoderLr: 5e-5,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 512,
    batchSize: 2,
    lrScheduler: 'cosine',
    optimizer: 'AdamW8Bit',
  },
  anime: {
    epochs: 10,
    unetLr: 5e-4,
    textEncoderLr: 1e-4,
    networkDim: 16,
    networkAlpha: 32,
    resolution: 512,
    batchSize: 4,
    lrScheduler: 'cosine',
    optimizer: 'AdamW8Bit',
  },
  // — SDXL family (tags) —
  sdxl: {
    epochs: 10,
    unetLr: 5e-4,
    textEncoderLr: 5e-5,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 4,
    lrScheduler: 'cosine',
    optimizer: 'Adafactor',
  },
  pony: {
    epochs: 10,
    unetLr: 5e-4,
    textEncoderLr: 5e-5,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 4,
    lrScheduler: 'cosine',
    optimizer: 'Adafactor',
  },
  illustrious: {
    epochs: 10,
    unetLr: 5e-4,
    textEncoderLr: 5e-5,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 4,
    lrScheduler: 'cosine',
    optimizer: 'Adafactor',
  },
  // — Modern caption image models —
  flux_dev: {
    epochs: 5,
    unetLr: 5e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 16,
    resolution: 512,
    batchSize: 1,
    lrScheduler: 'cosine',
    optimizer: 'AdamW8Bit',
  },
  chroma: {
    epochs: 5,
    unetLr: 5e-4,
    textEncoderLr: 0,
    networkDim: 2,
    networkAlpha: 16,
    resolution: 512,
    batchSize: 1,
    lrScheduler: 'cosine',
    optimizer: 'AdamW8Bit',
  },
  qwen_image: {
    epochs: 5,
    unetLr: 5e-4,
    textEncoderLr: 0,
    networkDim: 2,
    networkAlpha: 16,
    resolution: 512,
    batchSize: 1,
    lrScheduler: 'cosine',
    optimizer: 'AdamW8Bit',
  },
  zimageturbo: {
    epochs: 10,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 2,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  zimagebase: {
    epochs: 10,
    unetLr: 1e-6,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 2,
    lrScheduler: 'cosine',
    optimizer: 'Automagic',
  },
  flux2klein_9b: {
    epochs: 10,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 2,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  flux2klein_4b: {
    epochs: 10,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 2,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  hidream_o1: {
    epochs: 5,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  anima: {
    epochs: 5,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  boogu: {
    epochs: 5,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  krea2: {
    epochs: 10,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  mageflow: {
    epochs: 10,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  ideogram4: {
    epochs: 10,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  // Ernie is newly added upstream with no param overrides — inherits the ai-toolkit base.
  ernie: {
    epochs: 10,
    unetLr: 5e-4,
    textEncoderLr: 5e-5,
    networkDim: 32,
    networkAlpha: 16,
    resolution: 512,
    batchSize: 2,
    lrScheduler: 'cosine',
    optimizer: 'AdamW8Bit',
  },
  // — Video (caption) — resolution is fixed per ecosystem upstream —
  wan_2_2_t2v_a14b: {
    epochs: 10,
    unetLr: 2e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 1,
    resolution: 960,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  wan_2_1_t2v_14b: {
    epochs: 10,
    unetLr: 2e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 1,
    resolution: 960,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  hy_720_fp8: {
    epochs: 10,
    unetLr: 2e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 1,
    resolution: 960,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  ltx25: {
    epochs: 10,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 960,
    batchSize: 1,
    lrScheduler: 'cosine',
    optimizer: 'AdamW8Bit',
  },
  ltx23: {
    epochs: 10,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 960,
    batchSize: 1,
    lrScheduler: 'cosine',
    optimizer: 'AdamW8Bit',
  },
  ltx2: {
    epochs: 10,
    unetLr: 2e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 1,
    resolution: 960,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  minimaxh3: {
    epochs: 10,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 960,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  // — Audio (caption) — no spatial resolution; kept at 512 to satisfy the schema —
  acestep_15: {
    epochs: 5,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 512,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  acestep_15_xl_base: {
    epochs: 5,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 512,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
  acestep_15_xl_sft: {
    epochs: 5,
    unetLr: 1e-4,
    textEncoderLr: 0,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 512,
    batchSize: 1,
    lrScheduler: 'constant',
    optimizer: 'AdamW8Bit',
  },
};

// Fallback for a version key with no explicit entry (e.g. the "Custom…" version) — the modern-caption base.
const PARAM_FALLBACK: RunParamDefaults = {
  epochs: 10,
  unetLr: 1e-4,
  textEncoderLr: 0,
  networkDim: 32,
  networkAlpha: 32,
  resolution: 1024,
  batchSize: 1,
  lrScheduler: 'constant',
  optimizer: 'AdamW8Bit',
};

/** SDXL-family cards (tags) allow bigger nets and higher resolution than the base ai-toolkit bounds. */
const SDXL_FAMILY = new Set(['sdxl', 'pony', 'illustrious']);

/** AI-Toolkit batch-size ceiling per card family (TrainingParams.tsx `aiToolkitBatchMax`). */
function batchMaxForCard(cardType: string): number {
  if (cardType === 'sdxl' || cardType === 'sd15' || SDXL_FAMILY.has(cardType)) return 4;
  if (cardType === 'zimage' || cardType === 'ernie' || cardType === 'flux2klein') return 2;
  return 1;
}

/** The advanced-param defaults for a chosen version (falls back to the card's primary version, then the
 *  modern-caption base — so a "Custom…" pick still gets sensible per-family values). */
export function paramsForVersion(card: ModelCard, versionKey: string): RunParamDefaults {
  return PARAM_DEFAULTS[versionKey] ?? PARAM_DEFAULTS[card.versions[0]!.key] ?? PARAM_FALLBACK;
}

export interface ParamBound {
  min: number;
  max: number;
  step: number;
}

/** Per-field input bounds for a card — mirrors the ai-toolkit constraints: SDXL-family gets 256-dim nets and
 *  1024–2048 resolution; batch is capped per family; epochs are 1–20; LR is 0–1. */
export function paramBounds(card: ModelCard): Record<string, ParamBound> {
  const sdxl = SDXL_FAMILY.has(card.type);
  const video = card.media === 'video';
  const audio = card.media === 'audio';
  const netMax = sdxl ? 256 : 128;
  return {
    epochs: { ...AI_TOOLKIT_EPOCHS },
    unetLr: { min: 0, max: 1, step: 1e-5 },
    textEncoderLr: { min: 0, max: 1, step: 1e-5 },
    networkDim: { min: 1, max: netMax, step: 1 },
    networkAlpha: { min: 1, max: netMax, step: 1 },
    // Video/audio resolution is fixed upstream; images range per family.
    resolution: video
      ? { min: 960, max: 960, step: 1 }
      : audio
      ? { min: 512, max: 512, step: 1 }
      : sdxl
      ? { min: 1024, max: 2048, step: 64 }
      : { min: 512, max: 1024, step: 64 },
    batchSize: { min: 1, max: batchMaxForCard(card.type), step: 1 },
  };
}

/** Per-card "from" price map keyed by `ModelCard.type`, quoted live from the orchestrator `whatif` (see
 * `$lib/server/pricing`). PARTIAL: a model the orchestrator can't price is simply absent — there is no
 * static fallback, so callers must handle a missing entry (show "—", not a guessed number). */
export type FromPrices = Record<string, number>;
