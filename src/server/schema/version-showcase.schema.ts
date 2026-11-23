import * as z from 'zod';
import { versionShowcaseSites } from '~/shared/constants/version-showcase.constants';

const site = z.enum(versionShowcaseSites);

export const getVersionShowcaseEditorSchema = z.object({ modelVersionId: z.number().int() });

export const setVersionShowcaseSchema = z.object({
  modelVersionId: z.number().int(),
  site,
  items: z
    .array(
      z.object({
        imageId: z.number().int(),
        position: z.number().int().min(0).max(1000).nullish(),
        excluded: z.boolean().optional(),
      })
    )
    .max(200),
});
export type SetVersionShowcaseInput = z.infer<typeof setVersionShowcaseSchema>;

export const setVersionShowcaseCoverSchema = z.object({
  modelId: z.number().int(),
  site,
  imageId: z.number().int().nullable(),
});

export const versionShowcaseImageSchema = z.object({
  modelVersionId: z.number().int(),
  imageId: z.number().int(),
});

export const myImageShowcaseFeaturesSchema = z.object({ imageId: z.number().int() });
