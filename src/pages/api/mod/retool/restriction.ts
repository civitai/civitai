/**
 * Retool-callable mod endpoints for generation restrictions (`UserRestriction`).
 * =============================================================================
 *
 * Auth: Bearer <user API key> (mod role required). No privileged gate beyond the
 * baseline isModerator check — ruling on a restriction is the same class of action
 * as mute/unmute in ./user.ts.
 *
 * Why this exists: a system restriction leaves the account muted with a Pending
 * row, and clearing the mute alone resolves nothing — the row stays Pending, the
 * subscription stays cancelled, the prohibited-request count stays where it was
 * and the user is never told. `resolveUserRestriction` is the single write path
 * for that verdict; before this endpoint it was reachable only from the tRPC
 * moderator router, i.e. not from the moderator app.
 *
 * POST /api/mod/retool/restriction
 * Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   resolve - { userRestrictionId, status: 'Overturned'|'Upheld', resolvedMessage? }
 *             Rules on a Pending restriction. resolvedBy = calling mod.
 */
import * as z from 'zod';
import { resolveUserRestriction } from '~/server/services/user-restriction-resolve.service';
import { UserRestrictionStatus } from '~/shared/utils/prisma/enums';
import { defineRetoolEndpoint, retoolAction } from '~/server/utils/retool-endpoint';

export default defineRetoolEndpoint('restriction', {
  resolve: retoolAction({
    input: z.object({
      userRestrictionId: z.coerce.number().int().positive(),
      // Pending is not offered: it is the state being ruled on, and the service
      // refuses anything already resolved.
      status: z.enum([UserRestrictionStatus.Overturned, UserRestrictionStatus.Upheld]),
      resolvedMessage: z.string().trim().max(1000).optional(),
    }),
    rateLimit: { max: 30, windowSeconds: 60 },
    async handler(input, ctx) {
      const { userId } = await resolveUserRestriction({
        userRestrictionId: input.userRestrictionId,
        status: input.status,
        resolvedMessage: input.resolvedMessage,
        moderatorId: ctx.actor.id,
      });
      return { resolved: input.status, affected: { userIds: [userId] } };
    },
  }),
});
