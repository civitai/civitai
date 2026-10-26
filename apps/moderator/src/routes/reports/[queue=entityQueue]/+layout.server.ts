import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { queueSubjects } from '$lib/server/entity-queue-load';
import { loadReportQueue } from '$lib/server/report-queue-load';
import { ENTITY_QUEUE_LABELS, entityQueueForSlug } from '$lib/entity-report-queues';

// The QUEUE, as a layout, so it keeps its data while the moderator moves between items — the item is
// the child route's path (`[id]`), which this never reads.
//
// 🔴 The URL only through `loadReportQueue`, which reads it key by key, and `params.queue` — tracked
// per param, and the same for every item in a queue. Iterating the query string or reading
// `url.pathname` or `params.id` here makes it rerun on every click again, and nothing would look broken
// except the speed. See `docs/moderator-app/report-queue-pattern.md`.
export const load: LayoutServerLoad = async ({ url, params }) => {
  // The matcher has already refused any other slug; this only narrows the type.
  const type = entityQueueForSlug(params.queue);
  if (!type) error(404, 'Unknown report type');

  const queue = await loadReportQueue(type, url, {
    statusCounts: true,
    canonicalize: false,
    dates: true,
    limit: 50,
  });
  // The report row carries an id and nothing else: what it is and whose come from the thing itself.
  const subjects = await queueSubjects(type, queue.items);

  return {
    ...queue,
    queueType: type,
    labels: ENTITY_QUEUE_LABELS[type],
    items: queue.items.map((r) => ({ ...r, subject: subjects.get(r.id) ?? null })),
    fullBleed: true,
    headerInline: true,
  };
};
