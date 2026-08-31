import { dbWrite } from '~/server/db/client';
import { isPrismaUniqueViolation } from '~/server/utils/errorHandling';
import { UserEngagementType } from '~/shared/utils/prisma/enums';

/**
 * `UserEngagement` holds ONE row per (userId, targetUserId) pair carrying ONE
 * `type`, so Follow / Hide / Block are mutually exclusive by construction.
 *
 * Addressing that row by its primary key alone — `update`/`delete` on
 * `userId_targetUserId` — is what let an ordinary hide overwrite a block, and
 * neither function here can express it.
 *
 * Three writers stay outside them, deliberately: `toggleBlockUser` keeps the
 * `upsert` that #4210 settled on for the block itself, `toggleFollowUser` converts
 * a Hide into a Follow — a deliberate downgrade rather than a claim, which has no
 * expression here — and `deleteUser` clears every pair the account appears in,
 * which is a different shape from one pair and one type. Every
 * other writer routes through these two, and a new one should.
 *
 * Do NOT call either inside an interactive `$transaction`. Prisma does not
 * savepoint per statement, so the swallowed P2002 below would poison the rest of
 * the transaction — and an INSERT conflicting with a row that transaction still
 * holds waits on the lock instead of failing fast, which is unbounded rather than
 * the sub-millisecond wait it is today.
 */

/** Weakest first. The only place the precedence order is written down. */
const PRECEDENCE = [
  UserEngagementType.Follow,
  UserEngagementType.Hide,
  UserEngagementType.Block,
] as const;

/**
 * Put `type` on the pair unless a type that outranks it holds it — a Hide never
 * overwrites a Block, and nothing overwrites one but a Block.
 *
 * Derived from `type` rather than passed in: an optional "which types outrank
 * this one" argument defaults to no protection, so omitting it at one call site
 * silently reproduces the write this file exists to prevent.
 *
 * Returns whether the pair now carries `type`.
 */
export async function setUserEngagement({
  userId,
  targetUserId,
  type,
}: {
  userId: number;
  targetUserId: number;
  type: UserEngagementType;
}): Promise<boolean> {
  const pair = { userId, targetUserId };
  const outranking = PRECEDENCE.slice(PRECEDENCE.indexOf(type) + 1);
  // Nothing outranks a Block, so its update is unconditional — correct by
  // construction here rather than by an argument someone remembered to omit.
  const claimable = outranking.length ? { type: { notIn: outranking } } : {};

  // Two passes, never more, so a losing writer cannot spin. Pass one handles the
  // ordinary cases: a claimable row is converted, an empty pair is inserted.
  //
  // Pass two exists for one schedule — the pair was empty at the update and a
  // CLAIMABLE row was inserted before ours, so the update matched nothing and the
  // create hit the PK. Returning after one pass would drop the write silently
  // while reporting it applied. Re-running the same scoped update converts that
  // row; if what won outranks us instead, it matches nothing again and we report
  // the pair as not ours, which is the intended end state.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { count } = await dbWrite.userEngagement.updateMany({
      where: { ...pair, ...claimable },
      data: { type },
    });
    if (count) return true;

    const created = await dbWrite.userEngagement
      .create({ data: { ...pair, type } })
      .then(() => true)
      .catch((error) => {
        if (!isPrismaUniqueViolation(error)) throw error;
        return false;
      });
    if (created) return true;
  }

  return false;
}

/** Remove `type` from the pair, and only `type`. */
export async function clearUserEngagement({
  userId,
  targetUserId,
  type,
}: {
  userId: number;
  targetUserId: number;
  type: UserEngagementType;
}): Promise<boolean> {
  const { count } = await dbWrite.userEngagement.deleteMany({
    where: { userId, targetUserId, type },
  });

  return count > 0;
}
