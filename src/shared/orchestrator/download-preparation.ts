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
  /** The lane's per-stream cap. Null when uncapped, which is what boosting buys. */
  rateLimitBytesPerSecond: z.number().nullish(),
});

/** `WorkflowStep.preparation`: every resource the step waits on, gating resource first. */
export const preparationSchema = z.array(preparationResourceSchema);

export type PreparationResource = z.infer<typeof preparationResourceSchema>;

/** A step's pending downloads, summarised by the resource holding it back. */
export type DownloadPreparation = {
  /** AIR of the gating resource — the one that will finish last. */
  resource: string;
  /** Downloads ahead of the gating resource; null when the orchestrator has not queued it yet. */
  queuePosition: number | null;
  progress?: number | null;
  etaSeconds?: number | null;
  lane: string;
  /** What `etaSeconds` would become in the high lane. Null once already high. */
  boostedEtaSeconds?: number | null;
  rateLimitBytesPerSecond?: number | null;
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
    queuePosition: gating.queuePosition ?? null,
    progress: gating.progress,
    etaSeconds: maxKnown(resources.map((r) => r.etaSeconds)),
    lane: gating.lane,
    boostedEtaSeconds: maxKnown(resources.map((r) => r.boostedEtaSeconds)),
    rateLimitBytesPerSecond: gating.rateLimitBytesPerSecond,
    resources,
  };
}

/** For `preparation` straight off the orchestrator; anything that is not the resource list reads as nothing to download. */
export function normalizePreparation(raw: unknown): DownloadPreparation | undefined {
  // Every step of every workflow in a queue listing comes through here, and almost none carries a
  // preparation — zod builds a whole error for each of those, which is ~7µs a step.
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const parsed = preparationSchema.safeParse(raw);
  return parsed.success ? summarizePreparation(parsed.data) : undefined;
}

function asHighLane(preparation: DownloadPreparation): DownloadPreparation {
  const boost = <T extends { etaSeconds?: number | null; boostedEtaSeconds?: number | null }>(
    value: T
  ) => ({
    ...value,
    lane: 'high',
    etaSeconds: value.boostedEtaSeconds ?? value.etaSeconds,
    boostedEtaSeconds: null,
    rateLimitBytesPerSecond: null,
  });
  return { ...boost(preparation), resources: preparation.resources.map(boost) };
}

/**
 * What a whatIf can honestly say about a submit that has not queued yet: which lane the job is in and
 * how much there is to fetch — both properties of the request. Its position and ETAs are measured
 * against a queue this job has not joined, so they are dropped rather than shown and then changed; the
 * card's own poll has the orchestrator's within seconds.
 */
function asEstimate(preparation: DownloadPreparation): DownloadPreparation {
  const estimate = <T extends PreparationResource | DownloadPreparation>(value: T) => ({
    ...value,
    queuePosition: null,
    progress: null,
    etaSeconds: null,
    boostedEtaSeconds: null,
  });
  return {
    ...estimate(preparation),
    resources: preparation.resources.map(estimate),
  };
}

/**
 * Gives a fresh submit's steps what a whatIf of the same steps knows, until the orchestrator reports
 * its own — the submit reply predates any download being queued. A boosted submit was priced
 * unboosted, so its estimate is restated in the high lane.
 */
export function attachEstimatedPreparation(
  steps: { name?: string | null; preparation?: DownloadPreparation }[],
  priced: { name?: string | null; preparation?: DownloadPreparation }[],
  boosted: boolean
) {
  priced.forEach(({ name, preparation }, index) => {
    const step = steps.find((s) => s.name === name) ?? steps[index];
    if (!step || step.preparation || !preparation) return;
    step.preparation = asEstimate(boosted ? asHighLane(preparation) : preparation);
  });
}
