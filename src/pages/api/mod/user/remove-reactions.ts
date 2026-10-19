import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { userId } from '~/server/schema/moderator/user';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  IMAGE_ROWS_PER_RUN,
  removeUserReactions,
} from '~/server/services/user-reaction-erasure.service';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('user.removeReactions', {
  summary: 'Remove every reaction an account has made, for a data-subject request.',
  returns: '{ userId, removed: { ImageReaction, ArticleReaction, ... }, remaining, auditRecorded }',
  notes: [
    'Requires the moderator app permission `user.removeReactions`: held by `moderator:admin`, and by any role granted it on the moderator app’s `/admin`.',
    '`username` is REQUIRED for any account that has one, so a mistyped id cannot land on another account.',
    `Image reactions go at most ${IMAGE_ROWS_PER_RUN.toLocaleString()} per call. \`remaining\` > 0 means call again; every other table is cleared in one call.`,
    'Reaction counts follow the delete: Image, Post and owner counts through the event engine, Article, BountyEntry, Post, Question and Answer metrics are queued for recompute, and comment counts update by trigger.',
    "NOT corrected: content owners' all-time reactions-received score (ClickHouse `reactions_owner_scores`). That needs a separate correction computed from the reactor's ClickHouse rows.",
    'Irreversible: no copy of the removed rows is kept.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  // The confirmation is checked and dropped, as on `user.delete`: the user id is the durable key.
  auditExclude: ['username'],
  input: z.object({
    userId,
    username: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('REQUIRED for any account that has a username. Send it in the body.'),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'user.removeReactions')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Removing reactions needs the "user.removeReactions" moderator permission.',
      });
    if (typeof ctx.req.query.username !== 'undefined')
      throw throwBadRequestError('Send `username` in the request body, not the query string.');

    const target = await dbWrite.user.findFirst({
      where: { id: input.userId },
      select: { id: true, username: true },
    });
    if (!target) throw throwNotFoundError(`No user with id ${input.userId}`);
    // Same rule and wording as `user.delete`: the refusal must not name the account it asks about.
    if (target.username !== null && input.username === undefined)
      throw throwBadRequestError(
        'Send `username` to confirm which account this is — look it up before retrying.'
      );
    if (input.username !== undefined && input.username !== target.username?.trim())
      throw throwBadRequestError(
        `That username does not belong to user ${input.userId}. Check the id and try again.`
      );

    const { removed, remaining } = await removeUserReactions(input.userId);

    // After the delete has committed, so a failed audit write must not read as a failed removal.
    let auditRecorded = true;
    try {
      await trackModActivity(ctx.actor.id, {
        entityType: 'user',
        entityId: input.userId,
        activity: 'removeReactions',
      });
    } catch (e) {
      auditRecorded = false;
      logToAxiom({
        type: 'error',
        name: 'mod-remove-reactions-audit-failed',
        message: (e as Error).message,
        details: { moderatorId: ctx.actor.id, targetUserId: input.userId },
      });
    }

    return {
      userId: input.userId,
      removed,
      remaining,
      auditRecorded,
      affected: { userIds: [input.userId], removed, remaining },
    };
  },
});
