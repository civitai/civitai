import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSidebarLastActioned } from '$lib/server/sidebar-counts.service';
import { bounded } from '$lib/server/bounded';
import { logToAxiom } from '$lib/server/axiom';

// Same access as /api/sidebar-counts. A timeout or failure is a 503, never `{}`: an empty map reads as
// "nobody has worked any queue this week" and paints every waiting queue red.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json(null, { status: 401 });
  const lastActioned = await bounded(getSidebarLastActioned, 3_000, (error) => {
    void logToAxiom({
      name: 'sidebar-last-actioned',
      type: 'error',
      message: 'last-actioned lookup failed',
      details: { error: error instanceof Error ? error.message : String(error) },
    });
  });
  if (!lastActioned) return json(null, { status: 503 });
  return json(lastActioned);
};
