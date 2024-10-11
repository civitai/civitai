import { TrainingResults } from '~/server/schema/model-file.schema';

export type LabelTypes = 'tag' | 'caption'; // TODO - remove from training.store.ts

// TODO - remove from global.d.ts
export type ModelFileFormat =
  | 'SafeTensor'
  | 'PickleTensor'
  | 'GGUF'
  | 'Diffusers'
  | 'Core ML'
  | 'ONNX'
  | 'Other';
export type ModelFileSize = 'full' | 'pruned'; // TODO - remove from global.d.ts
export type ModelFileFp = 'fp32' | 'fp16' | 'bf16' | 'fp8' | 'nf4'; // TODO - remove from global.d.ts

export type ModelFileMetadataBasic = {
  // TODO - remove from global.d.ts
  format?: ModelFileFormat;
  size?: ModelFileSize;
  fp?: ModelFileFp;
};

// TODO - remove from global.d.ts
export type ModelFileMetadata = ModelFileMetadataBasic & {
  labelType?: LabelTypes;
  ownRights?: boolean;
  shareDataset?: boolean;
  numImages?: number;
  numCaptions?: number;
  selectedEpochUrl?: string;
  trainingResults?: TrainingResults; // TrainingResults // TODO - should we have validation schemas be shared? If a validation schema type is used on the client while the validation occurs on the backend, then shouldn't it be a shared schema?
};
