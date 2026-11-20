import { TRPCError } from '@trpc/server';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import {
  referCsamHoldInput,
  referCsamHoldToLead,
} from '~/server/services/text-scan/csam-hold-decision';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('textScan.referCsamHold', {
  summary: 'Send a pending csam text-scan hold to the Moderation Lead without deciding it.',
  returns: '{ holdId, status: "Pending" }',
  notes: [
    'Requires the moderator app permission `csam.report.file`, as a decision does.',
    'The hold stays Pending with no report choice; it is marked for lead review on the holds page.',
    'Refuses with CONFLICT when the hold is missing, not a csam hold, no longer Pending, or its text changed since `textHash` was read.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: referCsamHoldInput,
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'csam.report.file')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Referring a csam hold needs the "csam.report.file" moderator permission.',
      });
    const result = await referCsamHoldToLead({
      holdId: input.holdId,
      textHash: input.textHash,
      note: input.note,
      actor: { id: ctx.actor.id },
    });
    return { ...result, affected: { textScanHoldIds: [input.holdId] } };
  },
});
