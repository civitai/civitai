import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  holdPostTextForCsam,
  refusePostText,
  restorePostText,
} from '~/server/services/post-text-moderation.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('postText.moderate', {
  summary: 'Refuse, restore, or hold for csam review one storyline text.',
  returns: '{ textId, postId, action, changed, holdId? }',
  notes: [
    '`refuse` hides the text from every reader until a moderator restores it; no scan verdict lifts it. The text and the rest of its post are kept.',
    "`restore` lifts a moderator's refusal. Refused with CONFLICT while the text is held for csam review or kept by a CSAM report or evidence hold.",
    '`hold` opens a Pending csam hold on the text, decided in the CSAM text-hold queue, and hides it meanwhile.',
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
    const moderatorId = ctx.actor.id;
    if (input.action === 'hold') {
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
      affected: { postTextIds: [input.textId], postIds: [result.postId] },
    };
  },
});
