import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import {
  isModerationAccountRow,
  isReservedModerationUsername,
} from '~/server/auth/moderation-account';
import { forceUpdateUserIdentity } from '~/server/services/user.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { displayName, userId } from '~/server/schema/moderator/user';

export default defineModeratorEndpoint('user.updateIdentity', {
  summary: "Change an account's username, email or display name.",
  returns: '{ updated }',
  privileged: 'retoolUpdateIdentity',
  notes: ['At least one of username, email or name must be sent.'],
  rateLimit: { max: 20, windowSeconds: 60 },
  // A plain ZodObject, not `.refine()`: that returns a ZodEffects, which `specToDoc` cannot project
  // into params for the docs page. The at-least-one rule is enforced in the handler.
  input: z.object({
    userId,
    username: z.string().trim().min(1).max(64).optional().describe('New username.'),
    email: z.string().email().optional().describe('New email address.'),
    name: displayName.optional().describe('New display name.'),
  }),
  async handler(input) {
    if (input.username === undefined && input.email === undefined && input.name === undefined) {
      throw throwBadRequestError('At least one of username, email, name must be provided');
    }
    if (input.username !== undefined) {
      const current = await dbWrite.user.findUnique({
        where: { id: input.userId },
        select: { id: true, username: true },
      });
      const isShared = !!current && isModerationAccountRow(current);
      const reserved = isReservedModerationUsername(input.username);
      if (isShared && !reserved)
        throw throwBadRequestError("The shared moderation account's username cannot be changed.");
      if (!isShared && reserved) throw throwBadRequestError('This username is reserved.');
    }
    const result = await forceUpdateUserIdentity({
      userId: input.userId,
      username: input.username,
      email: input.email,
      name: input.name,
    });
    return { updated: result.updated, affected: { userIds: [input.userId] } };
  },
});
