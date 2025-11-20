import type { Availability, ModelType } from '~/shared/utils/prisma/enums';
import type { ModelVersionEarlyAccessConfig } from '~/server/schema/types';

/**
 * Base generation resource type with common fields
 */
export type GenerationResourceBase = {
  id: number;
  name: string;
  trainedWords: string[];
  vaeId?: number;
  baseModel: string;
  earlyAccessConfig?: ModelVersionEarlyAccessConfig;
  canGenerate: boolean;
  hasAccess: boolean;
  additionalResourceCost?: boolean;
  availability?: Availability;
  epochNumber?: number;
  // settings
  clipSkip?: number;
  minStrength: number;
  maxStrength: number;
  strength: number;
};

/**
 * Full generation resource type with model details
 */
export type GenerationResource = GenerationResourceBase & {
  model: {
    id: number;
    name: string;
    type: ModelType;
    nsfw?: boolean;
    poi?: boolean;
    minor?: boolean;
    sfwOnly?: boolean;
  };
  epochDetails?: {
    jobId: string;
    fileName: string;
    epochNumber: number;
    isExpired: boolean;
  };
  substitute?: GenerationResourceBase;
};
