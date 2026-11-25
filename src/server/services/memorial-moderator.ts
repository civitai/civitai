import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { invalidateSession, refreshSession } from '~/server/auth/session-invalidation';
import { syncEventRosterMember } from '~/server/events/points/roster-sync';
import { syncOwnerEventHats } from '~/server/events/points/sync';
import { expireUserApiKeys } from '~/server/services/api-key.service';
import { memorialActorRefusal, type MemorialEffects } from '~/server/services/memorial.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { bustUserCreator } from '~/server/services/user-creator.service';

/** Every memorial endpoint's gate; the rule is {@link memorialActorRefusal}. */
export async function assertMemorialModerator(
  ctx: { actor: { roles?: string[] }; req: NextApiRequest; res: NextApiResponse },
  deps = { getSession: getServerAuthSession, hasGrant: hasModeratorGrant }
) {
  const session = await deps.getSession({ req: ctx.req, res: ctx.res });
  const refusal = memorialActorRefusal({
    mayMemorialize: await deps.hasGrant(ctx.actor, 'user.memorialize'),
    impersonatedBy: session?.impersonatedBy,
  });
  if (refusal) throw new TRPCError({ code: 'FORBIDDEN', message: refusal });
}

export const memorialEffects: MemorialEffects = {
  invalidateSession,
  refreshSession: (userId) => refreshSession(userId, { caller: 'moderation' }),
  expireUserApiKeys,
  bustUserCreator,
  syncEventStanding: async (userId) => {
    void syncOwnerEventHats(userId);
    void syncEventRosterMember(userId);
  },
};
