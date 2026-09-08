import { browser } from '$app/environment';

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
      const res = await fetch('/api/buzz');
      if (!res.ok) return;
      // A 200-with-null is a buzz-service blip (getSpendableBuzz fails open), not a real zero — keep the
      // last known value rather than blanking the header.
      const next = (await res.json()) as Balances | null;
      if (next) balances = next;
    } catch {
      // Keep the last known value — the header just doesn't update this tick.
    }
  },
};
