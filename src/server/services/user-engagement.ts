import { dbWrite } from '~/server/db/client';
import { isPrismaUniqueViolation } from '~/server/utils/errorHandling';
import type { UserEngagementType } from '~/shared/utils/prisma/enums';

/**
 * `UserEngagement` holds ONE row per (userId, targetUserId) pair carrying ONE
 * `type`, so Follow / Hide / Block are mutually exclusive by construction and the
 * pair has a precedence order: Block outranks Hide outranks Follow.
 *
 * Every writer of that table goes through these two functions. Addressing the row
 * by its primary key alone — `update`/`delete` on `userId_targetUserId` — is what
 * let an ordinary hide overwrite a block, so neither of these can express that.
 */

/** Put `type` on the pair unless a type in `outrankedBy` holds it. */
export async function setUserEngagement({
  userId,
  targetUserId,
  type,
  outrankedBy = [],
}: {
  userId: number;
  targetUserId: number;
  type: UserEngagementType;
  outrankedBy?: UserEngagementType[];
}): Promise<boolean> {
  const pair = { userId, targetUserId };
  const claimable = outrankedBy.length ? { type: { notIn: outrankedBy } } : {};

  // Two passes, never more, so a losing writer cannot spin. Pass one handles the
  // ordinary cases: a claimable row is converted, an empty pair is inserted.
  //
  // Pass two exists for one schedule — the pair was empty at the update and a
  // CLAIMABLE row was inserted before ours, so the update matched nothing and the
  // create hit the PK. Returning after one pass would drop the write silently
  // while reporting it applied. Re-running the same scoped update converts that
  // row; if what won is outranking instead, it matches nothing again and we
  // report the pair as not ours, which is the intended end state.
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
