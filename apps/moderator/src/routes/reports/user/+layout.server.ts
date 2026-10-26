import type { LayoutServerLoad } from './$types';
import { canAccess, canInvestigate } from '$lib/server/access';
import { usersByIds } from '$lib/server/users.service';
import { ReportEntity } from '$lib/reports';
import { loadReportQueue } from '$lib/server/report-queue-load';

// The QUEUE, as a layout, so it keeps its data while the moderator moves between accounts and tabs —
// those are the child route's path (`[userId]/[[tab]]`) and its image params, none of which this reads.
// As one page load, every tab click reran the 50-row queue and its status counts, and the queue's
// image counts blinked out and back.
//
// 🔴 The URL only through `loadReportQueue`, which reads it key by key. Iterating the query string or
// reading `url.pathname`/`params` here makes it rerun on every click again, and nothing would look
// broken except the speed.
export const load: LayoutServerLoad = async ({ url, locals }) => {
  const queue = await loadReportQueue(ReportEntity.User, url, {
    statusCounts: true,
    canonicalize: false,
    dates: true,
    limit: 50,
  });

  // The report row carries the suspect's id but not their state; hydrate through the shared helper
  // rather than joining User again — four hand-rolled copies of that join had already drifted.
  const suspects = await usersByIds(queue.items.map((r) => r.entityId ?? 0));

  // Reaching the queue is an investigation permission; acting on a report or an account is not.
  const canAct = canAccess(locals.user, '/users');

  return {
    ...queue,
    items: queue.items.map((r) => ({ ...r, suspect: suspects.get(r.entityId ?? 0) ?? null })),
    canAct,
    // Banning is its own grant on top of `/users`, as it is in User Lookup.
    canBan: canAct && !!locals.grants['user.ban'],
    canInvestigate: canInvestigate(locals),
    // The queue and the selected suspect sit side by side, which needs the full content width.
    // Not `wide`: this page owns its own height so the queue column can be sized against the
    // viewport. Under `wide` the column started 136px down the page and a `100vh` height then
    // hung 104px below the fold, taking the pager with it — CSS cannot read its own offset, so
    // the header has to be a sibling of the panes rather than something above them.
    fullBleed: true,
    headerInline: true,
  };
};
