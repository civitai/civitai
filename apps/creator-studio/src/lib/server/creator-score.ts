import { dbRead } from '$lib/server/db';

// Mirrors the main app's getCreatorRequirements (creator-program.service.ts): the creator score is
// GREATEST(sum of the per-type scores, the stored total) — the max guards against a stale/low `total`.
// Source of truth is User.meta->'scores'. Keep the key list in sync with the main app.
const SCORE_KEYS = [
  'models',
  'articles',
  'images',
  'users',
  'reportsActioned',
  'reportsAgainst',
] as const;

type Scores = Partial<Record<(typeof SCORE_KEYS)[number] | 'total', number | string>>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function readScores(userId: number): Promise<Scores> {
  const row = await dbRead
    .selectFrom('User')
    .select('meta')
    .where('id', '=', userId)
    .executeTakeFirst();

  return (row?.meta as { scores?: Scores } | null)?.scores ?? {};
}

export async function getCreatorScore(userId: number): Promise<number> {
  const scores = await readScores(userId);
  const sum = SCORE_KEYS.reduce((acc, k) => acc + num(scores[k]), 0);
  return Math.max(sum, num(scores.total));
}

// The per-type *models* score — what the early-access day ladder keys off (distinct from the
// aggregate creator score above).
export async function getModelsScore(userId: number): Promise<number> {
  return num((await readScores(userId)).models);
}

// Moderator-only testing override (this app only), mirroring TEST_MEMBERSHIP_COOKIE. The early-access
// ladder keys off the *models* score, which membership doesn't touch — so simulating a tier alone can't
// reach these flows, and the ladder's first rung is 40k. Set from the sidebar simulator.
export const TEST_MODELS_SCORE_COOKIE = 'cs-test-models-score';

export async function resolveModelsScore(
  userId: number,
  isModerator: boolean,
  testCookie?: string
): Promise<number> {
  if (isModerator && testCookie) {
    const n = Number(testCookie);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return getModelsScore(userId);
}
