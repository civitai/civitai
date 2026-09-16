import { Air } from '@civitai/client';
import { ecosystems, getRootEcosystem } from '~/shared/constants/basemodel.constants';
import type { GenerationResource } from '~/shared/types/generation.types';
import { ModelType } from '~/shared/utils/prisma/enums';

type CivitaiAir = {
  source: 'civitai';
  version: number;
  model: number;
};

type OrchestratorAir = {
  source: 'orchestrator';
  jobId: string;
  fileName: string;
};

type AIR = {
  ecosystem: string;
  type: string;
  format?: string | undefined;
} & (CivitaiAir | OrchestratorAir);

export function parseAIR(identifier: string) {
  const { id, version, ...value } = Air.parse(identifier);
  return { ...value, model: Number(id), version: Number(version) };
}

export function parseAIRSafe(identifier: string | undefined) {
  if (identifier === undefined) return identifier;
  const match = Air.parseSafe(identifier);
  if (!match) return match;

  const { id, version, ...value } = match;
  return { ...value, model: Number(id), version: Number(version) };
}

export function isAir(identifier: string) {
  return Air.isAir(identifier);
}

/**
 * Link to a civitai model page for an AIR, or `null` when the AIR points
 * elsewhere. Only civitai AIRs carry numeric model/version ids; a HuggingFace
 * AIR (e.g. the video base models' training URNs) parses fine but its id
 * segments are strings, so `model`/`version` come out `NaN`.
 */
export function getCivitaiAirModelLink(identifier: string) {
  const parsed = parseAIRSafe(identifier);
  if (
    !parsed ||
    parsed.source !== 'civitai' ||
    !Number.isFinite(parsed.model) ||
    !Number.isFinite(parsed.version)
  )
    return null;
  return `/models/${parsed.model}?modelVersionId=${parsed.version}`;
}

export function getAirModelLink(identifier: string) {
  return getCivitaiAirModelLink(identifier) ?? '/';
}

const typeUrnMap: Partial<Record<ModelType, string>> = {
  [ModelType.AestheticGradient]: 'ag',
  [ModelType.Checkpoint]: 'checkpoint',
  [ModelType.Hypernetwork]: 'hypernet',
  [ModelType.TextualInversion]: 'embedding',
  [ModelType.MotionModule]: 'motion',
  [ModelType.Upscaler]: 'upscaler',
  [ModelType.VAE]: 'vae',
  [ModelType.LORA]: 'lora',
  [ModelType.DoRA]: 'dora',
  [ModelType.LoCon]: 'lycoris',
  [ModelType.Controlnet]: 'controlnet',
  [ModelType.TextEncoder]: 'text_encoders',
  [ModelType.UNet]: 'unet',
  [ModelType.CLIPVision]: 'clipvision',
  [ModelType.CLIP]: 'clip',
  [ModelType.VisionLanguage]: 'visionlanguage',
};

/**
 * Override map keyed on `ModelFile.type` (not `ModelType`). A Checkpoint model
 * whose primary weight file is a standalone diffusion model / UNET ships only the
 * denoiser (no VAE/text-encoder baked in), so its AIR should advertise that file
 * kind rather than the generic `checkpoint`. Used by `stringifyAIR` when a
 * `fileType` is supplied. e.g. Flux / Wan / ZImage / Anima / Boogu checkpoints.
 */
const fileTypeUrnMap: Record<string, string> = {
  'Diffusion Model': 'diffusionmodel',
  UNet: 'unet',
};

/** Reverse map: URN type string → ModelType enum value */
const urnToModelTypeMap = new Map(
  Object.entries(typeUrnMap).map(([modelType, urn]) => [urn, modelType as ModelType])
);

/** Convert a lowercase URN type (from AIR) to its PascalCase ModelType equivalent */
export function urnToModelType(urnType: string): string {
  return urnToModelTypeMap.get(urnType) ?? urnType;
}

/**
 * The `<ecosystem>` segment of an AIR: the root ecosystem's key, lowercased.
 * Also the key the orchestrator's prompt-analysis service stores guides under,
 * so both must derive it the same way or a generation and its prompt analysis
 * disagree about which ecosystem they belong to.
 *
 * Accepts a base model name or an ecosystem key. Unresolvable input is passed
 * through lowercased rather than throwing — callers send user-influenced values.
 */
export function getAirEcosystem(baseModelOrKey: string) {
  let ecosystem = baseModelOrKey;
  try {
    ecosystem = getRootEcosystem(baseModelOrKey).key;
  } catch {}
  // Upscaler models use 'Other' in AIR for backwards compatibility
  if (ecosystem === 'Upscaler') ecosystem = 'Other';
  return ecosystem.toLowerCase();
}

/**
 * A raw orchestrator blob AIR — a training epoch's weights addressed directly
 * (`urn:air:<ecosystem>:lora:orchestrator:blob@<blobKey>`), with no ModelVersion
 * row behind it. Built by the Training Studio (see its `loraBlobAir`) for the
 * "generate with this epoch" handoff. In generation form/graph data these travel
 * as resources with a synthetic NEGATIVE id plus `air` + `workflowId`; the
 * workflowId is required server-side to prove the caller owns the training run.
 */
export type RawAirResource = {
  id: number;
  air: string;
  /** Training workflow the blob came from — the ownership proof. */
  workflowId?: string;
  strength?: number;
  name?: string;
};

export function parseRawAirResourceUrn(identifier: string) {
  const parsed = Air.parseSafe(identifier);
  if (!parsed) return null;
  if (parsed.source !== 'orchestrator' || parsed.type !== 'lora' || parsed.id !== 'blob')
    return null;
  const blobKey = String(parsed.version ?? '');
  if (!blobKey) return null;
  return { ecosystem: parsed.ecosystem, blobKey };
}

/**
 * The ecosystem record whose key matches an AIR `<ecosystem>` segment
 * (case-insensitive — AIR segments are lowercased keys, root or child).
 */
export function getEcosystemByAirSegment(segment: string) {
  const lower = segment.toLowerCase();
  return ecosystems.find((e) => e.key.toLowerCase() === lower);
}

export function isRawAirResource<T extends { id?: unknown; air?: unknown }>(
  resource: T
): resource is T & { id: number; air: string } {
  return typeof resource.id === 'number' && resource.id < 0 && typeof resource.air === 'string';
}

/**
 * Deterministic negative id for a raw AIR resource (FNV-1a over the urn).
 * Negative so it can never collide with a ModelVersion id, and stable so the
 * same epoch dedupes in the form and keys the server's AIR map consistently.
 */
export function rawAirResourceId(air: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < air.length; i++) {
    hash ^= air.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return -((hash >>> 0) % 0x7fffffff || 1);
}

/**
 * Full display/remix shape for a raw AIR resource, built entirely from its
 * stored fields — there is no ModelVersion row to hydrate from. Used by the
 * Training Studio handoff seed and by the workflow read path (so queue items
 * keep the epoch in their resource list instead of dropping it at hydration).
 */
export function rawAirGenerationResource(stored: {
  id: number;
  air: string;
  workflowId?: string;
  name?: string | null;
  strength?: number;
  baseModel?: string;
}): GenerationResource & { air: string; workflowId?: string } {
  const label = stored.name?.trim() || 'Training epoch';
  return {
    id: stored.id,
    name: label,
    trainedWords: [],
    baseModel: stored.baseModel ?? '',
    canGenerate: true,
    hasAccess: true,
    strength: stored.strength ?? 1,
    minStrength: -1,
    maxStrength: 2,
    air: stored.air,
    workflowId: stored.workflowId,
    model: { id: stored.id, name: label, type: ModelType.LORA },
  };
}

export function stringifyAIR({
  baseModel,
  type,
  modelId,
  id,
  fileId,
  fileType,
  source = 'civitai',
}: {
  baseModel: string;
  type: ModelType;
  modelId: number | string;
  id?: number | string;
  /** Optional ModelFile id; emitted as `+<fileId>` so the orchestrator can
   * disambiguate among multiple files attached to the same version. */
  fileId?: number | string;
  /** Optional `ModelFile.type` of the primary/selected file. When it maps to a
   * standalone weight kind (`Diffusion Model`, `UNet`), it overrides the
   * model-type-derived AIR type — e.g. a Checkpoint shipping a diffusion-model
   * file becomes `...:diffusionmodel:...` instead of `...:checkpoint:...`. */
  fileType?: string;
  source?: string;
}) {
  const urnType =
    (fileType ? fileTypeUrnMap[fileType] : undefined) ?? typeUrnMap[type] ?? 'unknown';

  return Air.stringify({
    ecosystem: getAirEcosystem(baseModel),
    type: urnType,
    source,
    id: String(modelId),
    version: String(id),
    modelFileId: fileId !== undefined && fileId !== null ? String(fileId) : undefined,
  });
}
