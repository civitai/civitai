import { TRPCError } from '@trpc/server';
import { RESTRICTED_ACCOUNT_MESSAGE } from '~/server/common/content-restriction';
import { dbWrite } from '~/server/db/client';

/**
 * Refuses a restricted account, for paths that act for a user without a fresh session (a block
 * token's subject, a credential mint). Reads the primary, not the session, so a restriction applied
 * moments ago is seen. A missing row refuses too.
 */
export async function assertAccountNotRestricted(userId: number): Promise<void> {
  const user = await dbWrite.user.findUnique({
    where: { id: userId },
    select: { muted: true, bannedAt: true },
  });
  if (!user || user.muted || user.bannedAt) {
    throw new TRPCError({ code: 'FORBIDDEN', message: RESTRICTED_ACCOUNT_MESSAGE });
  }
}
