import { backend, browser } from '$lib/host';

// The live header balance. Module-scope `$state`, but only ever WRITTEN in the browser (seed/refresh guard
// on `browser`), so it never holds one user's balance during another user's SSR render — the same
// invariant that keeps `buzz-mode.svelte.ts` safe. On the server it stays null and the header renders from
// the load-provided prop instead.
export type Balances = { yellow: number; green: number; blue: number };

let balances = $state<Balances | null>(null);

export const buzzBalance = {
  get value(): Balances | null {
    return balances;
  },
  /** Seed once from the server load; later updates (from `buzz:update`) are authoritative, so a client-side
   *  navigation's re-seed must not clobber a fresher value. */
  seed(next: Balances | null) {
    if (browser && balances === null) balances = next;
  },
  /** Re-read the authoritative balance after a `buzz:update` signal. */
  async refresh() {
    if (!browser) return;
    try {
      // A null is a buzz-service blip (getSpendableBuzz fails open), not a real zero — keep the
      // last known value rather than blanking the header.
      const next = await backend().getBuzz();
      if (next) balances = next;
    } catch {
      // Keep the last known value — the header just doesn't update this tick.
    }
  },
};

/** How much of `price` would come out of the chosen yellow/green account, Blue spending first.
 *  Null = nothing beyond Blue. `uncertain` = the balance couldn't be read — fail SAFE and assume
 *  the whole price may be non-Blue rather than reverting to silent spending. One definition for
 *  every spend site, because two hand-written copies of a money answer is how they diverge.
 *  `blueUsable: false` = Blue can't pay for this run at all (a mature dataset for a non-member):
 *  the orchestrator takes Blue, refunds it seconds later, and charges the full price in YELLOW —
 *  whatever the chosen mode (a Green-mode run was observed charged Yellow). */
export function nonBlueSpend(
  price: number | null | undefined,
  mode: 'yellow' | 'green',
  blueUsable = true
): { amount: number; currency: 'yellow' | 'green'; uncertain: boolean } | null {
  if (price == null || price <= 0) return null;
  if (!blueUsable) return { amount: price, currency: 'yellow', uncertain: false };
  const blue = balances?.blue;
  if (typeof blue !== 'number') return { amount: price, currency: mode, uncertain: true };
  if (price <= blue) return null;
  return { amount: price - Math.max(0, blue), currency: mode, uncertain: false };
}

// The main app's `isMature` (src/shared/constants/orchestrator.constants.ts) — the ratings Blue can't
// pay for without a membership.
const MATURE_NSFW_LEVELS = new Set(['r', 'x', 'xxx']);

export function isMatureNsfwLevel(level: string | null | undefined): boolean {
  return !!level && MATURE_NSFW_LEVELS.has(level);
}
