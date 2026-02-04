import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { autoCaptionSchema } from '~/store/training.store';

export namespace Orchestrator {
  export type Job<TResult = unknown> = { jobId: string; result: TResult };
  export type JobResponse<TJob = Job> = { token: string; jobs: TJob[] };
  export type JobQueryParams = { id?: string; wait?: boolean };

  export type JobStatus =
    | 'Initialized'
    | 'Claimed'
    | 'Updated'
    | 'Succeeded'
    | 'Failed'
    | 'Rejected'
    | 'LateRejected'
    | 'Deleted'
    | 'Canceled'
    | 'Expired'
    | 'ClaimExpired';

  export type JobEvent = {
    type: JobStatus;
    jobHasCompleted?: boolean;
    context?: Record<string, unknown>;
  };

  export type JobStatusItem = {
    jobId?: string;
    scheduled?: boolean;
    cost?: number;
    lastEvent?: JobEvent;
    result?: unknown;
  };

  export type JobStatusCollection = {
    token: string;
    jobs: JobStatusItem[];
  };

  export namespace Training {
    export type CopyAssetJob = Orchestrator.Job<{ found?: boolean; fileSize?: number }> & {
      lastEvent: { type: string };
    };
    export type CopyAssetJobPayload = {
      jobId: string;
      assetName: string;
      destinationUri: string;
    };
    export type CopyAssetJobResponse = Orchestrator.JobResponse<CopyAssetJob>;

    export type ClearAssetsJob = Orchestrator.Job<{ total: number }>;
    export type ClearAssetsJobPayload = { jobId: string };
    export type ClearAssetsJobResponse = Orchestrator.JobResponse<ClearAssetsJob>;

    const imageAutoTagInputSchema = z.object({
      retries: z.number().positive(),
      mediaUrl: z.url(),
      modelId: z.number().positive(),
      properties: z.object({
        userId: z.number(),
        modelId: z.number().positive(),
        mediaType: z.enum(constants.trainingMediaTypes),
      }),
    });
    export type ImageAutoTagJobPayload = z.infer<typeof imageAutoTagInputSchema>;
    export type ImageAutoTagJobResponse = Orchestrator.JobResponse; // TODO is this right?

    const imageAutoCaptionInputSchema = imageAutoTagInputSchema
      .merge(autoCaptionSchema.omit({ overwrite: true }))
      .extend({
        model: z.string(),
      });
    export type ImageAutoCaptionJobPayload = z.infer<typeof imageAutoCaptionInputSchema>;
    export type ImageAutoCaptionJobResponse = Orchestrator.JobResponse; // TODO is this right?
  }
}
