import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import {
  getCommentBurst,
  getSharedIpAccounts,
  getSharedSocialAccounts,
  getSocials,
  getUserIps,
} from '$lib/server/user-lookup.service';

// Split out of the page load because these are the slow half of a lookup — ~250ms for the IP roll-up and
// ~750ms for the shared-IP scan, against a 31M-row ClickHouse table. Identity should render immediately
// and the investigation data arrive after.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  // Independent now — the shared-IP scan selects its own identifying addresses rather than filtering
  // the recency-capped list, so all three can run together.
  const [ips, commentBurst, shared, socials, sharedSocials] = await Promise.all([
    getUserIps(userId),
    getCommentBurst(userId),
    getSharedIpAccounts(userId),
    getSocials(userId),
    getSharedSocialAccounts(userId),
  ]);

  // Nested per signal rather than flattened: a third shared-signal would otherwise add a third pair of
  // ad-hoc sibling names (`sharedAccounts`/`truncated`, `sharedSocials`/`socialsTruncated`, …).
  return json({
    commentBurst,
    ips: { addresses: ips, accounts: shared.accounts, truncated: shared.truncated },
    socials: {
      links: socials,
      accounts: sharedSocials.accounts,
      truncated: sharedSocials.truncated,
    },
  });
};
