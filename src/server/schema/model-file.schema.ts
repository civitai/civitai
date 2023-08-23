import { ModelFileVisibility } from '@prisma/client';
import { z } from 'zod';
import { constants } from '~/server/common/constants';

export const trainingResultsSchema = z.object({
  start_time: z.string().nullish(),
  end_time: z.string().nullish(),
  epochs: z
    .array(
      z.object({
        epoch_number: z.number(),
        model_url: z.string(),
        sample_images: z.array(z.string()).optional(),
      })
    )
    .nullish(),
});

export const modelFileMetadataSchema = z.object({
  format: z.enum(constants.modelFileFormats).nullish(),
  size: z.enum(constants.modelFileSizes).nullish(),
  fp: z.enum(constants.modelFileFp).nullish(),
  ownRights: z.boolean().nullish(),
  shareDataset: z.boolean().nullish(),
  numImages: z.number().nullish(),
  numCaptions: z.number().nullish(),
  trainingResults: trainingResultsSchema.nullish(),
});

export const modelFileSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  url: z.string().url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  type: z.enum(constants.modelFileTypes),
  metadata: modelFileMetadataSchema.optional(),
});

export type ModelFileInput = z.infer<typeof modelFileSchema>;

export type ModelFileCreateInput = z.infer<typeof modelFileCreateSchema>;
export const modelFileCreateSchema = z.object({
  name: z.string(),
  url: z.string().url().min(1, 'You must select a file'),
  sizeKB: z.number(),
  type: z.enum(constants.modelFileTypes),
  modelVersionId: z.number(),
  visibility: z.nativeEnum(ModelFileVisibility).optional(),
  metadata: modelFileMetadataSchema.optional(),
});

export type ModelFileUpdateInput = z.infer<typeof modelFileUpdateSchema>;
export const modelFileUpdateSchema = z.object({
  id: z.number().optional(),
  type: z.enum(constants.modelFileTypes).optional(),
  modelVersionId: z.number().optional(),
  metadata: modelFileMetadataSchema.optional(),
});

// export const modelFileUpdateSchema = z.object({
//   id: z.number(),
//   type: z.enum(constants.modelFileTypes).optional(),
//   modelVersionId: z.number().optional(), // used when a user needs to reassign a file to another version
// });
