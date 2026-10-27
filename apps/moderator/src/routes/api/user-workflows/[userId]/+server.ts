import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { RESTRICTION_PAGES } from '$lib/restriction-types';
import { requireIdParam, requirePermission } from '$lib/server/api-guard';
import {
  ORCHESTRATOR_TIMEOUT_MS,
  getUserGeneratedWorkflows,
  isWorkflowSource,
} from '$lib/server/user-workflows.service';

// The pages that mount the panel. This read is wider than any page's own content — an account's full
// off-site generation history, prompts and signed media included, for work never published to the site
// — so the grant list names consumers that exist, not consumers that might. Add a path here when a page
// actually mounts the panel.
const PAGES = [...RESTRICTION_PAGES, '/retool/user-lookup'];

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireIdParam(locals, params.userId, PAGES, 'userId');
  requirePermission(locals, 'user.generations.view');
  const cursor = url.searchParams.get('cursor');
  // An absent `take` must stay absent, not become `Number(null)` === 0 — the service clamps to a
  // minimum of 1, so an omitted param would read as an account that generated almost nothing.
  const takeParam = url.searchParams.get('take');
  const take = takeParam === null ? undefined : Number(takeParam);
  // An unrecognised source falls back to the on-site feed rather than erroring: it is a tab name, and
  // the tab that exists is the honest answer to one that does not.
  const sourceParam = url.searchParams.get('source');
  const source = isWorkflowSource(sourceParam) ? sourceParam : undefined;

  try {
    return json(
      await getUserGeneratedWorkflows(userId, {
        take: take !== undefined && Number.isInteger(take) ? take : undefined,
        cursor,
        source,
      })
    );
  } catch (e) {
    console.error('[user-workflows] query failed', e);
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    // Never 502 or 504: Cloudflare replaces an origin 502/504 with its own HTML page, so the panel
    // would get `<!DOCTYPE` instead of this message.
    return json(
      {
        error: timedOut
          ? `The orchestrator did not answer within ${ORCHESTRATOR_TIMEOUT_MS / 1000} seconds.`
          : 'Could not reach the orchestrator.',
      },
      { status: 503 }
    );
  }
};
