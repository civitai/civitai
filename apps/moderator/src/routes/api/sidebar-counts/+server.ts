import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSidebarCounts } from '$lib/server/sidebar-counts.service';

// Client-fetched sidebar counts (see $lib/sidebar-counts.svelte). hooks.server.ts has already established
// `locals.user` as an authenticated moderator, so any tier may read these shared aggregates; the per-tier
// nav pruning happens client-side (a badge only shows for a nav item the user can see).
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json({});
  return json(await getSidebarCounts());
};
