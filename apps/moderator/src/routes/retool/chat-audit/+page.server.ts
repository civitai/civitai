import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import {
  getChatMembers,
  getChatReports,
  getTranscript,
  searchChats,
} from '$lib/server/chat-audit.service';

// `q` is the search, `chat` is the opened transcript — both in the URL so a moderator can link a
// colleague straight to a conversation, and so back/forward works through an investigation.
const querySchema = z.object({
  q: z.string().trim().catch(''),
  chat: z.coerce.number().int().positive().optional().catch(undefined),
});

// READ-ONLY. Retool's version could ban from the transcript (BANAPI) and write a note (SetNote); both
// are deliberately not ported. Every username here links to User Lookup, which owns enforcement with
// the surrounding context, the confirmation step and the audit trail — duplicating it on a second page
// would mean two gates and two places to get a ban wrong.
export const load: PageServerLoad = async ({ url }) => {
  const { q, chat } = parseQuery(url, querySchema);

  const [search, transcript, members, reports] = await Promise.all([
    searchChats(q),
    chat ? getTranscript(chat) : null,
    chat ? getChatMembers(chat) : null,
    getChatReports(),
  ]);

  return { q, chatId: chat ?? null, search, transcript, members, reports };
};
