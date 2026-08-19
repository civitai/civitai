import * as z from 'zod';
import { createStrike } from '~/server/services/strike.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { EntityType, StrikeReason } from '~/shared/utils/prisma/enums';

export default defineModeratorEndpoint('strike.create', {
  summary: 'Issue a strike against an account.',
  returns: '{ strike, skipped }',
  notes: [
    '`issuedBy` is the calling moderator.',
    'Non-manual strikes are limited to one per user per day; a rate-limited call returns `skipped: true` with a null strike rather than failing. `ManualModAction` bypasses that limit.',
    'Any moderator may issue a strike — no extra permission, consistent with mute/unmute.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    userId: z.coerce.number().int().positive().describe('The account to strike.'),
    reason: z.enum(StrikeReason).describe('Why the strike was issued.'),
    points: z.coerce.number().int().min(1).max(3).default(1).describe('Severity, 1–3.'),
    description: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe('Shown to the user — this is the message they receive.'),
    internalNotes: z.string().trim().max(2000).optional().describe('Not shown to the user.'),
    entityType: z.enum(EntityType).optional().describe('What the strike is about, if anything.'),
    entityId: z.coerce.number().int().positive().optional().describe('Id of that entity.'),
    reportId: z.coerce.number().int().positive().optional().describe('Report this resolves.'),
    expiresInDays: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30)
      .describe('Lifetime in days.'),
  }),
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
    return { strike, skipped: strike === null, affected: { userIds: [input.userId] } };
  },
});
