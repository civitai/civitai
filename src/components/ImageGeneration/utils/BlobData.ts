import type { ImageBlob, VideoBlob, NsfwLevel, WorkflowStatus } from '@civitai/client';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import type {
  NormalizedWorkflowStepOutput,
  WorkflowStepFormatted,
} from '~/server/services/orchestrator/common';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import { isPrivateMature, isMature } from '~/shared/constants/orchestrator.constants';

type StepMetadataParams = {
  width?: number;
  height?: number;
  sourceImage?: SourceImageProps | null;
  images?: SourceImageProps[] | null;
  engine?: string;
  aspectRatio?: string;
  isPrivateGeneration?: boolean;
};

export class BlobData implements NormalizedWorkflowStepOutput {
  url!: string;
  workflowId!: string;
  stepName!: string;
  seed?: number | null;
  status!: WorkflowStatus;
  aspect!: number;
  type!: 'image' | 'video';
  id!: string;
  available!: boolean;
  urlExpiresAt?: string | null;
  jobId?: string | null;
  nsfwLevel?: NsfwLevel;
  blockedReason?: string | null;
  previewUrl?: string | null;
  previewUrlExpiresAt?: string | null;

  constructor({
    data,
    allowMatureContent,
    step,
    domain,
    nsfwEnabled,
  }: {
    data: ImageBlob | VideoBlob;
    /** workflow.allowMatureContent */
    allowMatureContent?: boolean | null;
    step: Omit<WorkflowStepFormatted, 'images'>;
    domain: Record<ColorDomain, boolean>;
    nsfwEnabled: boolean;
  }) {
    Object.assign(this, data);

    const isPrivateGeneration = (step.metadata as any)?.isPrivateGeneration ?? false;

    if (data.blockedReason === 'none') this.blockedReason = null;
    if (!this.blockedReason) {
      if (isPrivateGeneration && isPrivateMature(data.nsfwLevel)) {
        this.blockedReason = 'privateGen';
      } else if (isMature(data.nsfwLevel)) {
        if (domain.green) this.blockedReason = 'siteRestricted';
        else if (!nsfwEnabled) this.blockedReason = 'enableNsfw';
        else if (allowMatureContent === false) this.blockedReason = 'canUpgrade';
      }
    }
  }

  get canUpgrade() {
    return this.blockedReason === 'canUpgrade';
  }
}
