import { z } from 'zod';
import { Ncmec } from '~/server/http/ncmec/ncmec.schema';

export const csamCapabilitiesDictionary: Record<string, string> = {
  create: 'create novel images/videos from textual inputs, such as describing a scene or an object',
  edit: 'edit existing images/videos by providing textual descriptions of the desired changes, such as adding or removing elements, changing colors, or altering expressions',
  generate:
    'generate multiple variations of an uploaded or generated image/video, such as changing the style, perspective, or background of the image',
  blend:
    'blend or mix different images or concepts together, such as combining faces, animals, or landscapes',
};

export const csamContentsDictionary: Record<string, string> = {
  nonRealMinors: 'AI-generated images/videos of non-real minors',
  realMinors: 'AI-edited images/videos of real minors',
  variations: 'AI-generated variations of uploaded CSAM',
  other: 'AI-generated sexualization of uploaded images/videos of minors',
};

// #region [user input]
export type CsamFileOutput = z.output<typeof imageSchema>;
const imageSchema = z.object({
  id: z.number(),
  fileAnnotations: Ncmec.fileAnnotationsSchema,
});

const sharedReportSchema = z.object({
  contents: z.string().array(),
  images: imageSchema.array(),
  modelVersionIds: z.number().array().optional(),
  userId: z.number(),
});

export type CsamUserReportInput = z.infer<typeof userReportSchema>;
const userReportSchema = sharedReportSchema.extend({
  origin: z.literal('user'),
  minorDepiction: z.enum(['real', 'non-real']),
});

export type CsamTestingReportInput = z.infer<typeof testingReportSchema>;
const testingReportSchema = sharedReportSchema.extend({
  origin: z.literal('testing'),
  capabilities: z.string().array(),
});

export type CsamReportUserInput = z.infer<typeof csamReportUserInputSchema>;
export const csamReportUserInputSchema = z.discriminatedUnion('origin', [
  userReportSchema,
  testingReportSchema,
]);
// #endregion
