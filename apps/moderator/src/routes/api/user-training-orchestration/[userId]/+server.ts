import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { utcMs } from '$lib/format';
import { getTrainingOrchestration } from '$lib/server/training-orchestration.service';

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  // The panel's paging cursor: the oldest charge on screen, in either shape `utcMs` accepts. An
  // unparseable value must become null rather than reach the service, where NaN drops the bound and
  // turns a paged lookup into a full-history scan. (`utcMs` is lenient about calendar overflow —
  // `2026-02-30` parses, as March 2 — so this rejects junk, not impossible dates.)
  const raw = url.searchParams.get('since');
  const since = raw && !Number.isNaN(utcMs(raw)) ? raw : null;
  return json(
    await getTrainingOrchestration(userId, url.searchParams.get('status') === '1', since)
  );
};
