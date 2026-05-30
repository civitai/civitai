// TODO: ModelVersionEarlyAccessConfig is imported from server - consider moving schema to shared
// Source: ~/server/schema/model-version.schema.ts (modelVersionEarlyAccessConfigSchema)
import type { ModelVersionEarlyAccessConfig } from '~/server/schema/model-version.schema';
import type { Availability, MediaType, ModelType } from '~/shared/utils/prisma/enums';

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
  vaeId?: number;
  baseModel: string;
  earlyAccessConfig?: ModelVersionEarlyAccessConfig;
  canGenerate: boolean;
  hasAccess: boolean;
  air?: string;
  additionalResourceCost?: boolean;
  availability?: Availability;
  epochNumber?: number;
  /** Per-image license fee in Buzz set by the model version owner */
  licensingFee?: number | null;
  /**
   * Resolved license fee inherited from the version's base model (e.g. an
   * Anima checkpoint derivative inherits Anima's fee). Null when the version
   * itself is the recipient or no base-model rule matches; in those cases
   * `licensingFee` is the source of truth.
   */
  inheritedLicensingFee?: {
    amount: number;
    type: string;
    settlementCurrency: string;
    recipientModelVersionId: number;
    recipientModelId: number;
    recipientModelName: string;
  } | null;
  // settings
  clipSkip?: number;
  minStrength: number;
  maxStrength: number;
  strength: number;
  /** Whether the current user owns the model this resource belongs to (computed by server) */
  isOwnedByUser?: boolean;
  /** Whether this resource is private (Private availability, or unpublished with epoch details) (computed by server) */
  isPrivate?: boolean;
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
};

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
  substitute?: GenerationResourceBase;
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
