import { ModelType } from '@prisma/client';
import { JobStatus } from '~/libs/orchestrator/jobs';
import { GenerationRequestStatus } from '~/server/common/enums';

export namespace Generation {
  export type AdditionalNetwork = Partial<{
    strength: number;
    minStrength: number;
    maxStrength: number;
  }>;

  export type ImageStatus = 'Success' | 'Started' | 'Error' | 'RemovedForSafety' | 'Cancelled';
  export type Image = {
    id: number;
    hash: string;
    url: string;
    available: boolean;
    requestId: number;
    seed?: number; // TODO.generation - check if this prop will be set
    status?: ImageStatus;
    type?: JobStatus;
    removedForSafety: boolean;
    jobToken?: string;
    duration?: number | null;
  };

  export type Data = {
    params?: Partial<Params>;
    resources: Resource[];
  };

  export type Params = {
    prompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    sampler?: string;
    steps: number;
    cfgScale: number;
    seed?: number;
    clipSkip: number;
    baseModel?: string;
    scheduler?: string;
  };

  export type Asset = {
    type: ModelType;
    hash: string;
    url: string;
    modelVersionId: number;
  };

  export type Job = {
    quantity: number;
    priority: number;
    model: string;
    params: Params;
    additionalNetworks: Record<string, AdditionalNetwork> | null;
  };

  export type Resource = AdditionalNetwork & {
    id: number;
    name: string;
    trainedWords: string[];
    modelId: number;
    modelName: string;
    modelType: ModelType;
    baseModel: string;
    strength?: number;
    minStrength?: number;
    maxStrength?: number;

    // navigation props
    covered?: boolean;
  };

  export type QueuePosition = {
    precedingJobs: number;
    precedingCost: number;
    jobs: number;
    cost: number;
    estimatedThroughputRate: number;
    workers: number;
    estimatedStartDuration: string;
    estimatedCompletedDuration: string;
    estimatedStartDate: Date;
    estimatedCompletedDate: Date;
  };

  export type Request = {
    id: number;
    // alternativesAvailable?: boolean;
    createdAt: Date;
    // estimatedCompletionDate: Date;
    status: GenerationRequestStatus;
    quantity: number;
    priority: number;
    params: Params;
    resources: Resource[];
    images?: Image[];
    // queuePosition?: QueuePosition;
    cost?: number;
    sequential?: boolean;
  };

  export type Coverage = {
    assets: AssetCoverageDictionary;
    assetTypes: AssetTypeCoverageDictionary;
    schedulers: SchedulerCoverageDictionary;
  };

  export type AssetCoverageDictionary = Record<string, ItemCoverage>;
  export type AssetTypeCoverageDictionary = Record<string, ItemCoverage>;
  export type SchedulerCoverageDictionary = Record<string, ItemCoverage>;

  export type ItemCoverage = {
    workers: number;
    serviceProviders: Record<string, ServiceProviderCoverage>;
  };

  export type ServiceProviderCoverage = {
    workers: number;
  };

  export namespace Api {
    export type RequestProps = {
      id: number;
      createdAt: Date;
      estimatedCompletedAt: Date;
      userId: number;
      status: string;
      job: Job;
      images?: Image[];
      queuePosition?: QueuePosition;
      cost: number;
    };
    export type Request = {
      cursor: number;
      requests: RequestProps[];
    };
  }
}
