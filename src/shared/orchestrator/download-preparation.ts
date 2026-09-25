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
 * How much of a transfer must have moved before its own ETA is believed: a stream still ramping up
 * projects from a throughput it will not hold, which reads as hours on a ten-minute download.
 *
 * The sample must be large in ABSOLUTE terms, which a fraction alone cannot express — on a small file
 * it resolves to a size still inside the ramp-up, so the smaller the file the weaker the guard.
 * `MIN_BYTES` sets that floor; `MAX_FRACTION` keeps it reachable on a file smaller than the floor, so
 * every transfer still settles.
 */
export const ETA_WARMUP_PROGRESS = 0.02;
export const ETA_WARMUP_BYTES = 64 * 1024 * 1024;
export const ETA_WARMUP_MIN_BYTES = 8 * 1024 * 1024;
export const ETA_WARMUP_MAX_FRACTION = 0.5;

type WarmupSource = {
  progress?: number | null;
  sizeBytes?: number | null;
  etaSeconds?: number | null;
};

/** Bytes that must have moved before this resource's own ETA means anything. */
function warmupBytes(sizeBytes: number) {
  return Math.min(
    ETA_WARMUP_BYTES,
    sizeBytes * ETA_WARMUP_MAX_FRACTION,
    Math.max(ETA_WARMUP_MIN_BYTES, sizeBytes * ETA_WARMUP_PROGRESS)
  );
}

/**
 * A resource that has not started downloading is settled: it is waiting behind other downloads, and
 * nothing has distorted the projection it was given. Only a transfer in progress can be too young to
 * believe.
 *
 * An unknown size leaves only the fraction to go on.
 */
export function isEtaSettled(resource: WarmupSource) {
  if (resource.progress == null) return true;
  const sizeBytes = resource.sizeBytes ?? 0;
  if (sizeBytes <= 0) return resource.progress >= ETA_WARMUP_PROGRESS;
  return sizeBytes * resource.progress >= warmupBytes(sizeBytes);
}

/** A resource's ETA once it is worth showing; null while its transfer is still ramping up. */
export function settledEtaSeconds(resource: WarmupSource) {
  return isEtaSettled(resource) ? resource.etaSeconds ?? null : null;
}

/**
 * The boosted ETA is withheld on the same terms as the plain one. Offering a paid boost while
 * refusing to show the wait it shortens is a charge with no stated benefit.
 */
export function settledBoostedEtaSeconds(
  resource: WarmupSource & { boostedEtaSeconds?: number | null }
) {
  return isEtaSettled(resource) ? resource.boostedEtaSeconds ?? null : null;
}

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
    etaSeconds: maxKnown(resources.map(settledEtaSeconds)),
    lane: gating.lane,
    boostedEtaSeconds: maxKnown(resources.map(settledBoostedEtaSeconds)),
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
