import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { parseQuery } from '$lib/server/query';
import { getMostReportedPage } from '$lib/server/reports.service';
import { MOST_REPORTED_PAGE_SIZE } from '$lib/reports';

const querySchema = z.object({ page: z.coerce.number().int().min(1).max(1000).catch(1) });

// Client-fetched like the sidebar counts: the query joins six report tables, so it must not sit in the
// dashboard's render path. `/api/*` is exempt from the global route gate, so this checks report access
// itself rather than trusting the guard's authentication alone.
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user || !canAccess(locals.user, '/reports'))
    return json({ items: [], totalItems: 0, urgent: 0, page: 1, limit: MOST_REPORTED_PAGE_SIZE });

  const { page } = parseQuery(url, querySchema);
  return json(await getMostReportedPage({ page, limit: MOST_REPORTED_PAGE_SIZE }));
};
