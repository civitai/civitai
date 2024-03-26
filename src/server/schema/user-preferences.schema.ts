import { z } from 'zod';

export type ToggleHiddenSchemaOutput = z.output<typeof toggleHiddenSchema>;
export const toggleHiddenSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tag'),
    data: z.object({ id: z.number(), name: z.string() }).array().min(1),
    hidden: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('user'),
    data: z.object({ id: z.number(), username: z.string().nullish() }).array().min(1).max(1), // max 1 until we add support for more
    hidden: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('image'),
    data: z.object({ id: z.number() }).array().min(1).max(1), // max 1 until we add support for more
    hidden: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('model'),
    data: z.object({ id: z.number() }).array().min(1).max(1), // max 1 until we add support for more
    hidden: z.boolean().optional(),
  }),
]);

export const toggleHiddenTagsSchema = z.object({
  addedIds: z.number().array().optional(),
  removedIds: z.number().array().optional(),
});
