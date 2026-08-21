import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { DEFAULT_REPORT_REASONS, reportStatuses } from '$lib/reports';
import {
  getReportsOnUser,
  getReportsReceived,
  getReportsSubmitted,
} from '$lib/server/user-reports.service';

// Client-fetched: thirty-odd joins across eleven entity types. `only` skips the two lists a caller
// didn't ask for; `human` drops `Automated`, ~99.9% of the corpus on a flagged account.
export const GET: RequestHandler = async ({ params, url, locals }) => {
  // The report queues render the same account panel as User Lookup, and gating on one page silently
  // refuses the other two their holders.
  const userId = requireUserIdParam(locals, params, [
    '/retool/user-lookup',
    '/retool/user-reports',
    '/retool/post-reports',
  ]);

  const statuses = (url.searchParams.get('status') ?? '')
    .split(',')
    .filter((s) => (reportStatuses as string[]).includes(s));
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 200);
  const options = {
    statuses: statuses.length ? statuses : undefined,
    reasons: url.searchParams.get('human') ? DEFAULT_REPORT_REASONS : undefined,
    limit,
  };

  const only = new Set((url.searchParams.get('only') ?? '').split(',').filter(Boolean));
  const wants = (key: string) => only.size === 0 || only.has(key);

  const [received, submitted, onUser] = await Promise.all([
    wants('received') ? getReportsReceived(userId, options) : null,
    wants('submitted') ? getReportsSubmitted(userId, options) : null,
    // Without an explicit filter this one stays on its open-reports default; with one, it answers the
    // same question as the other two.
    // Its default is the OPEN reports, which the other two do not have — so an absent `status` keeps
    // that default while still honouring `human` and `limit`. Spreading `options` wholesale would
    // silently widen it to every status; dropping it silently ignored both flags.
    wants('onUser')
      ? getReportsOnUser(userId, statuses.length ? options : { ...options, statuses: undefined })
      : null,
  ]);

  // Omitted, never an empty array: a caller must not read "no reports" out of a list nobody ran.
  return json({
    ...(received && { received }),
    ...(submitted && { submitted }),
    ...(onUser && { onUser }),
  });
};
