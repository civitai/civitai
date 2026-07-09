/**
 * Retool-callable mod endpoints for User strikes.
 * =============================================================================
 *
 * Auth: Bearer <user API key> (mod role required). No privileged gate beyond the
 * baseline isModerator check — any moderator may issue/void strikes, consistent
 * with mute/unmute in ./user.ts.
 *
 * Attribution: the calling moderator (ctx.actor) is threaded into the service as
 * issuedBy (create) / voidedBy (void), so every strike records who issued or
 * voided it. Every call is additionally audit-logged to ClickHouse by the
 * defineRetoolEndpoint wrapper.
 *
 * POST /api/mod/retool/strike
 * Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   create          - { userId, reason, points?, description, internalNotes?,
 *                       entityType?, entityId?, reportId?, expiresInDays? }
 *                     Issues a strike. issuedBy = calling mod. Returns the strike,
 *                     or { skipped: true } when a non-manual strike is rate-limited
 *                     (max 1 auto-strike/day/user; ManualModAction bypasses this).
 *   void            - { strikeId, voidReason }   Voids an active strike. voidedBy = calling mod.
 *   getUserStrikes  - { userId, includeExpired? }  Read strikes (incl. internal notes) for a user.
 */
import * as z from 'zod';
import {
  createStrike,
  getStrikesForUser,
  voidStrike,
} from '~/server/services/strike.service';
import { EntityType, StrikeReason } from '~/shared/utils/prisma/enums';
import {
  defineRetoolEndpoint,
  retoolAction,
  retoolBoolean,
} from '~/server/utils/retool-endpoint';

const userId = z.coerce.number().int().positive();

export default defineRetoolEndpoint('strike', {
  create: retoolAction({
    input: z.object({
      userId,
      reason: z.enum(StrikeReason),
      points: z.coerce.number().int().min(1).max(3).default(1),
      description: z.string().trim().min(1).max(1000),
      internalNotes: z.string().trim().max(2000).optional(),
      entityType: z.enum(EntityType).optional(),
      entityId: z.coerce.number().int().positive().optional(),
      reportId: z.coerce.number().int().positive().optional(),
      expiresInDays: z.coerce.number().int().min(1).max(365).default(30),
    }),
    rateLimit: { max: 30, windowSeconds: 60 },
    async handler(input, ctx) {
      const strike = await createStrike({
        userId: input.userId,
        reason: input.reason,
        points: input.points,
        description: input.description,
        internalNotes: input.internalNotes,
        entityType: input.entityType,
        entityId: input.entityId,
        reportId: input.reportId,
        expiresInDays: input.expiresInDays,
        issuedBy: ctx.actor.id,
      });
      // createStrike returns null when a non-manual strike is rate-limited.
      return {
        strike,
        skipped: strike === null,
        affected: { userIds: [input.userId] },
      };
    },
  }),
  void: retoolAction({
    input: z.object({
      strikeId: z.coerce.number().int().positive(),
      voidReason: z.string().trim().min(1).max(1000),
    }),
    rateLimit: { max: 30, windowSeconds: 60 },
    async handler(input, ctx) {
      const strike = await voidStrike({
        strikeId: input.strikeId,
        voidReason: input.voidReason,
        voidedBy: ctx.actor.id,
      });
      return { strike, affected: { userIds: [strike.userId] } };
    },
  }),
  getUserStrikes: retoolAction({
    input: z.object({
      userId,
      includeExpired: retoolBoolean.optional(),
    }),
    rateLimit: { max: 60, windowSeconds: 60 },
    async handler(input) {
      const result = await getStrikesForUser(input.userId, {
        includeExpired: input.includeExpired ?? false,
        includeInternalNotes: true,
      });
      return { ...result, affected: { userIds: [input.userId] } };
    },
  }),
});
