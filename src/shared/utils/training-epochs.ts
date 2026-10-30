/** `continueFromEpochNumber` comes from the client and can be the -1 "orchestrator never numbered
 * this epoch" sentinel, hence the clamp. */
export const resolveEpochOffset = (
  storedOffset: number | undefined,
  continueFromEpochNumber: number | undefined
) => storedOffset ?? Math.max(0, Math.trunc(continueFromEpochNumber ?? 0));

type StoredEpoch = { epochNumber?: number } | { epoch_number?: number };

/**
 * How far through its own configured epochs a run is, for display against `maxTrainEpochs` /
 * `params.epochs`. Not a count — stored epochs are sparse (a finished 50-epoch run may store 18,
 * numbered 1, 4, 7, …, 52, which would report 18/50) — and not the raw highest number either,
 * which for a continuation is inflated by the offset and reports 15/10.
 */
export function epochsCompletedForRun(trainingResults: {
  epochs?: StoredEpoch[] | null;
  epochOffset?: number;
}) {
  const epochs = trainingResults.epochs;
  if (!epochs?.length) return 0;

  // Highest, not last: callers hand this both the stored ascending array and the descending one
  // the epoch list renders from.
  const highest = epochs.reduce((max, epoch) => {
    const n =
      ('epochNumber' in epoch ? epoch.epochNumber : undefined) ??
      ('epoch_number' in epoch ? epoch.epoch_number : undefined);
    return n != null && n > max ? n : max;
  }, 0);

  return Math.max(0, highest - (trainingResults.epochOffset ?? 0));
}
