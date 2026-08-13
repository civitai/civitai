import {
  DEFAULT_JUDGING_ENGINE,
  isJudgingEngineKey,
  type JudgingEngineKey,
} from '~/server/games/daily-challenge/challenge-judging-engine';
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

// The engine a NEW challenge inherits from its assigned judge. Callers COPY the result onto
// Challenge.judgingEngine; the judge row is never consulted again, so re-pointing a judge does not
// re-point a challenge already in flight.
//
// Falls back to the default engine on every uncertain answer — no judge, an unrecognised value, or
// a throw. The throw is the same P2022 case getUserSelectableJudges guards: migrations are applied
// by hand here, so this code can be live before the column exists, and challenge creation must not
// start failing in the window between.
export async function resolveJudgingEngineForJudge(
  judgeId: number | null | undefined
): Promise<JudgingEngineKey> {
  if (judgeId == null) return DEFAULT_JUDGING_ENGINE;
  const { dbRead } = await import('~/server/db/client');

  try {
    const judge = await dbRead.challengeJudge.findUnique({
      where: { id: judgeId },
      select: { judgingEngine: true },
    });
    return isJudgingEngineKey(judge?.judgingEngine) ? judge.judgingEngine : DEFAULT_JUDGING_ENGINE;
  } catch {
    return DEFAULT_JUDGING_ENGINE;
  }
}

// The `Challenge.judgingEngine` fragment to spread into a create. EMPTY for the default engine, on
// purpose: Challenge.judgingEngine is manually migrated too, so writing it unconditionally would
// break every challenge creation in an environment that has not applied the migration yet. Omitting
// it lets the column default do the work and keeps legacy creation identical to today.
export async function challengeJudgingEngineForCreate(
  judgeId: number | null | undefined
): Promise<{ judgingEngine?: JudgingEngineKey }> {
  const engine = await resolveJudgingEngineForJudge(judgeId);
  return engine === DEFAULT_JUDGING_ENGINE ? {} : { judgingEngine: engine };
}
