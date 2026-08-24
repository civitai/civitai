import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam } from '$lib/server/api-guard';
import { getUserGeneratedWorkflows } from '$lib/server/user-workflows.service';

// The ONE page that mounts the panel. This read is wider than any page's own content — an account's
// full off-site generation history, prompts and signed media included, for work never published to the
// site — so the grant list names consumers that exist, not consumers that might. Add a path here when a
// page actually mounts the panel.
const PAGES = ['/audit/generator-restrictions'];

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireIdParam(locals, params.userId, PAGES, 'userId');
  const cursor = url.searchParams.get('cursor');
  // An absent `take` must stay absent, not become `Number(null)` === 0 — the service clamps to a
  // minimum of 1, so an omitted param would read as an account that generated almost nothing.
  const takeParam = url.searchParams.get('take');
  const take = takeParam === null ? undefined : Number(takeParam);

  try {
    return json(
      await getUserGeneratedWorkflows(userId, {
        take: take !== undefined && Number.isInteger(take) ? take : undefined,
        cursor,
      })
    );
  } catch (e) {
    // The panel reads `body.error` — an uncaught throw here returns an HTML error page, and the
    // fetch's `r.json()` fails on it before any message reaches the moderator.
    console.error('[user-workflows] query failed', e);
    return json({ error: 'Could not reach the orchestrator.' }, { status: 502 });
  }
};
