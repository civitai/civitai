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
  label: LabelType;
  description: string;
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
    label: 'caption',
    description: "CircleStone Labs' Anima image model (Base v1.0).",
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
    recommended: { image: 'zimage', video: 'wan' },
    seen: 100,
    minImg: 10,
  },
  {
    id: 'style',
    name: 'Style',
    icon: '🎨',
    medias: ['image', 'video', 'audio'],
    recommended: { image: 'zimage', video: 'wan', audio: 'acestep' },
    seen: 150,
    minImg: 15,
  },
  {
    id: 'concept',
    name: 'Concept',
    icon: '💡',
    medias: ['image', 'video', 'audio'],
    recommended: { image: 'zimage', video: 'wan', audio: 'acestep' },
    seen: 150,
    minImg: 15,
  },
  {
    id: 'effect',
    name: 'Effect',
    icon: '✨',
    medias: ['video'],
    recommended: { video: 'wan' },
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

/** Per-card "from" price map keyed by `ModelCard.type`, quoted live from the orchestrator `whatif` (see
 * `$lib/server/pricing`). PARTIAL: a model the orchestrator can't price is simply absent — there is no
 * static fallback, so callers must handle a missing entry (show "—", not a guessed number). */
export type FromPrices = Record<string, number>;
