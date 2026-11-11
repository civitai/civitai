import { z } from 'zod';

// The transcript's page, in the URL so a link can point at a stretch of a long chat. Read by every load
// that renders `TranscriptPanel`, and written by the panel's own links.
export const TRANSCRIPT_BEFORE = 'msgBefore';
export const TRANSCRIPT_AFTER = 'msgAfter';
/** Chat Audit's "What they said": the message id its page continues past. */
export const USER_MESSAGES_BEFORE = 'ubefore';

const messageId = z.coerce.number().int().positive().max(2_147_483_647).optional().catch(undefined);

export const transcriptCursorSchema = z.object({
  [TRANSCRIPT_BEFORE]: messageId,
  [TRANSCRIPT_AFTER]: messageId,
});

export const toTranscriptCursor = (q: z.infer<typeof transcriptCursorSchema>) => ({
  before: q[TRANSCRIPT_BEFORE],
  after: q[TRANSCRIPT_BEFORE] ? undefined : q[TRANSCRIPT_AFTER],
});
