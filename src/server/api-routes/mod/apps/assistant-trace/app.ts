import * as z from 'zod';
import { getAppTraces } from '~/server/services/app-assistant/submission-trace.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('apps.assistantTrace.app', {
  method: 'GET',
  summary:
    'Every submission of one app with its App Assistant trace, newest first, and every App Assistant chat linked to the app.',
  returns:
    '{ requests: [{ request: { id, slug, version, status, submittedAt, submittedByUserId }, trace | null }], nextCursor: string | null, links: [{ userId, conversationId, appSlug, firstSeenAt, lastSeenAt, turnCount, lastModel, buzzTotal }] }',
  notes: [
    'Read-only. Page with `cursor` = the previous answer’s `nextCursor`.',
    '`links` are each chat’s own claim of the app it worked on, for any user (at most 200, newest first); only a submitter’s own links feed that submitter’s trace.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({
    slug: z.string().trim().min(1).max(64).describe('The app’s slug (its blockId).'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().trim().min(1).max(64).optional(),
  }),
  async handler({ slug, limit, cursor }) {
    return getAppTraces(slug, { limit, ...(cursor ? { cursor } : {}) });
  },
});
