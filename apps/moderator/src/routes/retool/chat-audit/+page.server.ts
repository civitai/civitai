import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { MAX_INT4 } from '$lib/server/users.service';
import { ReportEntity } from '$lib/reports';
import { getReports } from '$lib/server/reports.service';
import {
  chatExists,
  classifySearch,
  getChatMembers,
  getUserMessages,
  getTranscript,
  searchChats,
} from '$lib/server/chat-audit.service';
import { TABS } from './tabs';

// `q` is the search, `chat` is the opened transcript, `rpage` pages the report queue — all in the URL so
// a moderator can link a colleague straight to a conversation, and so back/forward works through an
// investigation.
//
// `chat` is bounded to int4: Chat.id is a Postgres integer, and a larger value ERRORS the comparison
// rather than missing, which took the whole page down with a 500.
const REPORTS_PER_PAGE = 20;

const querySchema = z.object({
  q: z.string().trim().catch(''),
  chat: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  rpage: z.coerce.number().int().positive().max(10_000).catch(1),
  tab: z.enum(TABS).optional().catch(undefined),
});

// READ-ONLY. Retool's version could ban from the transcript (BANAPI) and write a note (SetNote); both
// are deliberately not ported. Every username here links to User Lookup, which owns enforcement with
// the surrounding context, the confirmation step and the audit trail — duplicating it on a second page
// would mean two gates and two places to get a ban wrong.
export const load: PageServerLoad = async ({ url }) => {
  const { q, chat, rpage, tab } = parseQuery(url, querySchema);

  // The report queue is the entry point when a moderator arrives without a subject; once they are
  // investigating something specific, Chats is where they are working.
  const active = tab ?? (q || chat ? 'chats' : 'reports');
  const onChats = active === 'chats';

  const [search, exists, transcript, members, reports, userMessages] = await Promise.all([
    onChats ? searchChats(q) : null,
    onChats && chat ? chatExists(chat) : false,
    onChats && chat ? getTranscript(chat) : null,
    onChats && chat ? getChatMembers(chat) : null,
    // The report queue comes from the shared report service rather than a third hand-written
    // ChatReport/Report join. That also means this page and /reports agree on what "open" means — they
    // previously disagreed, so a report actioned on /reports stayed in this queue forever.
    active === 'reports'
      ? getReports({ type: ReportEntity.Chat, page: rpage, limit: REPORTS_PER_PAGE })
      : null,
    // Retool's UserDetails: what the account actually SAID, across every chat. The chat list answers
    // who they talked to; this answers what they said, which is the question when the term was a name.
    onChats && q && classifySearch(q.trim()) === 'user' ? getUserMessages(q.trim()) : null,
  ]);

  return {
    q,
    tab: active,
    chatId: chat ?? null,
    chatMissing: onChats && !!chat && !exists,
    search,
    transcript,
    members,
    reports: reports?.items ?? [],
    reportsTotal: reports?.totalItems ?? 0,
    reportsPage: reports?.page ?? rpage,
    reportsPerPage: reports?.limit ?? REPORTS_PER_PAGE,
    userMessages,
  };
};
