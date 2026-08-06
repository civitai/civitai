import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { getCommentBurst, getSharedIpAccounts, getUserIps } from '$lib/server/user-lookup.service';

// Split out of the page load because these are the slow half of a lookup — ~250ms for the IP roll-up and
// ~750ms for the shared-IP scan, against a 31M-row ClickHouse table. Identity should render immediately
// and the investigation data arrive after.
//
// `/api/*` is exempt from the global route gate, so this checks page access itself.
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user || !canAccess(locals.user, '/retool/user-lookup'))
    return json({ error: 'forbidden' }, { status: 403 });

  const userId = Number(params.userId);
  if (!Number.isInteger(userId) || userId <= 0)
    return json({ error: 'bad userId' }, { status: 400 });

  // Independent now — the shared-IP scan selects its own identifying addresses rather than filtering
  // the recency-capped list, so all three can run together.
  const [ips, commentBurst, shared] = await Promise.all([
    getUserIps(userId),
    getCommentBurst(userId),
    getSharedIpAccounts(userId),
  ]);

  return json({
    ips,
    sharedAccounts: shared.accounts,
    truncated: shared.truncated,
    commentBurst,
  });
};
