import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { reportStatuses } from '$lib/reports';
import {
  getReportsOnUser,
  getReportsReceived,
  getReportsSubmitted,
} from '$lib/server/user-reports.service';

// Client-fetched: thirty-odd joins across eleven entity types, and only the Reports section shows them.
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const statuses = (url.searchParams.get('status') ?? '')
    .split(',')
    .filter((s) => (reportStatuses as string[]).includes(s));
  const options = { statuses: statuses.length ? statuses : undefined };

  const [received, submitted, onUser] = await Promise.all([
    getReportsReceived(userId, options),
    getReportsSubmitted(userId, options),
    // Without an explicit filter this one stays on its open-reports default; with one, it answers the
    // same question as the other two.
    getReportsOnUser(userId, statuses.length ? options : {}),
  ]);

  return json({ received, submitted, onUser });
};
