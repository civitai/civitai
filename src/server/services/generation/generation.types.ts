import { ModelType } from '@prisma/client';

export type GenerationResourceModel = {
  id: number;
  name: string;
  trainedWords: string[];
  modelId: number;
  modelName: string;
  modelType: ModelType;
  strength?: number;
};

type ImageProps = {
  hash: string;
  url: string;
  available: boolean;
  requestId: number;
};

type JobProps = {
  quantity: number;
  priority: number;
  additionalNetworks: {
    [key: string]: {
      strength?: number;
    };
  };
  params: {
    prompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    sampler: string;
    steps: number;
    cfgScale: number;
    seed: number;
  };
};

type AssetProps = {
  type: ModelType;
  hash: string;
  url: string; // Not sure if this prop is still required
  modelVersionId: number;
};

export type GenerationRequestProps = {
  id: number;
  createdAt: Date;
  estimatedCompletionDate: Date;
  userId: number;
  status: number;
  assets: AssetProps[];
  job: JobProps;
  images: ImageProps[];
};
