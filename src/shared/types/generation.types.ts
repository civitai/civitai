// TODO: ModelVersionEarlyAccessConfig is imported from server - consider moving schema to shared
// Source: ~/server/schema/model-version.schema.ts (modelVersionEarlyAccessConfigSchema)
import type { ModelVersionEarlyAccessConfig } from '~/server/schema/model-version.schema';
import type { Availability, ModelType } from '~/shared/utils/prisma/enums';

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
  // settings
  clipSkip?: number;
  minStrength: number;
  maxStrength: number;
  strength: number;
  /** Whether the current user owns the model this resource belongs to (computed by server) */
  isOwnedByUser?: boolean;
  /** Whether this resource is private (Private availability, or unpublished with epoch details) (computed by server) */
  isPrivate?: boolean;
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
};
