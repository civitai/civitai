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
export type CsamFileOutput = z.output<typeof imageSchema>;
const imageSchema = z.object({
  id: z.number(),
  fileAnnotations: Ncmec.fileAnnotationsSchema.default({}),
});

const sharedFormSchema = z.object({
  contents: zodEnumFromObjKeys(csamContentsDictionary).array().optional(),
});

export type CsamUserReportInput = z.infer<typeof userReportSchema>;
const userReportSchema = sharedFormSchema.extend({
  origin: z.literal('user'),
  minorDepiction: z.enum(['real', 'non-real']),
});

export type CsamTestingReportInput = z.infer<typeof internalReportSchema>;
const internalReportSchema = sharedFormSchema.extend({
  origin: z.literal('testing'),
  capabilities: zodEnumFromObjKeys(csamCapabilitiesDictionary).array().optional(),
});

export const csamReportFormSchema = z.discriminatedUnion('origin', [
  userReportSchema,
  internalReportSchema,
]);

export type CsamReportUserInput = z.infer<typeof csamReportUserInputSchema>;
export const csamReportUserInputSchema = z.object({
  contents: zodEnumFromObjKeys(csamContentsDictionary).array().optional(),
  images: imageSchema.array(),
  modelVersionIds: z.number().array().optional(),
  userId: z.number().default(-1),
  minorDepiction: z.enum(['real', 'non-real']).optional(),
  capabilities: zodEnumFromObjKeys(csamCapabilitiesDictionary).array().optional(),
});
// #endregion

export type GetImageResourcesOutput = z.output<typeof getImageResourcesSchema>;
export const getImageResourcesSchema = z.object({
  ids: z.number().array(),
});
