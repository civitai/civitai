import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSidebarCounts } from '$lib/server/sidebar-counts.service';
import { countAwaitingReply } from '$lib/server/message-as-civitai-count';
import { bounded } from '$lib/server/bounded';

// Client-fetched sidebar counts (see $lib/sidebar-counts.svelte). hooks.server.ts has already established
// `locals.user` as an authenticated moderator, so any tier may read these shared aggregates; the per-tier
// nav pruning happens client-side (a badge only shows for a nav item the user can see).
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json({});
  // Civitai Messages is read fresh, outside the shared fill: a moderator who just replied should see the
  // badge clear, and inside the fill it waited behind every slower count and timed out.
  const [{ counts, unavailable }, civitaiMessages] = await Promise.all([
    getSidebarCounts(),
    bounded(countAwaitingReply, 1_000),
  ]);
  // Flat, with `unavailable` beside the counts: a tab opened before a deploy still reads its numbers.
  return json({
    ...counts,
    ...(civitaiMessages === null ? {} : { civitaiMessages }),
    unavailable: civitaiMessages === null ? [...unavailable, 'civitaiMessages'] : unavailable,
  });
};
