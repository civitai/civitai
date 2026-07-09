import type { SessionUser } from '~/types/session';
import {
  commonAspectRatios,
  grokSizes,
  nanoBananaProSizes,
  qwenSizes,
  seedreamSizes,
} from '~/server/common/constants';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import {
  buildGenerationContext,
  generateFromGraph,
  whatIfFromGraph,
} from '~/server/services/orchestrator/orchestration-new.service';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

/**
 * Preset image generation
 * =========================
 * Shared submission path for "preset" image generation — generation against a
 * locked model version chosen by an app feature (the comics builder, the
 * iterative image editor, the enqueued-comic-panels job) rather than a model the
 * user picks in the main generator form.
 *
 * All of these funnel through the new generation-graph path
 * (`generateFromGraph` / `whatIfFromGraph`), so they share the same submission,
 * validation, gating, audit, and metadata pipeline as the main generator. This
 * module owns the model registry, the graph-input builder, and the
 * submit/what-if wrappers so callers don't duplicate them.
 */

export type PresetSize = { label: string; width: number; height: number };

export type PresetModelConfig = {
  engine: string;
  baseModel: string;
  /**
   * Ecosystem key for the generation graph (`ecosystemByKey`). Usually matches
   * `baseModel`, but differs where the graph ecosystem key and the legacy
   * baseModel name diverge (e.g. baseModel 'Flux.2 D' → ecosystem 'Flux2').
   * Required on the graph `input` so reference images route to `img2img:edit`.
   */
  ecosystem: string;
  versionId: number;
  img2imgVersionId?: number;
  maxReferenceImages: number;
  sizes: PresetSize[];
};

const OPENAI_SIZES: PresetSize[] = [
  { label: '1:1', width: 1024, height: 1024 },
  { label: '3:2', width: 1536, height: 1024 },
  { label: '2:3', width: 1024, height: 1536 },
];

/**
 * Registry of preset models keyed by the app-facing baseModel name. This is the
 * superset across all preset callers; each caller exposes whichever subset its
 * UI offers and supplies its own default key (see `getPresetModelConfig`).
 */
export const PRESET_MODEL_CONFIG: Record<string, PresetModelConfig> = {
  NanoBanana2: {
    // V2 is dispatched via the ecosystem handler at
    // `src/server/services/orchestrator/ecosystems/nano-banana.handler.ts`,
    // which keys off the resource versionId to produce the v2 input shape.
    engine: 'gemini',
    baseModel: 'NanoBanana',
    ecosystem: 'NanoBanana',
    versionId: 2725610,
    maxReferenceImages: 7,
    sizes: nanoBananaProSizes,
  },
  NanoBanana: {
    engine: 'gemini',
    baseModel: 'NanoBanana',
    ecosystem: 'NanoBanana',
    versionId: 2436219,
    maxReferenceImages: 7,
    sizes: nanoBananaProSizes,
  },
  Flux2: {
    engine: 'flux2',
    baseModel: 'Flux.2 D',
    ecosystem: 'Flux2',
    versionId: 2439067,
    maxReferenceImages: 7,
    sizes: commonAspectRatios,
  },
  Seedream: {
    engine: 'seedream',
    baseModel: 'Seedream',
    ecosystem: 'Seedream',
    versionId: 2470991,
    maxReferenceImages: 7,
    sizes: seedreamSizes,
  },
  OpenAI: {
    engine: 'openai',
    baseModel: 'OpenAI',
    ecosystem: 'OpenAI',
    versionId: 2512167,
    maxReferenceImages: 7,
    sizes: OPENAI_SIZES,
  },
  OpenAI2: {
    // gpt-image-2 — different API shape than v1/v1.5. Resolved by the openai
    // graph (`openai-graph.ts` maps versionId 2880272 to the `gpt2` variant)
    // and built by `openai.handler.ts`.
    engine: 'openai',
    baseModel: 'OpenAI',
    ecosystem: 'OpenAI',
    versionId: 2880272,
    maxReferenceImages: 7,
    sizes: OPENAI_SIZES,
  },
  Qwen: {
    engine: 'qwen',
    baseModel: 'Qwen',
    ecosystem: 'Qwen',
    versionId: 2552908,
    img2imgVersionId: 2558804,
    maxReferenceImages: 3,
    sizes: qwenSizes,
  },
  SeedreamLite: {
    engine: 'seedream',
    baseModel: 'Seedream',
    ecosystem: 'Seedream',
    versionId: 2720141,
    maxReferenceImages: 7,
    sizes: seedreamSizes,
  },
  Grok: {
    engine: 'grok',
    baseModel: 'Grok',
    ecosystem: 'Grok',
    versionId: 2738377,
    maxReferenceImages: 7,
    sizes: grokSizes,
  },
};

/** Resolve a model config by app-facing baseModel, falling back to `defaultKey`. */
export function getPresetModelConfig(
  baseModel: string | null | undefined,
  defaultKey: string
): PresetModelConfig {
  return PRESET_MODEL_CONFIG[baseModel ?? defaultKey] ?? PRESET_MODEL_CONFIG[defaultKey];
}

/**
 * Resolve a model config from a resource version id (matching either the
 * txt2img or img2img variant). Used by the enqueued-panels job, which persists
 * the version id rather than the app-facing model key.
 */
export function findPresetModelConfigByVersionId(versionId: number): PresetModelConfig | undefined {
  return Object.values(PRESET_MODEL_CONFIG).find(
    (c) => c.versionId === versionId || c.img2imgVersionId === versionId
  );
}

/**
 * Pick the dimensions for an aspect-ratio label from a model's `sizes`, falling
 * back to a portrait option and finally the first size. These dimensions are
 * used for stored panel metadata / display; the graph itself derives the
 * submitted dimensions from the aspect-ratio string.
 */
export function pickAspectRatioSize(aspectRatio: string, sizes: PresetSize[]): PresetSize {
  return (
    sizes.find((s) => s.label === aspectRatio) ??
    sizes.find((s) => s.label === '3:4' || s.label === 'Portrait') ??
    sizes[0]
  );
}

/** Cap reference images to prevent API rejection (too many images). */
export function capReferenceImages<T>(images: T[], max: number): T[] {
  if (images.length <= max) return images;
  return images.slice(0, max);
}

/**
 * Builds the generation-graph `input` for a preset generation.
 *
 * Mirrors what the main generator's form produces: a fixed `txt2img` workflow
 * (the service's `normalizeImageWorkflow` auto-promotes it to `img2img:edit`
 * when reference images are present and the ecosystem is edit-capable — every
 * preset ecosystem is), the ecosystem key, the locked model version, prompt,
 * aspect ratio, and quantity.
 *
 * `aspectRatio` is passed as a plain ratio string (e.g. `'3:4'`); the graph's
 * `aspectRatioNode` snaps it to the ecosystem's canonical dimensions, so width
 * and height are derived by the graph rather than supplied here.
 */
export function buildPresetGraphInput({
  prompt,
  aspectRatio,
  quantity,
  images,
  ecosystem,
  versionId,
}: {
  prompt?: string;
  aspectRatio: string;
  quantity: number;
  images?: { url: string; width: number; height: number }[] | null;
  ecosystem: string;
  versionId: number;
}): Record<string, unknown> {
  const input: Record<string, unknown> = {
    workflow: 'txt2img',
    ecosystem,
    model: { id: versionId },
    aspectRatio,
    quantity,
  };
  // Omit empty prompt so what-if's `cost-estimation` fallback can apply.
  if (prompt) input.prompt = prompt;
  // Presence of images is what drives the txt2img → img2img:edit promotion.
  if (images && images.length > 0) input.images = images;
  return input;
}

type PresetGenArgs = {
  prompt?: string;
  aspectRatio: string;
  quantity?: number;
  images?: { url: string; width: number; height: number }[] | null;
  modelConfig: PresetModelConfig;
  /** Override the resource version (e.g. a model's img2img variant). */
  versionIdOverride?: number;
  user: SessionUser;
  token: string;
  /** Buzz account types to spend from. Callers resolve these per their context. */
  currencies: BuzzSpendType[];
  /** Feature flags for gate enforcement; omit for non-request contexts (jobs). */
  flags?: Partial<FeatureAccess>;
  /** Workflow tags, e.g. `['comics']` / `['iterate']` (+ `'green'`). */
  tags: string[];
};

/**
 * Submit a preset image generation through the generation graph.
 *
 * `generateFromGraph` audits the prompt internally and enriches the resource
 * from `model.id`, so callers don't need a separate audit/enrich step. (The
 * enqueued-panels job keeps its own pre-submit audit because it runs outside
 * the tRPC request path — see that job for the rationale.)
 *
 * Returns the formatted generation response; callers consume `.id`.
 */
export async function submitPresetImageGen({
  prompt,
  aspectRatio,
  quantity = 1,
  images,
  modelConfig,
  versionIdOverride,
  user,
  token,
  currencies,
  flags,
  tags,
  isGreen,
  allowMatureContent,
  track,
}: PresetGenArgs & {
  isGreen?: boolean;
  allowMatureContent?: boolean;
  track?: any; // Tracker class from createContext
}) {
  const versionId = versionIdOverride ?? modelConfig.versionId;
  const cappedImages = images ? capReferenceImages(images, modelConfig.maxReferenceImages) : null;

  const input = buildPresetGraphInput({
    prompt,
    aspectRatio,
    quantity,
    images: cappedImages,
    ecosystem: modelConfig.ecosystem,
    versionId,
  });

  const { externalCtx } = await buildGenerationContext(user.tier ?? 'free', flags, {
    id: user.id,
    isModerator: user.isModerator,
  });

  return generateFromGraph({
    input,
    externalCtx,
    userId: user.id,
    token,
    isModerator: user.isModerator,
    isGreen,
    allowMatureContent,
    currencies: currencies as any,
    tags,
    track,
  });
}

/**
 * What-if cost estimate for a preset image generation. Returns `{ cost, ready }`.
 * Prompt is intentionally omittable — `whatIfFromGraph` supplies a
 * `cost-estimation` placeholder so validation passes without a real prompt.
 */
export async function whatIfPresetImageGen({
  prompt,
  aspectRatio,
  quantity = 1,
  images,
  modelConfig,
  versionIdOverride,
  user,
  token,
  currencies,
  flags,
}: Omit<PresetGenArgs, 'tags'>): Promise<{ cost: number; ready: boolean }> {
  const versionId = versionIdOverride ?? modelConfig.versionId;
  const cappedImages = images ? capReferenceImages(images, modelConfig.maxReferenceImages) : null;

  const input = buildPresetGraphInput({
    prompt,
    aspectRatio,
    quantity,
    images: cappedImages && cappedImages.length > 0 ? cappedImages : null,
    ecosystem: modelConfig.ecosystem,
    versionId,
  });

  const { externalCtx } = await buildGenerationContext(user.tier ?? 'free', flags, {
    id: user.id,
    isModerator: user.isModerator,
  });

  const result = await whatIfFromGraph({
    input,
    externalCtx,
    userId: user.id,
    isModerator: user.isModerator,
    token,
    currencies: currencies as any,
  });

  return { cost: result.cost?.total ?? 0, ready: result.ready };
}
