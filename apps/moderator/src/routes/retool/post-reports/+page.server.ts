import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseQuery } from '$lib/server/query';
import { MAX_INT4 } from '$lib/server/users.service';
import { DEFAULT_REPORT_REASONS, ReportEntity } from '$lib/reports';
import { getReportHistory, getReports } from '$lib/server/reports.service';
import { getPostLookup, postsByIds } from '$lib/server/image-lookup.service';
import { reportModerationActions } from '$lib/server/report-actions';
import { parseReportQueueFilters, reportQueueFilterSchema } from '$lib/server/report-queue-filters';
import { loadAccountHistory } from '$lib/server/account-history';

// The User Reports queue, for posts. Same screen, same actions, one difference that decides the shape:
// a post report names CONTENT, not an account — so the drill-down is the post's images, and the account
// history beside them belongs to whoever owns the post, which the report row does not carry.

const querySchema = z
  .object({
    post: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
    page: z.coerce.number().int().positive().max(10_000).catch(1),
  })
  .extend(reportQueueFilterSchema.shape);

const PER_PAGE = 50;

export const load: PageServerLoad = async ({ url, locals }) => {
  const parsed = parseQuery(url, querySchema);
  const { post, page } = parsed;
  const filters = parseReportQueueFilters(url, parsed);
  // Reaching the queue is an investigation permission; acting on a report or an account is not.
  const canAct = canAccess(locals.user, '/users');

  const [reports, history, lookup] = await Promise.all([
    // `getReports`, the same query `/reports/post` runs — the badge is not the same query: it counts
    // Pending only, so it reads lower than this.
    getReports({
      type: ReportEntity.Post,
      page,
      limit: PER_PAGE,
      statuses: filters.statuses.length ? filters.statuses : 'all',
      reasons: DEFAULT_REPORT_REASONS,
      reportedBy: filters.reportedBy || undefined,
      from: filters.from,
      to: filters.to,
    }),
    getReportHistory(ReportEntity.Post),
    post ? getPostLookup(post) : null,
  ]);

  // The account behind the open post. Second round trip because the report row carries a post id and
  // nothing else — there is no owner to look up until the post has been read.
  const ownerId = lookup?.post.userId ?? null;
  const accountHistory = ownerId
    ? await loadAccountHistory(ownerId, locals.user.username ?? null)
    : null;

  const postIds = [
    ...reports.items.map((r) => r.entityId ?? 0),
    ...history.items.map((h) => h.entityId ?? 0),
  ];
  const posts = await postsByIds(postIds);

  return {
    queue: reports.items.map((r) => ({ ...r, post: posts.get(r.entityId ?? 0) ?? null })),
    queueTotal: reports.totalItems,
    page: reports.page,
    perPage: reports.limit,
    queueFilters: filters.echo,
    history: history.items.map((h) => ({ ...h, post: posts.get(h.entityId ?? 0) ?? null })),
    historyTruncated: history.truncated,
    postId: post ?? null,
    lookup,
    ownerId,
    accountHistory,
    canAct,
    // The queue and the open post sit side by side, which needs the full content width.
    wide: true,
  };
};

export const actions = reportModerationActions('/users');
