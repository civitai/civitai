import { TRPCError } from '@trpc/server';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import {
  setCsamHoldReportChoice,
  setCsamHoldReportChoiceInput,
} from '~/server/services/text-scan/csam-hold-decision';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('textScan.setCsamHoldReportChoice', {
  summary: 'Record the report choice on a confirmed csam hold decided without one.',
  returns: '{ holdId, reportChoice }',
  notes: [
    'Requires the moderator app permission `csam.report.file`.',
    'For a hold confirmed alongside another (a batch records no choice) or by a moderator app that predates the choice. Records who set it and when in `meta.reportChoiceSet`. `none` takes the hold off the "Report not filed" view; a reportable category keeps it there until a report covers it or it is marked included.',
    'Refuses with CONFLICT when the hold is missing, not a confirmed csam hold, or already has a choice.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: setCsamHoldReportChoiceInput,
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'csam.report.file')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Setting a report choice needs the "csam.report.file" moderator permission.',
      });
    const result = await setCsamHoldReportChoice({
      holdId: input.holdId,
      reportChoice: input.reportChoice,
      actor: { id: ctx.actor.id },
    });
    return { ...result, affected: { textScanHoldIds: [input.holdId] } };
  },
});
