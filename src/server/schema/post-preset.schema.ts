import * as z from 'zod';
import { MAX_MANUAL_RESOURCES_PER_IMAGE, POST_TAG_LIMIT } from '~/server/common/constants';
import { ModelType } from '~/shared/utils/prisma/enums';

export const POST_PRESET_NAME_LIMIT = 64;
export const POST_PRESET_TITLE_TEMPLATE_LIMIT = 255;
const OPTION_LIMIT = 50;

const namedOptionSchema = z
  .object({ id: z.number().int().positive(), name: z.string().trim().min(1).max(200) })
  .strict();

/** A model version with what the composer's resource chip renders, so applying needs no lookup. */
const presetResourceSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
    baseModel: z.string().max(100),
    model: z
      .object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(200),
        type: z.enum(ModelType),
      })
      .strict(),
  })
  .strict();

export const postPresetDataSchema = z
  .object({
    resources: z.array(presetResourceSchema).max(MAX_MANUAL_RESOURCES_PER_IMAGE),
    tools: z.array(namedOptionSchema).max(OPTION_LIMIT),
    techniques: z.array(namedOptionSchema).max(OPTION_LIMIT),
    tags: z.array(z.string().trim().min(1).max(100)).max(POST_TAG_LIMIT),
    titleTemplate: z.string().max(POST_PRESET_TITLE_TEMPLATE_LIMIT),
  })
  .strict();
export type PostPresetData = z.infer<typeof postPresetDataSchema>;

export const upsertPostPresetSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(POST_PRESET_NAME_LIMIT),
  data: postPresetDataSchema,
});
export type UpsertPostPresetInput = z.infer<typeof upsertPostPresetSchema>;
