import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const DECISION_STATUS = { dismiss: 'Dismissed' } as const;

export default defineModeratorEndpoint('textScan.resolveCsamHold', {
  summary: 'Decide a pending csam text-scan hold.',
  returns: '{ holdId, status: "Dismissed" }',
  notes: [
    'Requires the moderator app permission `csam.report.file`.',
    'Dismiss closes the hold and changes nothing on the held content or its author.',
    'Refuses with CONFLICT when the hold is missing, not a csam hold, or no longer Pending.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    holdId: z.coerce.number().int().positive().max(2147483647),
    decision: z.enum(['dismiss']),
    note: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe('Moderator-only note recorded on the hold.'),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'csam.report.file')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Deciding a csam hold needs the "csam.report.file" moderator permission.',
      });

    const status = DECISION_STATUS[input.decision];
    const { count } = await dbWrite.textScanHold.updateMany({
      where: { id: input.holdId, label: 'csam', status: 'Pending' },
      data: {
        status,
        decidedAt: new Date(),
        decidedById: ctx.actor.id,
        decisionNote: input.note || null,
      },
    });
    if (count === 0)
      throw new TRPCError({ code: 'CONFLICT', message: 'Hold already decided or missing.' });

    const hold = await dbWrite.textScanHold.findUnique({
      where: { id: input.holdId },
      select: { entityType: true, entityId: true },
    });
    logToAxiom({
      name: 'text-scan',
      type: 'csam-hold-decision',
      message: 'csam hold decided',
      holdId: input.holdId,
      entityType: hold?.entityType,
      entityId: hold?.entityId,
      decision: input.decision,
      moderatorId: ctx.actor.id,
    }).catch(() => null);

    return { holdId: input.holdId, status, affected: { textScanHoldIds: [input.holdId] } };
  },
});
