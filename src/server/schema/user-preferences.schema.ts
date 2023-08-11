import { z } from 'zod';

export type HiddenPreferencesOutput = z.output<typeof hiddenPreferencesSchema>;
export type HiddenPreferencesInput = z.input<typeof hiddenPreferencesSchema>;
export const hiddenPreferencesSchema = z.object({
  explicit: z
    .object({
      users: z.number().array().default([]),
      images: z.number().array().default([]),
      models: z.number().array().default([]),
    })
    .default({}),
  hidden: z
    .object({
      tags: z.number().array().default([]),
      images: z.number().array().default([]),
      models: z.number().array().default([]),
    })
    .default({}),
  moderated: z
    .object({
      tags: z.number().array().default([]),
      images: z.number().array().default([]),
      models: z.number().array().default([]),
    })
    .default({}),
});

export type ToggleHiddenTagsInput = z.input<typeof toggleHiddenTagsSchema>;
export const toggleHiddenTagsSchema = z.object({
  tagIds: z.number().array(),
  hidden: z.boolean().optional(),
});

export type ToggleHiddenEntityInput = z.input<typeof toggleHiddenEntitySchema>;
export const toggleHiddenEntitySchema = z.object({
  entityId: z.number(),
  entityType: z.enum(['model', 'user', 'image']),
});
