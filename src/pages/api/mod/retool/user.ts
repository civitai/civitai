/**
 * Retool-callable mod endpoints for User writes.
 * =============================================================================
 *
 * Auth: Bearer <user API key> (mod role required). Privileged actions
 * additionally require the matching granted permission in user.permissions:
 *   - updateIdentity   → `retoolUpdateIdentity`
 *   - toggleModerator  → `retoolToggleModerator`
 *
 * POST /api/mod/retool/user
 * Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   clearProfile     - { userId, fields?: ('location'|'bio'|'message')[] }
 *   mute             - { userId, expiresAt? }           Set muted=true (timed when expiresAt given)
 *   unmute           - { userId }                       Set muted=false
 *   forceLogout      - { userId }                       Invalidate all active sessions
 *   updateIdentity   - { userId, username?, email?, name? }    [privileged]
 *   toggleModerator  - { userId, isModerator: boolean }        [privileged]
 */
import * as z from 'zod';
import { invalidateSession } from '~/server/auth/session-invalidation';
import {
  clearUserProfileFields,
  forceUpdateUserIdentity,
  setUserModerator,
  setUserMuted,
} from '~/server/services/user.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { defineRetoolEndpoint, retoolAction, retoolBoolean } from '~/server/utils/retool-endpoint';

const userId = z.coerce.number().int().positive();

export default defineRetoolEndpoint('user', {
  clearProfile: retoolAction({
    input: z.object({
      userId,
      fields: z.array(z.enum(['location', 'bio', 'message'])).optional(),
    }),
    rateLimit: { max: 60, windowSeconds: 60 },
    async handler(input) {
      const result = await clearUserProfileFields({
        userId: input.userId,
        fields: input.fields,
      });
      return { ...result, affected: { userIds: [input.userId] } };
    },
  }),
  mute: retoolAction({
    // `expiresAt` makes this a TIMED mute lifted by processTimedUnmutes. Omit it for the indefinite
    // mute this action has always performed. A moderator-set expiry is marked manual, so strike
    // de-escalation cannot lift it early — see setUserMuted.
    input: z.object({ userId, expiresAt: z.coerce.date().optional() }),
    rateLimit: { max: 60, windowSeconds: 60 },
    async handler(input) {
      await setUserMuted({ userId: input.userId, muted: true, expiresAt: input.expiresAt ?? null });
      return {
        muted: true,
        expiresAt: input.expiresAt ?? null,
        affected: { userIds: [input.userId] },
      };
    },
  }),
  unmute: retoolAction({
    input: z.object({ userId }),
    rateLimit: { max: 60, windowSeconds: 60 },
    async handler(input) {
      await setUserMuted({ userId: input.userId, muted: false });
      return { muted: false, affected: { userIds: [input.userId] } };
    },
  }),
  forceLogout: retoolAction({
    input: z.object({ userId }),
    rateLimit: { max: 30, windowSeconds: 60 },
    async handler(input) {
      await invalidateSession(input.userId, 'moderation');
      return { loggedOut: true, affected: { userIds: [input.userId] } };
    },
  }),
  updateIdentity: retoolAction({
    // Kept as a plain ZodObject — the wrapper .extends() every action input,
    // and .refine() would return a ZodEffects with no .extend. The
    // at-least-one-field check is enforced in the handler.
    input: z.object({
      userId,
      username: z.string().trim().min(1).max(64).optional(),
      email: z.string().email().optional(),
      name: z.string().trim().max(128).optional(),
    }),
    privileged: 'retoolUpdateIdentity',
    rateLimit: { max: 20, windowSeconds: 60 },
    async handler(input) {
      if (input.username === undefined && input.email === undefined && input.name === undefined) {
        throw throwBadRequestError('At least one of username, email, name must be provided');
      }
      const result = await forceUpdateUserIdentity({
        userId: input.userId,
        username: input.username,
        email: input.email,
        name: input.name,
      });
      return {
        updated: result.updated,
        affected: { userIds: [input.userId] },
      };
    },
  }),
  toggleModerator: retoolAction({
    input: z.object({
      userId,
      isModerator: retoolBoolean,
    }),
    privileged: 'retoolToggleModerator',
    rateLimit: { max: 10, windowSeconds: 60 },
    async handler(input, ctx) {
      await setUserModerator({
        userId: input.userId,
        isModerator: input.isModerator,
        actorId: ctx.actor.id,
      });
      return {
        isModerator: input.isModerator,
        affected: { userIds: [input.userId] },
      };
    },
  }),
});
