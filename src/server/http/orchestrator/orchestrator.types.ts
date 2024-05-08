import { z } from 'zod';
import { trainingDetailsParams } from '~/server/schema/model-version.schema';

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

  type QueuePosition = {
    precedingJobs: number;
    precedingCost: number;
    jobs: number;
    cost: number;
    estimatedThroughputRate: number;
    workers: number;
    precedingPriorityJobs: number;
    precedingPriorityCost: number;
    estimatedStartDuration: string;
    estimatedCompletedDuration: string;
    estimatedStartDate: Date;
    estimatedCompletedDate: Date;
  };
  type ServiceProvider = {
    support: string;
    queuePosition: QueuePosition;
  };

  export type GetJobResponse = { serviceProviders: Record<string, ServiceProvider> };

  export type TaintJobByIdPayload = { reason: string; context?: MixedObject };

  export namespace Training {
    export type CopyAssetJob = Orchestrator.Job<{ found?: boolean; fileSize?: number }>;
    export type CopyAssetJobPayload = {
      jobId: string;
      assetName: string;
      destinationUri: string;
    };
    export type CopyAssetJobResponse = Orchestrator.JobResponse<CopyAssetJob>;

    export type ClearAssetsJob = Orchestrator.Job<{ total: number }>;
    export type ClearAssetsJobPayload = { jobId: string };
    export type ClearAssetsJobResponse = Orchestrator.JobResponse<ClearAssetsJob>;

    const imageResourceTrainingJobInputDryRunSchema = z.object({
      model: z.string(),
      cost: z.number(),
      trainingData: z.string(),
      params: z.object({}),
    });
    const imageResourceTrainingJobInputSchema = imageResourceTrainingJobInputDryRunSchema.extend({
      callbackUrl: z.string().url().optional(),
      retries: z.number(),
      trainingData: z.string().url(),
      params: z
        .object({
          modelFileId: z.number(),
          loraName: z.string(),
          samplePrompts: z.array(z.string()),
        })
        .merge(trainingDetailsParams),
      properties: z.record(z.unknown()).optional(),
    });
    export type ImageResourceTrainingJobDryRunPayload = z.infer<
      typeof imageResourceTrainingJobInputDryRunSchema
    >;
    export type ImageResourceTrainingJobPayload = z.infer<
      typeof imageResourceTrainingJobInputSchema
    >;
    export type ImageResourceTrainingResponse = Orchestrator.JobResponse<
      Orchestrator.Job & GetJobResponse
    >;

    const imageAutoTagInputSchema = z.object({
      retries: z.number().positive(),
      mediaUrl: z.string().url(),
      modelId: z.number().positive(),
      properties: z.object({
        userId: z.number(),
        modelId: z.number().positive(),
      }),
    });
    export type ImageAutoTagJobPayload = z.infer<typeof imageAutoTagInputSchema>;
    export type ImageAutoTagJobResponse = Orchestrator.JobResponse; // TODO is this right?
  }

  export namespace Generation {
    export const textToImageJobInputSchema = z.object({
      model: z.string(),
      params: z.object({
        prompt: z.string(),
        negativePrompt: z.string().optional(),
        width: z.number(),
        height: z.number(),
        scheduler: z.string(),
        steps: z.number(),
        cfgScale: z.number(),
        seed: z.number().optional(),
        clipSkip: z.number(),
        baseModel: z.string().optional(),
      }),
      additionalNetworks: z.record(
        z.object({
          type: z.string(),
          strength: z.number().optional(),
          triggerWord: z.string().optional(),
        })
      ),
      quantity: z.number(),
      properties: z.record(z.unknown()),
      priority: z.object({ min: z.number(), max: z.number() }).optional(),
      baseModel: z.string().optional(),
      callbackUrl: z.string().optional(),
    });

    export type TextToImageJobPayload = z.infer<typeof textToImageJobInputSchema>;

    export type TextToImageJob = Orchestrator.Job<{ blobKey: string; available: boolean }> & {
      serviceProviders: Record<string, ServiceProvider>;
      cost: number;
    };

    export type TextToImageResponse = Orchestrator.JobResponse<TextToImageJob>;

    const blobGetPayloadSchema = z.object({
      key: z.string(),
      expiration: z.date().optional(),
      wait: z.boolean().optional(),
    });

    export type BlobGetPayload = z.infer<typeof blobGetPayloadSchema>;
    export type BlobGetResponse = {
      exist: boolean;
      location: {
        uri: string;
        expirationDate: Date;
      };
    };

    const blobActionSchema = z.object({
      key: z.string(),
    });

    export type BlobActionPayload = z.infer<typeof blobActionSchema>;
    export type BlobActionResponse = { success: boolean };

    export type PrepareModelJob = Orchestrator.Job & {
      serviceProviders: Record<string, ServiceProvider>;
    };
    export type PrepareModelPayload = {
      baseModel: string;
      model: string;
      priority: number;
      providers: string[];
    };
    export type BustModelCache = {
      modelVersionId: number;
    };
    export type PrepareModelResponse = Orchestrator.JobResponse<PrepareModelJob>;
  }

  export namespace Events {
    export type QueryParams = {
      id: string;
      take?: number;
      descending?: boolean;
    };

    export type GetResponse = Array<{ type?: string; dateTime?: string }>;
  }
}
