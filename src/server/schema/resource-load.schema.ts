import * as z from 'zod';
import { preparationSchema } from '~/shared/orchestrator/download-preparation';

/**
 * `ResourceInfo.availability` as the orchestrator actually returns it. The generated SDK types it as
 * `{ status: string }` with the four shapes declared separately, so it is parsed here rather than
 * asserted.
 *
 * 🔴 Two generations of the queued shape both parse. Before the orchestrator's beta.105 a queued
 * resource was `unavailable` with a `queuePosition`; from beta.105 it is `queued`, and `unavailable`
 * means nothing is pulling it. Dropping the old shape breaks the site until that deploy lands.
 *
 * `lane` is a plain string so a lane added later does not turn a known status into `unknown`.
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
    lane: z.string().nullish(),
    bytesPerSecond: z.number().nullish(),
    rateLimitBytesPerSecond: z.number().nullish(),
  }),
  z.object({
    status: z.literal('queued'),
    queuePosition: z.number(),
    lane: z.string(),
    etaSeconds: z.number().nullish(),
    boostedEtaSeconds: z.number().nullish(),
    rateLimitBytesPerSecond: z.number().nullish(),
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

/**
 * Waiting in the download queue, in either orchestrator shape. Stated once because the pre-beta.105
 * shape is told apart from "nothing is pulling it" only by the queue position, and four screens were
 * each deciding that for themselves.
 */
export function isQueuedAvailability(availability: ResourceLoadAvailability) {
  return (
    availability.status === 'queued' ||
    (availability.status === 'unavailable' && availability.queuePosition != null)
  );
}

/**
 * Why a version cannot be loaded. The two are different things to tell a user: an API model has
 * nothing to load and never will, while a GGUF checkpoint has weights the cluster cannot serve.
 * Collapsing them is what made the old copy claim every unloadable resource was external.
 */
export type UnloadableReason = 'no-weights' | 'unsupported-format';

/** Lives here, not in the service, so client pages can state the reason in the mutation's words. */
export const UNLOADABLE_MESSAGES: Record<UnloadableReason, string> = {
  'no-weights': 'This resource has no model file to load — it runs through an external provider.',
  'unsupported-format':
    'The generator can only load SafeTensor files, and this version does not have one.',
};

export const getResourceLoadStateSchema = z.object({
  modelVersionIds: z.array(z.number()).min(1).max(100),
});

/** One page of resource-picker results. */
export const getResourceResidencySchema = z.object({
  modelVersionIds: z.array(z.number()).min(1).max(50),
});

/** One queue card's models. Uncached, so the cap is small. */
export const getDownloadStatusSchema = z.object({
  modelVersionIds: z.array(z.number()).min(1).max(10),
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

/**
 * What arrives on the buyer's user channel as `resource-load:update`.
 *
 * The orchestrator posts its `WorkflowStepEvent` straight to signals — we are not in the path — so
 * this is that shape, narrowed to what a progress UI needs. Only a `preparing` step carries
 * `preparation`; every other status arrives here too and is ignored.
 */
export const resourceLoadSignalSchema = z.object({
  workflowId: z.string().nullish(),
  name: z.string().nullish(),
  status: z.string().nullish(),
  preparation: preparationSchema.nullish(),
});

export type ResourceLoadSignal = z.infer<typeof resourceLoadSignalSchema>;
