import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { MAX_INT4, usersByIds } from '$lib/server/users.service';
import { getInflationActors, getSharedIps } from '$lib/server/reactor-lookup.service';
import type { InflationReport, SharedIpAccount } from '$lib/server/reactor-lookup.service';

// The whole view is in the URL so a moderator can hand a colleague the exact screen they are reading.
const querySchema = z.object({
  q: z.string().trim().catch(''),
  category: z.enum(['reactions', 'stickers', 'collections']).catch('reactions'),
  days: z.coerce.number().int().min(1).max(365).catch(3),
  // Below this, concentration is arithmetic on a sample too small to mean anything: an account that
  // reacted once, to this creator, scores 100%. See `getReactors`.
  minCount: z.coerce.number().int().min(1).max(10_000).catch(5),
  groupIpv4: z.enum(['0', '1']).catch('0'),
});

/** An address carrying more accounts than this is a VPN exit or a carrier NAT, not a household. A
 *  filter rather than a rule, because the number that separates the two moves — rows above it are
 *  collapsed, never dropped. */
const NOISY_IP_ACCOUNTS = 25;

export const load: PageServerLoad = async ({ url }) => {
  const { q, category, days, minCount, groupIpv4 } = parseQuery(url, querySchema);
  const view = { q, category, days, minCount, groupIpv4: groupIpv4 === '1' };

  // Rejected, not clamped: `Math.min(n, MAX_INT4)` silently searches a different account than the one
  // that was typed. `User.id` is int4, so anything larger errors the comparison rather than missing.
  const parsed = /^\d+$/.test(q) ? Number(q) : NaN;
  const ownerId = Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_INT4 ? parsed : null;

  const empty: InflationReport = { actors: [], total: 0, belowFloor: 0, capped: false };
  const blank = {
    ...view,
    ...empty,
    sharedIps: [] as SharedIpAccount[],
    sharesWithTarget: [] as number[],
    sharesWithOther: [] as number[],
    sourcesDown: [] as string[],
    noisyThreshold: NOISY_IP_ACCOUNTS,
    wide: true,
  };

  if (!ownerId) return { ...blank, badId: q !== '', unknownUser: false };

  // 🔴 An image id is also a bare integer, and Image Lookup is where a moderator arrives from. Without
  // this the page ran the queries against a user that does not exist and rendered its ordinary empty
  // layout — indistinguishable from a creator nobody is boosting. `usersByIds` keeps soft-deleted
  // accounts, so investigating a deleted creator still works; only an id with no row at all stops here.
  //
  // Caught, and a failure falls THROUGH rather than claiming the account is unknown: this page's whole
  // contract is that a source which cannot answer degrades and names itself. An uncaught reject here
  // would turn a replica blip into a 500 on a page designed to render partially, and `unknownUser` on
  // a failed lookup would assert something the database never said.
  const owner = await usersByIds([ownerId])
    .then((byId) => ({ resolved: true, user: byId.get(ownerId) }))
    .catch((e) => {
      console.error('[reactor-lookup] owner lookup unavailable', e);
      return { resolved: false, user: undefined };
    });
  if (owner.resolved && !owner.user) return { ...blank, badId: false, unknownUser: true };

  // ClickHouse backs the reactions tab and the whole IP panel; a rejection here would otherwise take
  // the page with it. Each source degrades to empty and names itself.
  const sourcesDown: string[] = [];
  const degrade = <T>(label: string, run: Promise<T>, fallback: T) =>
    run.catch((e) => {
      console.error(`[reactor-lookup] ${label} unavailable`, e);
      sourcesDown.push(label);
      return fallback;
    });

  const report = await degrade(
    category,
    getInflationActors(ownerId, { category, days, minCount }),
    empty
  );

  // Sequential, not parallel: the panel's input is the account list above. `days` is deliberately not
  // passed on — see `getSharedIps`.
  const sharedIps = await degrade(
    'shared IPs',
    getSharedIps(
      report.actors.map((a) => a.userId),
      { targetId: ownerId, groupIpv4: groupIpv4 === '1' }
    ),
    [] as SharedIpAccount[]
  );

  // The panel and the table are one finding, not two lists side by side: a moderator reading the
  // ranked rows has no way to tell which of them the panel also implicates. Only accounts with an
  // address narrow enough to identify anyone are marked — a VPN exit shared by 358 marks everybody.
  const identifying = sharedIps.filter((a) =>
    a.addresses.some((ip) => ip.totalAccounts !== null && ip.totalAccounts <= NOISY_IP_ACCOUNTS)
  );

  return {
    ...view,
    ...report,
    sharedIps,
    sharesWithTarget: identifying.filter((a) => a.withTarget).map((a) => a.userId),
    sharesWithOther: identifying.filter((a) => !a.withTarget).map((a) => a.userId),
    sourcesDown,
    noisyThreshold: NOISY_IP_ACCOUNTS,
    badId: false,
    unknownUser: false,
    wide: true,
  };
};
