import { USER_SELECTABLE_JUDGE_NAMES } from '~/shared/constants/challenge.constants';

export type UserSelectableJudge = { id: number; name: string; bio: string | null };

// The set of judges offered to non-moderators in the challenge create form. Primary source is the
// ChallengeJudge.userSelectable column; when an environment has not yet applied/seeded that column
// (migrations are manual here) no row is userSelectable, so we fall back to the historical name
// whitelist — the user form must never render zero judges. dbRead is imported lazily so this module
// (and its unit test) stays out of the full server module graph.
export async function getUserSelectableJudges(): Promise<UserSelectableJudge[]> {
  const { dbRead } = await import('~/server/db/client');
  const select = { id: true, name: true, bio: true } as const;
  const orderBy = { name: 'asc' } as const;

  const selectable = await dbRead.challengeJudge.findMany({
    where: { active: true, userSelectable: true },
    orderBy,
    select,
  });
  if (selectable.length) return selectable;

  return dbRead.challengeJudge.findMany({
    where: { active: true, name: { in: [...USER_SELECTABLE_JUDGE_NAMES] } },
    orderBy,
    select,
  });
}
