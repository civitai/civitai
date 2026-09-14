import * as z from 'zod';

/** `lane` is a plain string so a lane added later does not drop the whole event. */
const preparationResourceSchema = z.object({
  resource: z.string(),
  sizeBytes: z.number(),
  lane: z.string(),
  queuePosition: z.number().nullish(),
  progress: z.number().nullish(),
  bytesPerSecond: z.number().nullish(),
  etaSeconds: z.number().nullish(),
  boostedEtaSeconds: z.number().nullish(),
});

/** `WorkflowStep.preparation`: every resource the step waits on, gating resource first. */
export const preparationSchema = z.array(preparationResourceSchema);

export type PreparationResource = z.infer<typeof preparationResourceSchema>;

/** A step's pending downloads, summarised by the resource holding it back. */
export type DownloadPreparation = {
  /** AIR of the gating resource — the one that will finish last. */
  resource: string;
  /** Downloads ahead of the gating resource. Zero means it is transferring now. */
  queuePosition: number;
  progress?: number | null;
  etaSeconds?: number | null;
  lane: string;
  /** What `etaSeconds` would become in the high lane. Null once already high. */
  boostedEtaSeconds?: number | null;
  resources: PreparationResource[];
};

const maxKnown = (values: (number | null | undefined)[]) => {
  const known = values.filter((value): value is number => value != null);
  return known.length ? Math.max(...known) : null;
};

/**
 * An empty list means nothing is waiting to download, and reads as undefined — a `[]` left as-is is
 * truthy, and would put a download panel and a paid Boost on a step with nothing to boost.
 */
export function summarizePreparation(
  resources: PreparationResource[] | null | undefined
): DownloadPreparation | undefined {
  const gating = resources?.[0];
  if (!resources || !gating) return undefined;
  // The gating resource is the slowest UNBOOSTED, but a boost can reorder them, so the boosted ETA is
  // the maximum across the list.
  return {
    resource: gating.resource,
    queuePosition: gating.queuePosition ?? 0,
    progress: gating.progress,
    etaSeconds: maxKnown(resources.map((r) => r.etaSeconds)),
    lane: gating.lane,
    boostedEtaSeconds: maxKnown(resources.map((r) => r.boostedEtaSeconds)),
    resources,
  };
}

/** For `preparation` straight off the orchestrator; anything that is not the resource list reads as nothing to download. */
export function normalizePreparation(raw: unknown): DownloadPreparation | undefined {
  const parsed = preparationSchema.safeParse(raw);
  return parsed.success ? summarizePreparation(parsed.data) : undefined;
}
