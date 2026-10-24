import type { ModelVersionTerms } from '@civitai/buzz';
import type { Range } from '~/shared/constants/basemodel.constants';
import type { Availability, MediaType, ModelType } from '~/shared/utils/prisma/enums';

export type ResourceSettings = {
  strength: Range;
  clipSkip?: number;
  /** A checkpoint's companion turbo LoRA; `strength` overrides the LoRA's own default. */
  turboLora?: { id: number; strength?: number };
};

/** Advisory bands inside the generator's own range, which the user may leave. */
export type RecommendedSettings = { steps?: Range; cfgScale?: Range };

type NodeRef = [string, number];
export type ComfyNode = {
  inputs: Record<string, number | string | NodeRef>;
  class_type: string;
  _meta?: Record<string, string>;
  _children?: { node: ComfyNode; inputKey: string }[];
};

export type GenerationResourceBase = {
  id: number;
  name: string;
  trainedWords: string[];
  baseModel: string;
  paidAccess?: { endsAt: Date | null; terms: ModelVersionTerms } | null;
  canGenerate: boolean;
  hasAccess: boolean;
  air?: string;
  additionalResourceCost?: boolean;
  availability?: Availability;
  epochNumber?: number;
  settings: ResourceSettings;
  /** A distilled variant; the band it runs at is in `recommendedSettings`. */
  turbo?: boolean;
  recommendedSettings?: RecommendedSettings;
  /** Whether the current user owns the model this resource belongs to (computed by server) */
  isOwnedByUser?: boolean;
  /** Whether this resource is private (Private availability, or unpublished with epoch details) (computed by server) */
  isPrivate?: boolean;
  /** Whether this resource's owner can receive a creator-tip share (computed by server) */
  tipsEnabled?: boolean;
  /**
   * Stamped by `getResourceData` for `Wildcards`-type ModelVersions. The
   * resolved `WildcardSet.id` corresponding to this ModelVersion — present
   * only when `model.type === 'Wildcards'` and the provisioning service has
   * a set for it. Downstream callers (form hydration, orchestrator) use
   * this as the signal to partition the entry out of `resources[]` and
   * into `snippets.wildcardSetIds`. See docs/features/prompt-snippets-v1.md
   * §"Wildcards models vs generation resources".
   */
  wildcardSetId?: number;
  /**
   * Target version id from this version's `meta.generationAlias`, surfaced by
   * `getResourceData`. When present, this resource is a "cover" that should be
   * swapped for the target version before generation (e.g. image remix). See
   * `swapGenerationAliases`.
   */
  aliasId?: number | null;
};

/** A resource as the form holds it and the request carries it: the data plus the chosen weight. */
export type GenerationResourceValue = GenerationResource & { strength: number };

export type GenerationResource = GenerationResourceBase & {
  model: {
    id: number;
    name: string;
    type: ModelType;
    nsfw?: boolean;
    poi?: boolean;
    minor?: boolean;
    sfwOnly?: boolean;
    userId?: number;
  };
  epochDetails?: {
    jobId: string;
    fileName: string;
    epochNumber: number;
    isExpired: boolean;
  };
  substitute?: GenerationResourceBase & { strength?: number };
  image?: {
    id: number;
    url: string;
    width: number;
    height: number;
    hash: string;
    type: MediaType;
    nsfwLevel: number;
  };
};
