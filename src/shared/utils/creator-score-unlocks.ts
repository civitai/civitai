import { toStringList } from '~/utils/array-helpers';

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
 * higher.
 */
export type CreatorScoreKind = 'total' | 'aggregate';

export type CreatorScoreUnlock = {
  key: string;
  minScore: number;
  label: string;
  surface: CreatorScoreUnlockSurface;
  scoreKind: CreatorScoreKind;
  /** `keyValue` means an operator can move it without a deploy, so never cache the number in copy. */
  source: 'compiled' | 'keyValue';
};

export type CreatorScoreKinds = { total: number; aggregate?: number };

/** `aggregate` falls back to `total`. */
export function creatorScoreForKind(scores: CreatorScoreKinds, kind: CreatorScoreKind) {
  return kind === 'aggregate' ? scores.aggregate ?? scores.total : scores.total;
}

export function isCreatorScoreUnlockReached(unlock: CreatorScoreUnlock, scores: CreatorScoreKinds) {
  return creatorScoreForKind(scores, unlock.scoreKind) >= unlock.minScore;
}

/**
 * The unlocks not yet reached that have the lowest threshold, which is what a refusal or a progress bar
 * points at next. Each gate is judged against its own kind of score, `aggregate` falling back to `total`
 * when absent. Empty when every unlock is reached.
 */
export function nextCreatorScoreUnlocks(
  unlocks: CreatorScoreUnlock[],
  scores: CreatorScoreKinds
): CreatorScoreUnlock[] {
  const pending = unlocks.filter((u) => !isCreatorScoreUnlockReached(u, scores));
  if (pending.length === 0) return [];
  const next = Math.min(...pending.map((u) => u.minScore));
  return pending.filter((u) => u.minScore === next);
}

export type CreatorScoreTier = {
  key: string;
  name: string;
  threshold: number;
  hint: string | null;
  badgeUrl?: string | null;
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
 */
export function buildCreatorScoreLadder(
  unlocks: CreatorScoreUnlock[],
  tiers: CreatorScoreTier[]
): CreatorScoreRung[] {
  const ladderUnlocks = [...unlocks].sort((a, b) => a.minScore - b.minScore);
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

/** The unlocks on a rung not yet reached, each judged against its own kind of score. */
export function pendingCreatorScoreUnlocks(rung: CreatorScoreRung, scores: CreatorScoreKinds) {
  return rung.unlocks.filter((u) => !isCreatorScoreUnlockReached(u, scores));
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
  | { kind: 'met'; score: number }
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
  total = score,
  required,
  unlocks,
  tiers,
}: {
  /** The number this gate compares against `required`. */
  score: number | null | undefined;
  /** The viewer's total, which the ladder is climbed on; defaults to `score` for total-kind gates. */
  total?: number | null;
  required: number;
  unlocks: CreatorScoreUnlock[];
  tiers: CreatorScoreTier[];
}): CreatorScoreGateState {
  if (score == null) return { kind: 'unknown' };
  if (score >= required) return { kind: 'met', score };
  const ladderScore = total ?? score;
  // Some gates clamp a negative score to 0 before it gets here; the total still says which it was.
  if (score === 0 && ladderScore >= 0) return { kind: 'noScore' };
  const gap = Math.max(required - score, 0);
  if (score >= required * NEAR_GATE_SHARE) return { kind: 'near', score, gap };

  const nextUnlocks = nextCreatorScoreUnlocks(unlocks, { total: ladderScore, aggregate: score });
  const minScore = nextUnlocks[0]?.minScore;
  if (minScore == null || minScore >= required) return { kind: 'near', score, gap };

  return {
    kind: 'far',
    score: ladderScore,
    next: {
      minScore,
      tier: tiers.find((tier) => tier.threshold === minScore) ?? null,
      unlocks: nextUnlocks,
    },
  };
}

export type CreatorScoreUnlockGroup = {
  key: string;
  minScore: number;
  label: string;
  unlocks: CreatorScoreUnlock[];
};

/**
 * Collapses one privilege repeated per surface at the same threshold ("Higher price cap on stickers",
 * "... on remix galleries") into one line, so a rung reads as privileges rather than a surface list.
 */
export function groupCreatorScoreUnlocks(unlocks: CreatorScoreUnlock[]): CreatorScoreUnlockGroup[] {
  const groups = new Map<string, CreatorScoreUnlock[]>();
  for (const unlock of unlocks) {
    const id = `${unlock.key.split(':')[0]}@${unlock.minScore}`;
    groups.set(id, [...(groups.get(id) ?? []), unlock]);
  }

  return [...groups.values()].flatMap((members): CreatorScoreUnlockGroup[] => {
    const single = (u: CreatorScoreUnlock) => ({
      key: u.key,
      minScore: u.minScore,
      label: u.label,
      unlocks: [u],
    });
    if (members.length === 1) return [single(members[0])];

    const parts = members.map((u) => /^(.+?) on (.+)$/.exec(u.label));
    const prefix = parts[0]?.[1];
    if (!prefix || parts.some((part) => part?.[1] !== prefix)) return members.map(single);

    return [
      {
        key: members[0].key,
        minScore: members[0].minScore,
        label: `${prefix} on ${toStringList(parts.map((part) => part?.[2] ?? ''))}`,
        unlocks: members,
      },
    ];
  });
}

/** Registry labels as one clause: "judge crucibles, higher comment limits and ...". */
export function describeCreatorScoreUnlocks(unlocks: CreatorScoreUnlock[]) {
  return toStringList(
    groupCreatorScoreUnlocks(unlocks).map(
      ({ label }) => label.charAt(0).toLowerCase() + label.slice(1)
    )
  );
}
