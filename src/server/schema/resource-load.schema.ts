import * as z from 'zod';

/**
 * `ResourceInfo.availability` as the orchestrator actually returns it. The generated SDK types it as
 * `{ status: string }` with the four shapes declared separately, so it is parsed here rather than
 * asserted.
 *
 * 🔴 `queuePosition` lives on `unavailable`, not on `loading` — "in the queue" and "not loaded at
 * all" are the same status, told apart only by whether the position is null.
 */
export const resourceAvailabilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), workers: z.number() }),
  z.object({
    status: z.literal('loading'),
    progress: z.number(),
    workers: z.number(),
    startedAt: z.string().nullish(),
    lastProgressAt: z.string().nullish(),
    etaSeconds: z.number().nullish(),
  }),
  z.object({ status: z.literal('unavailable'), queuePosition: z.number().nullish() }),
  z.object({ status: z.literal('unsupported') }),
]);

export type ResourceAvailability = z.infer<typeof resourceAvailabilitySchema>;

/**
 * What the site reports when the orchestrator answered with a shape this build does not know — a
 * new status, or no `availability` at all. Deliberately not folded into `unsupported`: the purchase
 * path refuses both, but only one of them is the cluster saying it can never host the resource.
 */
export type ResourceLoadAvailability = ResourceAvailability | { status: 'unknown' };

export const getResourceLoadStateSchema = z.object({
  modelVersionIds: z.array(z.number()).min(1).max(100),
});

/** Capped well under the orchestrator's own max: each item costs it two grain calls. */
export const getResourceLoadQueueSchema = z.object({
  cursor: z.string().optional(),
  take: z.number().min(1).max(100).default(50),
});

export const resourceLoadVersionSchema = z.object({
  modelVersionId: z.number(),
});

export type GetResourceLoadStateInput = z.infer<typeof getResourceLoadStateSchema>;
export type GetResourceLoadQueueInput = z.infer<typeof getResourceLoadQueueSchema>;
export type ResourceLoadVersionInput = z.infer<typeof resourceLoadVersionSchema>;
