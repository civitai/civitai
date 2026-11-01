import type { SessionUser } from '~/types/session';
import { resolveAspectRatioLabel } from '~/shared/form-graph/generation/defs';
import { PRESET_MODEL_GRAPH_SIZES, type PresetSize } from '~/shared/generation/preset-sizes';
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

export type { PresetSize };

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
  /** Sent to the graph when its default differs from the resolution `sizes` are listed at. */
  resolution?: string;
};

/**
 * Registry of preset models keyed by the app-facing baseModel name. This is the
 * superset across all preset callers; each caller exposes whichever subset its
 * UI offers and supplies its own default key (see `getPresetModelConfig`).
 */
export const PRESET_MODEL_CONFIG: Record<string, PresetModelConfig> = {
  NanoBanana2: {
    // V2 is dispatched by `form-graph/nano-banana.handler.ts` off the resource
    // versionId, not from anything in this config.
    engine: 'gemini',
    baseModel: 'NanoBanana',
    ecosystem: 'NanoBanana',
    versionId: 2725610,
    maxReferenceImages: 7,
    sizes: PRESET_MODEL_GRAPH_SIZES.NanoBanana2,
  },
  NanoBanana: {
    engine: 'gemini',
    baseModel: 'NanoBanana',
    ecosystem: 'NanoBanana',
    versionId: 2436219,
    maxReferenceImages: 7,
    sizes: PRESET_MODEL_GRAPH_SIZES.NanoBanana,
  },
  Flux2: {
    engine: 'flux2',
    baseModel: 'Flux.2 D',
    ecosystem: 'Flux2',
    versionId: 2439067,
    maxReferenceImages: 7,
    sizes: PRESET_MODEL_GRAPH_SIZES.Flux2,
  },
  Seedream: {
    engine: 'seedream',
    baseModel: 'Seedream',
    ecosystem: 'Seedream',
    versionId: 2470991,
    maxReferenceImages: 7,
    sizes: PRESET_MODEL_GRAPH_SIZES.Seedream,
    resolution: '2K',
  },
  OpenAI: {
    engine: 'openai',
    baseModel: 'OpenAI',
    ecosystem: 'OpenAI',
    versionId: 2512167,
    maxReferenceImages: 7,
    sizes: PRESET_MODEL_GRAPH_SIZES.OpenAI,
  },
  OpenAI2: {
    // gpt-image-2 — different API shape than v1/v1.5. Resolved by the openai
    // graph (`image/openai.graph.ts` maps versionId 2880272 to the `gpt2` variant)
    // and built by `openai.handler.ts`.
    engine: 'openai',
    baseModel: 'OpenAI',
    ecosystem: 'OpenAI',
    versionId: 2880272,
    maxReferenceImages: 7,
    sizes: PRESET_MODEL_GRAPH_SIZES.OpenAI2,
  },
  OpenAI25Flare: {
    engine: 'openai',
    baseModel: 'OpenAI',
    ecosystem: 'OpenAI',
    versionId: 3311434,
    maxReferenceImages: 7,
    sizes: PRESET_MODEL_GRAPH_SIZES.OpenAI25Flare,
  },
  OpenAI25Sunburst: {
    engine: 'openai',
    baseModel: 'OpenAI',
    ecosystem: 'OpenAI',
    versionId: 3311436,
    maxReferenceImages: 7,
    sizes: PRESET_MODEL_GRAPH_SIZES.OpenAI25Sunburst,
  },
  Qwen: {
    engine: 'qwen',
    baseModel: 'Qwen',
    ecosystem: 'Qwen',
    versionId: 2552908,
    img2imgVersionId: 2558804,
    maxReferenceImages: 3,
    sizes: PRESET_MODEL_GRAPH_SIZES.Qwen,
  },
  SeedreamLite: {
    engine: 'seedream',
    baseModel: 'Seedream',
    ecosystem: 'Seedream',
    versionId: 2720141,
    maxReferenceImages: 7,
    sizes: PRESET_MODEL_GRAPH_SIZES.SeedreamLite,
    resolution: '2K',
  },
  Grok: {
    engine: 'grok',
    baseModel: 'Grok',
    ecosystem: 'Grok',
    versionId: 2738377,
    maxReferenceImages: 7,
    sizes: PRESET_MODEL_GRAPH_SIZES.Grok,
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

/** Stored panel metadata only, resolved by the graph's own rule so the record matches the image. */
export function pickAspectRatioSize(aspectRatio: string, sizes: PresetSize[]): PresetSize {
  return resolveAspectRatioLabel(
    aspectRatio,
    sizes,
    sizes.find((s) => s.value === '1:1') ?? sizes[0]
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
 * `aspectRatioDef` snaps it to the ecosystem's canonical dimensions, so width
 * and height are derived by the graph rather than supplied here.
 */
export function buildPresetGraphInput({
  prompt,
  aspectRatio,
  quantity,
  images,
  ecosystem,
  versionId,
  resolution,
}: {
  prompt?: string;
  aspectRatio: string;
  quantity: number;
  images?: { url: string; width: number; height: number }[] | null;
  ecosystem: string;
  versionId: number;
  resolution?: string;
}): Record<string, unknown> {
  const input: Record<string, unknown> = {
    workflow: 'txt2img',
    ecosystem,
    model: { id: versionId },
    aspectRatio,
    quantity,
  };
  if (resolution) input.resolution = resolution;
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
    resolution: modelConfig.resolution,
  });

  const { externalCtx } = await buildGenerationContext(
    user.tier ?? 'free',
    flags,
    { id: user.id, isModerator: user.isModerator },
    // #3520: comics / preset generation composes the graph input SERVER-side, so
    // a substitution here is a config/preset-registry problem, not an app-author
    // or a stale-localStorage one. Its own `surface` keeps it out of both the
    // on-site and the App Blocks numbers.
    'preset'
  );

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
    inputGate: 'checked-by-caller',
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
    resolution: modelConfig.resolution,
  });

  const { externalCtx } = await buildGenerationContext(
    user.tier ?? 'free',
    flags,
    { id: user.id, isModerator: user.isModerator },
    // #3520: comics / preset generation composes the graph input SERVER-side, so
    // a substitution here is a config/preset-registry problem, not an app-author
    // or a stale-localStorage one. Its own `surface` keeps it out of both the
    // on-site and the App Blocks numbers.
    'preset'
  );

  const result = await whatIfFromGraph({
    input,
    externalCtx,
    userId: user.id,
    isModerator: user.isModerator,
    token,
    currencies: currencies as any,
    inputGate: 'checked-by-caller',
  });

  return { cost: result.cost?.total ?? 0, ready: result.ready };
}
