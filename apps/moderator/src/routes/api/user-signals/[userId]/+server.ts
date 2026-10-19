import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import {
  getAccountEvents,
  getBlockedPrompts,
  getCommentBurst,
  getRecentGenerations,
  getSharedSocialAccounts,
  getSocials,
  getUserIps,
  softly,
} from '$lib/server/user-signals.service';

// Split out of the page load because these are the slow half of a lookup, against a ClickHouse table of
// tens of millions of rows. Identity should render immediately and the investigation data arrive after.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const [ips, commentBurst, socials, sharedSocials, prompts, generations, events] =
    await Promise.all([
      // The ClickHouse-backed reads degrade individually. Without this a ClickHouse outage rejected the
      // whole payload and blanked the Postgres-only halves of this section too — including the social
      // links list and its remove action.
      softly('ips', () => getUserIps(userId), []),
      softly('commentBurst', () => getCommentBurst(userId), null),
      getSocials(userId),
      getSharedSocialAccounts(userId),
      softly('blockedPrompts', () => getBlockedPrompts(userId), { prompts: [], total: 0 }),
      softly('recentGenerations', () => getRecentGenerations(userId), 0),
      softly('accountEvents', () => getAccountEvents(userId), []),
    ]);

  // Nested per signal rather than flattened: a third shared-signal would otherwise add a third pair of
  // ad-hoc sibling names (sharedAccounts/truncated, sharedSocials/socialsTruncated, …).
  return json({
    commentBurst,
    ips: { addresses: ips },
    socials: {
      links: socials,
      accounts: sharedSocials.accounts,
      truncated: sharedSocials.truncated,
    },
    generation: { blocked: prompts.prompts, blockedTotal: prompts.total, last24h: generations },
    events,
  });
};
