import * as z from 'zod/v4';
import { getAllQuerySchema } from '~/server/schema/base.schema';

export type GetFlaggedModelsInput = z.infer<typeof getFlaggedModelsSchema>;
export const getFlaggedModelsSchema = getAllQuerySchema.extend({
  filters: z
    .object({
      id: z.string(),
      value: z.unknown(),
    })
    .array()
    .optional(),
  sort: z
    .object({
      id: z.string(),
      desc: z.boolean(),
    })
    .array()
    .optional(),
});

export type ModelScanResult = z.infer<typeof modelScanResultSchema>;
export const modelScanResultSchema = z.object({
  status: z.enum(['success', 'failure']),
  user_declared: z.object({
    content: z.object({
      id: z.number(),
      name: z.string(),
      POI: z.boolean(),
      NSFW: z.boolean(),
      minor: z.boolean(),
      sfwOnly: z.boolean().nullish(),
      triggerwords: z.string().array().nullish(),
      image_urls: z.string().array().nullish(),
      links: z.string().array().nullish(),
    }),
  }),
  llm_interrogation: z.object({
    POI: z.boolean(),
    POIName: z.string().array().nullish(),
    context: z.string().nullish(),
    NSFW: z.boolean(),
    minor: z.boolean(),
    sfwOnly: z.boolean().nullish(),
    triggerwords: z.string().array(),
    POIInfo: z
      .object({
        POIVerified: z.boolean(),
        reason: z.string(),
      })
      .nullish(),
  }),
  flags: z.object({
    POI_flag: z.boolean(),
    NSFW_flag: z.boolean(),
    minor_flag: z.boolean(),
    sfwOnly_flag: z.boolean().nullish(),
    triggerwords_flag: z.boolean(),
  }),
});
