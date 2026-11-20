import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { postTextReportOpensCsamHold } from '@civitai/shared/post-text-report';
import { hasModeratorPageAccess } from '~/server/services/moderator-grants';
import {
  getPostTextReportReason,
  holdPostTextForCsam,
  refusePostText,
  restorePostText,
} from '~/server/services/post-text-moderation.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('postText.moderate', {
  summary: 'Refuse, restore, or hold for csam review one storyline text.',
  returns: '{ textId, postId, action, changed, stillRefused?, holdId? }',
  notes: [
    '`refuse` hides the text from every reader until a moderator restores it; no scan verdict lifts it. The text and the rest of its post are kept.',
    "`restore` lifts a moderator's refusal; a refusal the text scan made stands (`stillRefused`). Refused with CONFLICT while the text is held for csam review or kept by a CSAM report or evidence hold.",
    '`hold` opens a Pending csam hold on the text, decided in the CSAM text-hold queue, and hides it meanwhile. It needs `reportId`: a report on this text with a CSAM or minor-sexualization reason (BAD_REQUEST otherwise).',
    "Requires the moderator app's post report queue, granted by its `/reports` section (FORBIDDEN otherwise).",
    '`changed` is false when the text was already in the requested state.',
    'Resolves no report: the caller sets the report status.',
  ],
  rateLimit: { max: 120, windowSeconds: 60 },
  input: z.object({
    textId: z.coerce.number().int().positive().describe('The PostText id.'),
    action: z.enum(['refuse', 'restore', 'hold']),
    reason: z.string().trim().min(1).max(500).describe('Why, for the audit row.'),
    reportId: z.coerce.number().int().positive().optional().describe('The report acted on.'),
  }),
  async handler(input, ctx) {
    // `/reports`, not `/reports/post`: the post queue is granted by its section's row.
    if (!(await hasModeratorPageAccess(ctx.actor, '/reports')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: "Moderating a text needs the moderator app's report queues.",
      });
    const moderatorId = ctx.actor.id;
    if (input.action === 'hold') {
      const report = input.reportId
        ? await getPostTextReportReason(input.reportId, input.textId)
        : null;
      if (!report || !postTextReportOpensCsamHold(report))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only a CSAM or minor-sexualization report on this text opens a CSAM hold.',
        });
      const held = await holdPostTextForCsam({
        textId: input.textId,
        moderatorId,
        reportId: input.reportId,
      });
      if (!held) throw new TRPCError({ code: 'NOT_FOUND', message: 'That text no longer exists.' });
      return {
        textId: input.textId,
        postId: held.postId,
        action: input.action,
        changed: held.changed,
        holdId: held.holdId,
        affected: { postTextIds: [input.textId], textScanHoldIds: [held.holdId] },
      };
    }

    const result =
      input.action === 'refuse'
        ? await refusePostText({ textId: input.textId, moderatorId })
        : await restorePostText({ textId: input.textId, moderatorId });
    if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'That text no longer exists.' });
    if (!result.ok)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'That text is held for CSAM review and can only be released from the CSAM queue.',
      });
    return {
      textId: input.textId,
      postId: result.postId,
      action: input.action,
      changed: result.changed,
      ...(result.stillRefused !== undefined ? { stillRefused: result.stillRefused } : {}),
      affected: { postTextIds: [input.textId], postIds: [result.postId] },
    };
  },
});
