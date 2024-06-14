import { CsamReportType } from '@prisma/client';
import { z } from 'zod';
import { Ncmec } from '~/server/http/ncmec/ncmec.schema';
import { zodEnumFromObjKeys } from '~/utils/zod-helpers';

export type CsamCapabilityType = keyof typeof csamCapabilitiesDictionary;
export const csamCapabilitiesDictionary = {
  create: 'create novel images/videos from textual inputs, such as describing a scene or an object',
  edit: 'edit existing images/videos by providing textual descriptions of the desired changes, such as adding or removing elements, changing colors, or altering expressions',
  generate:
    'generate multiple variations of an uploaded or generated image/video, such as changing the style, perspective, or background of the image',
  blend:
    'blend or mix different images or concepts together, such as combining faces, animals, or landscapes',
} as const;

export type CsamContentType = keyof typeof csamContentsDictionary;
export const csamContentsDictionary = {
  nonRealMinors: 'AI-generated images/videos of non-real minors',
  realMinors: 'AI-edited images/videos of real minors',
  variations: 'AI-generated variations of uploaded CSAM',
  other: 'AI-generated sexualization of uploaded images/videos of minors',
} as const;

// #region [user input]
const ncmecUploadResultSchema = z.object({
  fileId: z.string().optional(),
  hash: z.string().optional(),
});
export type CsamImage = z.output<typeof imageSchema>;
const imageSchema = ncmecUploadResultSchema.extend({
  id: z.number(),
  fileAnnotations: Ncmec.fileAnnotationsSchema.default({}),
});

const trainingDataSchema = ncmecUploadResultSchema.extend({
  filename: z.string(),
});

export type CsamReportDetails = z.infer<typeof csamReportDetails>;
export const csamReportDetails = z.object({
  modelVersionIds: z.number().array().optional(),
  minorDepiction: z.enum(['real', 'non-real']).optional(),
  capabilities: zodEnumFromObjKeys(csamCapabilitiesDictionary).array().optional(),
  contents: zodEnumFromObjKeys(csamContentsDictionary).array().optional(),
  trainingData: trainingDataSchema.array().optional(),
});

export type CsamReportSchema = z.infer<typeof csamReportSchema>;
export const csamReportSchema = z.object({
  userId: z.number(),
  imageIds: z.number().array().optional(),
  details: csamReportDetails.optional(),
  type: z.nativeEnum(CsamReportType),
});

// #endregion

export type GetImageResourcesOutput = z.output<typeof getImageResourcesSchema>;
export const getImageResourcesSchema = z.object({
  ids: z.number().array(),
});
