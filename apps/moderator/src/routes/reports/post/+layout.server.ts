import type { LayoutServerLoad } from './$types';
import { postsByIds } from '$lib/server/image-lookup.service';
import { loadReportQueue } from '$lib/server/report-queue-load';
import { ReportEntity } from '$lib/reports';

// The QUEUE, as a layout, so it keeps its data while the moderator moves between posts — the post is
// the child route's path (`[postId]`), which this never reads.
//
// 🔴 The URL only through `loadReportQueue`, which reads it key by key. Iterating the query string or
// reading `url.pathname`/`params` here makes it rerun on every click again, and nothing would look
// broken except the speed. See `docs/moderator-app/report-queue-pattern.md`.
export const load: LayoutServerLoad = async ({ url }) => {
  const queue = await loadReportQueue(ReportEntity.Post, url, {
    statusCounts: true,
    canonicalize: false,
    dates: true,
    limit: 50,
  });

  // The report row carries a post id and nothing else: the owner and how much of the post is already
  // gone come from the post.
  const posts = await postsByIds(queue.items.map((r) => r.entityId ?? 0));

  return {
    ...queue,
    items: queue.items.map((r) => ({ ...r, post: posts.get(r.entityId ?? 0) ?? null })),
    fullBleed: true,
    headerInline: true,
  };
};
