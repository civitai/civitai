import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { getRequestTrace } from '~/server/services/app-assistant/submission-trace.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('apps.assistantTrace.request', {
  method: 'GET',
  summary:
    'The App Assistant sessions one app submission was built in: its trace (chats, frozen transcripts, signals) and the submitter’s chats for the app as they stand now.',
  returns:
    '{ request: { id, slug, version, status, submittedAt, submittedByUserId }, trace: { publishRequestId, slug, userId, conversationIds, snapshots: [{ conversationId, key?, bytes?, turns?, error? }], signals, signalsVersion, snapshotError, createdAt } | null, links: [{ userId, conversationId, appSlug, firstSeenAt, lastSeenAt, turnCount, lastModel, buzzTotal }] }',
  notes: [
    'Read-only. `trace` is frozen at submit (null when tracing was off then, or the trace could not be written); `links` are live and may name chats that ran after the submit.',
    '`signals` (shape by `signalsVersion`): sessionCount, turnCount, buzzTotal, models, toolCallCounts, readDocsTopics, editedFiles, accentCustomized (v2+: true | false | null, whether the app has its own look; absent on a v1 row, judge it from `theme` by the same rule), themeCustomized (v1: any colour or token of its own, not the look) and their evidence under `theme`.',
    'Read a frozen chat with GET /api/mod/apps/assistant-trace/transcript; every app submission of a slug with GET /api/mod/apps/assistant-trace/app.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: z.object({ publishRequestId: z.string().trim().min(1).max(64) }),
  async handler({ publishRequestId }) {
    const found = await getRequestTrace(publishRequestId);
    if (!found)
      throw new TRPCError({ code: 'NOT_FOUND', message: `No publish request ${publishRequestId}` });
    return found;
  },
});
