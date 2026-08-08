import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { MAX_INT4 } from '$lib/server/users.service';
import { DEFAULT_REPORT_STATUSES, ReportEntity, reportReasons } from '$lib/reports';
import { getReports } from '$lib/server/reports.service';
import {
  chatExists,
  classifySearch,
  getChatMembers,
  getUserMessages,
  getTranscript,
  searchChats,
} from '$lib/server/chat-audit.service';
import { TABS } from '../tabs';

// `q` is the search, `chat` is the opened transcript, `rpage` pages the report queue — all in the URL
// so a moderator can link a colleague straight to a conversation, and so back/forward works through an
// investigation. The tab is the route.
//
// `chat` is bounded to int4: Chat.id is a Postgres integer, and a larger value ERRORS the comparison
// rather than missing, which took the whole page down with a 500.
const REPORTS_PER_PAGE = 20;

// Retool's ChatReport carried `reason != 'Automated'`: system-generated reports drown the human queue.
// Without the statuses filter this queue counted every chat report in history while the panel called
// them open.
const QUEUE_REASONS = reportReasons.filter((r) => r !== 'Automated');

const querySchema = z.object({
  q: z.string().trim().catch(''),
  chat: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  rpage: z.coerce.number().int().positive().max(10_000).catch(1),
});

// READ-ONLY. Retool's version could ban from the transcript (BANAPI) and write a note (SetNote); both
// are deliberately not ported. Every username here links to User Lookup, which owns enforcement with
// the surrounding context, the confirmation step and the audit trail — duplicating it on a second page
// would mean two gates and two places to get a ban wrong.
export const load: PageServerLoad = async ({ url, params }) => {
  const tab = params.tab;
  if (!(TABS as readonly string[]).includes(tab)) error(404, 'Unknown tab');

  const { q, chat, rpage } = parseQuery(url, querySchema);

  if (tab === 'reports') {
    // The report queue comes from the shared report service rather than a hand-written
    // ChatReport/Report join. That also means this page and /reports agree on what "open" means — they
    // previously disagreed, so a report actioned on /reports stayed in this queue forever.
    const reports = await getReports({
      type: ReportEntity.Chat,
      statuses: DEFAULT_REPORT_STATUSES,
      reasons: QUEUE_REASONS,
      page: rpage,
      limit: REPORTS_PER_PAGE,
    });
    return {
      tab,
      chatId: chat ?? null,
      reports: reports.items,
      reportsTotal: reports.totalItems,
      reportsPage: reports.page,
      reportsPerPage: reports.limit,
    };
  }

  // Stats and Newest are one client-fetched endpoint; nothing to load here.
  if (tab !== 'chats') return { tab, chatId: chat ?? null };

  const [search, exists, transcript, members, userMessages] = await Promise.all([
    searchChats(q),
    chat ? chatExists(chat) : false,
    chat ? getTranscript(chat) : null,
    chat ? getChatMembers(chat) : null,
    // Retool's UserDetails: what the account actually SAID, across every chat. The chat list answers
    // who they talked to; this answers what they said, which is the question when the term was a name.
    // `getUserMessages` returns null for a non-existent username, which is the same fall-through
    // `searchChats` applies — so a spam term that looks like a username still lands on content search.
    q && classifySearch(q.trim()) !== 'chat' ? getUserMessages(q.trim()) : null,
  ]);

  return {
    tab,
    chatId: chat ?? null,
    chatMissing: !!chat && !exists,
    search,
    transcript,
    members,
    userMessages,
  };
};
