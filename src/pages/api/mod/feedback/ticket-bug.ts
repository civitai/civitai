import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { createFeedback } from '~/server/services/feedback.service';
import { fileFeedbackToHq } from '~/server/services/feedback-hq.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import {
  FEEDBACK_MESSAGE_MAX_LENGTH,
  SITE_BUG_REPORT_AREA,
} from '~/shared/constants/feedback.constants';

export default defineModeratorEndpoint('feedback.ticketBug', {
  summary:
    'File a site bug report from a support ticket, as the moderator app\'s "Bug → dev queue" hand-off does.',
  returns: '{ id, hqUrl }',
  notes: [
    'Requires the moderator app permission `tickets.escalate`, the one the hand-off requires.',
    'The report is filed as the calling moderator, in the site bug-report area, and filed to HQ the way a site report is. `hqUrl` is null when the HQ filing did not happen; the report is saved either way.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    ticketId: z.number().int().positive(),
    message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX_LENGTH),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'tickets.escalate')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Filing a bug from a ticket needs the "tickets.escalate" moderator permission.',
      });

    const context = { reportedSource: 'moderator-ticket' };
    const saved = await createFeedback({
      area: SITE_BUG_REPORT_AREA,
      message: input.message,
      context,
      userId: ctx.actor.id,
      freshdeskTicketId: input.ticketId,
    });
    // Awaited, unlike the site's submit: the moderator is shown the HQ link. It never throws.
    await fileFeedbackToHq({
      feedbackId: saved.id,
      userId: ctx.actor.id,
      area: SITE_BUG_REPORT_AREA,
      message: input.message,
      context,
    });
    // primary: a replica may not have the HQ link `fileFeedbackToHq` wrote a moment ago yet.
    const row = await dbWrite.feedback.findUnique({
      where: { id: saved.id },
      select: { context: true },
    });
    const hq = (row?.context as { hq?: { url?: unknown } } | null)?.hq;
    return {
      id: saved.id,
      hqUrl: typeof hq?.url === 'string' ? hq.url : null,
      affected: { feedbackIds: [saved.id] },
    };
  },
});
