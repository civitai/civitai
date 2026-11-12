import { z } from 'zod';
import type { LayoutServerLoad } from './$types';
import { parseQueryKeys } from '$lib/server/query';
import { MAX_INT4, usernameExists } from '$lib/server/users.service';
import {
  chatExists,
  classifySearch,
  getChatMembers,
  getChatReports,
  getTranscript,
  transcriptPosition,
  type TranscriptCursor,
} from '$lib/server/chat-audit.service';
import { readerOf, type Reader } from '$lib/server/chat-read-audit';
import { chatSubject } from '$lib/entity-report-queues';
import { toTranscriptCursor, transcriptCursorSchema } from '$lib/chat-transcript-cursor';

// The open chat lives in the LAYOUT: every tab shows it beside its own list. `parseQueryKeys`, so the
// lists' own params (search page, report page, status filter) do not reload it — a transcript load is a
// logged read. `q` does, for the highlight; a new search drops `chat` anyway.
//
// `chat` is bounded to int4: Chat.id is a Postgres integer, and a larger value ERRORS the comparison
// rather than missing.
const layoutQuery = transcriptCursorSchema.extend({
  q: z.string().trim().catch(''),
  chat: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
});

export const load: LayoutServerLoad = async ({ url, locals }) => {
  const query = parseQueryKeys(url, layoutQuery);
  const { q, chat } = query;

  const [isAccount, open] = await Promise.all([
    q && classifySearch(q) === 'user' ? usernameExists(q.replace(/^@/, '')) : false,
    chat ? openChat(readerOf(locals.user), chat, toTranscriptCursor(query)) : null,
  ]);

  return {
    q,
    highlight: searchHighlight(q, isAccount),
    chatId: chat ?? null,
    chat: open,
    fullBleed: true,
    headerInline: true,
  };
};

/** What the open chat marks for the current search, mirroring how `searchChats` reads the term: a
 *  username with no account falls through to message text unless it was forced with `@`. */
function searchHighlight(q: string, isAccount: boolean) {
  if (!q) return null;
  if (isAccount) return { kind: 'user' as const, username: q.replace(/^@/, '') };
  const mode = classifySearch(q);
  if (mode === 'content' || (mode === 'user' && !q.startsWith('@')))
    return { kind: 'content' as const, term: q };
  return null;
}

async function openChat(reader: Reader, chatId: number, cursor: TranscriptCursor) {
  const [exists, transcript, members, reports] = await Promise.all([
    chatExists(chatId),
    getTranscript(reader, chatId, cursor),
    getChatMembers(chatId),
    getChatReports(chatId),
  ]);
  if (!exists) return { chatId, missing: true as const };

  const first = transcript.rows[0];
  const { subjectIds, reporterIds } = chatSubject(members, reports);
  return {
    chatId,
    missing: false as const,
    transcript,
    members,
    position: first ? await transcriptPosition(chatId, first.id) : null,
    around: cursor.around ?? null,
    reported: reports.length > 0,
    reportedIds: subjectIds,
    reporterIds,
  };
}
