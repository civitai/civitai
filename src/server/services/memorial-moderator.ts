import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { assertNotImpersonating } from '~/server/auth/refuse-while-impersonating';
import { invalidateSession } from '~/server/auth/session-invalidation';
import { syncEventRosterMember } from '~/server/events/points/roster-sync';
import { syncOwnerEventHats } from '~/server/events/points/sync';
import { expireUserApiKeys } from '~/server/services/api-key.service';
import type { MemorialEffects } from '~/server/services/memorial.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { bustUserCreator } from '~/server/services/user-creator.service';

/**
 * Every memorial endpoint's gate. An impersonation session is refused because the two-person rule
 * compares moderator ids, and a moderator acting as another moderator would carry the second id.
 */
export async function assertMemorialModerator(ctx: {
  actor: { roles?: string[] };
  req: NextApiRequest;
  res: NextApiResponse;
}) {
  if (!(await hasModeratorGrant(ctx.actor, 'user.memorialize')))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Memorializing an account needs the "user.memorialize" moderator permission.',
    });
  const session = await getServerAuthSession({ req: ctx.req, res: ctx.res });
  assertNotImpersonating(
    { impersonatedBy: session?.impersonatedBy },
    'Memorialization cannot be done while impersonating.'
  );
}

export const memorialEffects: MemorialEffects = {
  invalidateSession,
  expireUserApiKeys,
  bustUserCreator,
  syncEventStanding: async (userId) => {
    void syncOwnerEventHats(userId);
    void syncEventRosterMember(userId);
  },
};
