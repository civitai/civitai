import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { readSnapshotTranscript } from '~/server/services/app-assistant/submission-trace.service';
import {
  DEFAULT_TOOL_OUTPUT_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
} from '~/shared/app-assistant/transcript-view';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const REASONS = {
  'no-trace': 'No App Assistant trace was recorded for that request',
  'not-in-trace': 'That chat is not part of the request’s trace',
  'not-frozen': 'That chat could not be frozen at submit (see its snapshot error)',
  unreadable: 'The frozen transcript could not be read just now',
} as const;

export default defineModeratorEndpoint('apps.assistantTrace.transcript', {
  method: 'GET',
  summary:
    'One App Assistant chat as it was frozen when an app was submitted: turn by turn, the user’s words, the reply’s text and each tool call with its input and output.',
  returns:
    '{ publishRequestId, capturedAt, transcript: { conversationId, title, model, turns: [{ seq, createdAt, user, status, buzz, error, steps: [{ kind: text|reasoning|tool, text?, tool?, toolCallId?, input?, output?, outputTruncated?, isError? }] }] } }',
  notes: [
    'Read-only; every read is audited. The transcript is the user’s own chat: moderators only, never shown to anyone else.',
    `Each tool output is cut to \`toolOutputChars\` (default ${DEFAULT_TOOL_OUTPUT_CHARS}, at most ${MAX_TOOL_OUTPUT_CHARS}); \`outputTruncated\` marks one that was cut.`,
    'Take `conversationId` from the request’s trace (GET /api/mod/apps/assistant-trace/request).',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    publishRequestId: z.string().trim().min(1).max(64),
    conversationId: z.string().trim().min(1).max(200),
    toolOutputChars: z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_TOOL_OUTPUT_CHARS)
      .default(DEFAULT_TOOL_OUTPUT_CHARS),
  }),
  async handler({ publishRequestId, conversationId, toolOutputChars }) {
    const read = await readSnapshotTranscript(publishRequestId, conversationId, {
      toolOutputChars,
    });
    if (!read.ok)
      throw new TRPCError({
        code: read.reason === 'unreadable' ? 'SERVICE_UNAVAILABLE' : 'NOT_FOUND',
        message: REASONS[read.reason],
      });
    return { publishRequestId, capturedAt: read.capturedAt, transcript: read.transcript };
  },
});
