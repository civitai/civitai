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

export async function getCreatorScore(userId: number): Promise<number> {
  const row = await dbRead
    .selectFrom('User')
    .select('meta')
    .where('id', '=', userId)
    .executeTakeFirst();

  const scores = (row?.meta as { scores?: Scores } | null)?.scores ?? {};
  const sum = SCORE_KEYS.reduce((acc, k) => acc + num(scores[k]), 0);
  return Math.max(sum, num(scores.total));
}
