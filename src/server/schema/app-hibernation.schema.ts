import * as z from 'zod';
import { isAppBlockId } from '@civitai/app-assistant';

// A plain object, not strict: the request pipeline's domain cap (`applyDomainFeature` in
// `trpc.ts`) can write `browsingLevel` into any object input before it is validated.
export const sleepingAppSchema = z.object({
  app: z.string().refine(isAppBlockId, 'not an app key'),
});
export type SleepingAppInput = z.infer<typeof sleepingAppSchema>;

/** A delete of one sleeping app; `why` records whether it was made at the limit (default `user`). */
export const deleteSleepingAppSchema = sleepingAppSchema.extend({
  why: z.enum(['user', 'limit']).optional(),
});
