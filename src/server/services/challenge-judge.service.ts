import { USER_SELECTABLE_JUDGE_NAMES } from '~/shared/constants/challenge.constants';

export type UserSelectableJudge = { id: number; name: string; bio: string | null };

// The set of judges offered to non-moderators in the challenge create form. Primary source is the
// ChallengeJudge.userSelectable column; we fall back to the historical name whitelist when that
// column is unusable — either because no row is userSelectable yet, OR because the column does not
// exist in this environment yet (migrations are applied manually here, so code can deploy before
// the migration; the query then throws P2022 and we must still render judges). The user form must
// never render zero judges. dbRead is imported lazily so this module (and its unit test) stays out
// of the full server module graph.
export async function getUserSelectableJudges(): Promise<UserSelectableJudge[]> {
  const { dbRead } = await import('~/server/db/client');
  const select = { id: true, name: true, bio: true } as const;
  const orderBy = { name: 'asc' } as const;

  try {
    const selectable = await dbRead.challengeJudge.findMany({
      where: { active: true, userSelectable: true },
      orderBy,
      select,
    });
    if (selectable.length) return selectable;
  } catch {
    // userSelectable column not present in this env yet — fall through to the name whitelist.
  }

  return dbRead.challengeJudge.findMany({
    where: { active: true, name: { in: [...USER_SELECTABLE_JUDGE_NAMES] } },
    orderBy,
    select,
  });
}
