export type CreatorScoreUnlockSurface =
  | 'crucibles'
  | 'challenges'
  | 'posting'
  | 'comments'
  | 'reactions'
  | 'articles'
  | 'monetization'
  | 'earlyAccess'
  | 'announcements'
  | 'placements'
  | 'creatorProgram';

/**
 * Which number the gate compares. They are not interchangeable: `total` is `User.meta.scores.total`, the
 * figure the account page shows; `aggregate` is `GREATEST(sum of the categories, total)`, which can be
 * higher; `articles` is the articles category alone.
 */
export type CreatorScoreKind = 'total' | 'aggregate' | 'articles';

export type CreatorScoreUnlock = {
  key: string;
  minScore: number;
  label: string;
  surface: CreatorScoreUnlockSurface;
  scoreKind: CreatorScoreKind;
  /** `keyValue` means an operator can move it without a deploy, so never cache the number in copy. */
  source: 'compiled' | 'keyValue';
};

export type CreatorScoreKinds = { total: number; aggregate?: number; articles?: number };

/** `aggregate` falls back to `total`; `articles` is undefined unless passed, so its gates are skipped. */
export function creatorScoreForKind(scores: CreatorScoreKinds, kind: CreatorScoreKind) {
  return kind === 'articles'
    ? scores.articles
    : kind === 'aggregate'
    ? scores.aggregate ?? scores.total
    : scores.total;
}

export function isCreatorScoreUnlockReached(unlock: CreatorScoreUnlock, scores: CreatorScoreKinds) {
  const score = creatorScoreForKind(scores, unlock.scoreKind);
  return score != null && score >= unlock.minScore;
}

/**
 * The unlocks not yet reached that have the lowest threshold, which is what a refusal or a progress bar
 * points at next. Each gate is judged against its own kind of score: `aggregate` falls back to `total`
 * when absent, and the articles tiers are left out unless an articles score is passed. Empty when every
 * comparable unlock is reached.
 */
export function nextCreatorScoreUnlocks(
  unlocks: CreatorScoreUnlock[],
  scores: CreatorScoreKinds
): CreatorScoreUnlock[] {
  const pending = unlocks.filter((u) => {
    const score = creatorScoreForKind(scores, u.scoreKind);
    return score != null && score < u.minScore;
  });
  if (pending.length === 0) return [];
  const next = Math.min(...pending.map((u) => u.minScore));
  return pending.filter((u) => u.minScore === next);
}

export type CreatorScoreTier = {
  key: string;
  name: string;
  threshold: number;
  hint: string | null;
};

export type CreatorScoreRung = {
  minScore: number;
  /** Null when no tier sits on this threshold: an intermediate gate, or no tiers are defined at all. */
  tier: CreatorScoreTier | null;
  unlocks: CreatorScoreUnlock[];
};

/**
 * The ladder on the `total` score: one rung per tier, carrying every unlock above the previous tier up to
 * and including its own threshold, so a tier names the privileges reaching it brings. Unlocks above the
 * top tier, and every unlock when there are no tiers, become unnamed rungs at their own threshold.
 * Articles-score unlocks are left out: they are not reached by climbing this ladder.
 */
export function buildCreatorScoreLadder(
  unlocks: CreatorScoreUnlock[],
  tiers: CreatorScoreTier[]
): CreatorScoreRung[] {
  const ladderUnlocks = unlocks
    .filter((u) => u.scoreKind !== 'articles')
    .sort((a, b) => a.minScore - b.minScore);
  const sortedTiers = [...tiers].sort((a, b) => a.threshold - b.threshold);

  const rungs: CreatorScoreRung[] = [];
  let floor = -Infinity;
  for (const tier of sortedTiers) {
    rungs.push({
      minScore: tier.threshold,
      tier,
      unlocks: ladderUnlocks.filter((u) => u.minScore > floor && u.minScore <= tier.threshold),
    });
    floor = tier.threshold;
  }

  const remaining = ladderUnlocks.filter((u) => u.minScore > floor);
  for (const minScore of [...new Set(remaining.map((u) => u.minScore))]) {
    rungs.push({
      minScore,
      tier: null,
      unlocks: remaining.filter((u) => u.minScore === minScore),
    });
  }

  return rungs;
}

/** The lowest rung above `total`, or null at the top of the ladder. */
export function nextCreatorScoreRung(rungs: CreatorScoreRung[], total: number) {
  return rungs.find((rung) => rung.minScore > total) ?? null;
}

/** The highest named tier at or below `total`. */
export function currentCreatorScoreTier(rungs: CreatorScoreRung[], total: number) {
  return [...rungs].reverse().find((rung) => rung.tier && rung.minScore <= total)?.tier ?? null;
}

const NEAR_GATE_SHARE = 0.8;

export type CreatorScoreGateState =
  | { kind: 'unknown' }
  | { kind: 'noScore' }
  | { kind: 'near'; score: number; gap: number }
  | {
      kind: 'far';
      score: number;
      next: { minScore: number; tier: CreatorScoreTier | null; unlocks: CreatorScoreUnlock[] };
    };

/**
 * What a refusal says to someone below `required`. Most people refused are nowhere near the gate, so
 * past 20% short it points at the nearest unlock they can reach instead of the one they asked for.
 * A null score means the caller does not know it (only the server's refusal is known), not zero.
 */
export function creatorScoreGateState({
  score,
  required,
  unlocks,
  tiers,
}: {
  score: number | null | undefined;
  required: number;
  unlocks: CreatorScoreUnlock[];
  tiers: CreatorScoreTier[];
}): CreatorScoreGateState {
  if (score == null) return { kind: 'unknown' };
  if (score <= 0) return { kind: 'noScore' };
  const gap = Math.max(required - score, 0);
  if (score >= required * NEAR_GATE_SHARE) return { kind: 'near', score, gap };

  const nextUnlocks = nextCreatorScoreUnlocks(unlocks, { total: score });
  const minScore = nextUnlocks[0]?.minScore;
  if (minScore == null || minScore >= required) return { kind: 'near', score, gap };

  return {
    kind: 'far',
    score,
    next: {
      minScore,
      tier: tiers.find((tier) => tier.threshold === minScore) ?? null,
      unlocks: nextUnlocks,
    },
  };
}

/** Registry labels as a run-on clause: "judge crucibles, ... and higher reaction limits". */
export function describeCreatorScoreUnlocks(unlocks: CreatorScoreUnlock[]) {
  const labels = unlocks.map(({ label }) => label.charAt(0).toLowerCase() + label.slice(1));
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
