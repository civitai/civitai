import { ModelType } from '@prisma/client';

export namespace Generation {
  export type AdditionalNetwork = Partial<{
    strength: number;
  }>;

  export type Image = {
    id: number;
    hash: string;
    url: string;
    available: boolean;
    requestId: number;
  };

  export type Params = {
    prompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    sampler: string;
    steps: number;
    cfgScale: number;
    seed: number;
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
    params: Params;
    additionalNetworks: Record<string, AdditionalNetwork>;
  };

  export namespace Client {
    export type Resource = AdditionalNetwork & {
      id: number;
      name: string;
      trainedWords: string[];
      modelId: number;
      modelName: string;
      modelType: ModelType;
    };
    export type Request = {
      id: number;
      createdAt: Date;
      estimatedCompletionDate: Date;
      status: GenerationRequestStatus;
      quantity: number;
      priority: number;
      params: Params;
      resources: Resource[];
      images?: Image[];
    };
    export type ImageRequest = { params: Params };
    export type ImageRequestDictionary = Record<string, ImageRequest>;
    export type Images = {
      images: Image[];
      requests: ImageRequestDictionary;
    };
  }

  export namespace Api {
    type RequestProps = {
      id: number;
      createdAt: Date;
      estimatedCompletionDate: Date;
      userId: number;
      status: GenerationRequestStatus;
      assets: Asset[];
      job: Job;
      images?: Image[];
    };
    export type Request = {
      cursor: number;
      requests: RequestProps[];
    };
    export type Images = {
      cursor: number;
      images: Image[];
      requests: RequestProps[];
    };
  }
}

export enum GenerationRequestStatus {
  Pending = 0,
  Processing = 1,
  Cancelled = 2,
  Error = 3,
  Succeeded = 4,
}
