import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { archiveState } from '$lib/csam-archive';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getArchiveJobs } from '$lib/server/csam-archive.service';
import { getCsamReports } from '$lib/server/user-account.service';

// Client-fetched so the header chip costs nothing on accounts that have no CSAM report — which is
// almost all of them, and the chip already knows the count from the identity query.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  const [reports, jobs] = await Promise.all([getCsamReports(userId), getArchiveJobs([userId])]);
  const job = jobs.get(userId);
  return json(reports.map((r) => ({ ...r, archiveState: archiveState(r, job) })));
};
