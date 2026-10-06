/**
 * Every creator milestone the code can grant, keyed by its CreatorMilestone key. Names, thresholds,
 * hints and cosmetics live on the row; this says which detector grants the key, with what params,
 * and from when a grant is announced. A definition achieved before its launchedAt is granted
 * silently, so shipping a new one backfills existing qualifiers without a notification flood.
 *
 * Keys are permanent: renaming one re-grants everyone under the new key.
 */

type DetectorParams = {
  // Thresholds stay on the CreatorMilestone rows, so the score detector takes none.
  scoreSnapshot: Record<string, never>;
};

export type MilestoneDetector = keyof DetectorParams;

export type MilestoneRegistryEntry = {
  [D in MilestoneDetector]: { detector: D; params: DetectorParams[D]; launchedAt: Date };
}[MilestoneDetector];

const SCORE_TIERS_LAUNCHED_AT = new Date('2026-10-06T00:00:00Z');

const scoreTier = (): MilestoneRegistryEntry => ({
  detector: 'scoreSnapshot',
  params: {},
  launchedAt: SCORE_TIERS_LAUNCHED_AT,
});

export const creatorMilestoneRegistry: Record<string, MilestoneRegistryEntry> = {
  'score:spark': scoreTier(),
  'score:kindle': scoreTier(),
  'score:flame': scoreTier(),
  'score:blaze': scoreTier(),
  'score:beacon': scoreTier(),
  'score:nova': scoreTier(),
  'score:star': scoreTier(),
  'score:supernova': scoreTier(),
  'score:legend': scoreTier(),
};

export function milestoneKeysFor(detector: MilestoneDetector) {
  return Object.entries(creatorMilestoneRegistry)
    .filter(([, definition]) => definition.detector === detector)
    .map(([key]) => key);
}

/** An unregistered key is never announced: the registry is what decides a grant is news. */
export function isMilestoneAnnounced(
  milestoneKey: string,
  achievedAt: Date,
  registry: Record<string, MilestoneRegistryEntry> = creatorMilestoneRegistry
) {
  const definition = registry[milestoneKey];
  return !!definition && achievedAt >= definition.launchedAt;
}
