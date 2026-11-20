import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import {
  CREATOR_PROGRAM_BAN_GATE_REF_MAX,
  CREATOR_PROGRAM_BAN_REASON_MAX,
  setCreatorProgramBan,
} from '~/server/services/creator-program-ban.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.creator-program-ban', {
  summary: 'Ban an account from the Creator Program, or lift that ban.',
  returns: '{ userId, action, before, after, changed }',
  notes: [
    'Requires the moderator app permission `user.creatorProgram.ban`.',
    'Sets or clears only the Creator Program ban flag on the account; nothing else about it changes.',
    'Repeating a call changes nothing (`changed: false`) and is still recorded.',
    'A ModActivity row with the reason, gateRef and the before/after flags is written with the change.',
  ],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: z.object({
    userId,
    action: z.enum(['set', 'clear']).describe('`set` bans, `clear` lifts the ban.'),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(CREATOR_PROGRAM_BAN_REASON_MAX)
      .describe('Why: an audit note for moderators. The user does not see it.'),
    gateRef: z
      .string()
      .trim()
      .min(1)
      .max(CREATOR_PROGRAM_BAN_GATE_REF_MAX)
      .optional()
      .describe('The approval this acts on, e.g. a hub card id. Recorded in the audit.'),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.creatorProgram.ban')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Changing a Creator Program ban needs the "user.creatorProgram.ban" moderator permission.',
      });

    const result = await setCreatorProgramBan({ ...input, moderatorId: ctx.actor.id });
    return { ...result, affected: { userIds: [input.userId] } };
  },
});
