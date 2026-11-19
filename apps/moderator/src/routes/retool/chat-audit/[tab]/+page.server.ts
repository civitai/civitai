import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQueryKeys } from '$lib/server/query';
import {
  DEFAULT_REPORT_REASONS,
  DEFAULT_REPORT_STATUSES,
  ReportEntity,
  ReportStatus,
  reportStatuses,
} from '$lib/reports';
import { getReports } from '$lib/server/reports.service';
import { searchChats } from '$lib/server/chat-audit.service';
import { TABS } from '../tabs';
import { readerOf } from '$lib/server/chat-read-audit';

const REPORTS_PER_PAGE = 20;

const searchQuery = z.object({
  q: z.string().trim().catch(''),
  spage: z.coerce.number().int().positive().max(10_000).catch(1),
});

const reportsQuery = z.object({
  rpage: z.coerce.number().int().positive().max(10_000).catch(1),
  // Retool's select1 filtered the report table by status. Hardcoding the open ones made every
  // Actioned/Unactioned chat report unreachable from this page.
  rstatus: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? (v.split(',').filter((x) => (reportStatuses as string[]).includes(x)) as ReportStatus[])
        : []
    ),
});

// `parseQueryKeys`, so opening a chat does not rerun the list: a message-text search takes seconds and
// logs a read of every chat it excerpts.
//
// READ-ONLY. Retool's version could ban from the transcript (BANAPI) and write a note (SetNote); both
// are deliberately not ported. Every username here links to User Lookup, which owns enforcement with
// the surrounding context, the confirmation step and the audit trail — duplicating it on a second page
// would mean two gates and two places to get a ban wrong.
export const load: PageServerLoad = async ({ url, params, locals }) => {
  const tab = params.tab;
  if (!(TABS as readonly string[]).includes(tab)) error(404, 'Unknown tab');

  if (tab === 'chats') {
    const { q, spage } = parseQueryKeys(url, searchQuery);
    return { tab, search: await searchChats(readerOf(locals.user), q, spage) };
  }

  if (tab === 'reports') {
    const { rpage, rstatus } = parseQueryKeys(url, reportsQuery);
    // The shared report service, so this page and /reports agree on what "open" means.
    const reports = await getReports({
      type: ReportEntity.Chat,
      statuses: rstatus.length ? rstatus : DEFAULT_REPORT_STATUSES,
      reasons: DEFAULT_REPORT_REASONS,
      page: rpage,
      limit: REPORTS_PER_PAGE,
    });
    return {
      tab,
      reports: reports.items,
      reportsTotal: reports.totalItems,
      reportsPage: reports.page,
      reportsPerPage: reports.limit,
      reportStatusFilter: rstatus,
    };
  }

  // Stats and Newest are one client-fetched endpoint; nothing to load here.
  return { tab };
};
