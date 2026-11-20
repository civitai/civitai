import { TRPCError } from '@trpc/server';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import {
  markCsamHoldReported,
  markCsamHoldReportedInput,
} from '~/server/services/text-scan/csam-hold-decision';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('textScan.markCsamHoldReported', {
  summary:
    "Confirm that a confirmed csam hold's item went into a CSAM report or a supplemental, or take the mark back.",
  returns: '{ holdId, reportIncluded }',
  notes: [
    'Requires the moderator app permission `csam.report.file`.',
    'Records who confirmed it and when in `meta.reportIncluded`; the hold leaves the "Report not filed" view. `included: false` removes the mark and puts the hold back.',
    'Refuses with CONFLICT when the hold is missing, not a confirmed csam hold with a reportable choice, already marked, or (undo) not marked.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: markCsamHoldReportedInput,
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'csam.report.file')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Marking a csam hold reported needs the "csam.report.file" moderator permission.',
      });
    const result = await markCsamHoldReported({
      holdId: input.holdId,
      included: input.included,
      actor: { id: ctx.actor.id },
    });
    return { ...result, affected: { textScanHoldIds: [input.holdId] } };
  },
});
