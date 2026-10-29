import { backend, browser } from '$lib/host';
import { matureSpend, type Spend } from '$lib/mature-charge';

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

/** `matureSpend` against the live Blue balance, for every spend site. `mature` = the dataset has
 *  mature images (then the non-Blue part is Yellow, never Green); `member` = a paid membership, which
 *  lets Blue pay for mature content. Unknown membership counts as not a member. */
export function nonBlueSpend(
  price: number | null | undefined,
  mode: 'yellow' | 'green',
  opts: { mature?: boolean; member?: boolean } = {}
): Spend | null {
  return matureSpend({
    price,
    blue: balances?.blue,
    mode,
    mature: opts.mature ?? false,
    member: opts.member ?? true,
  });
}

// The main app's `isMature` (src/shared/constants/orchestrator.constants.ts) — the ratings Blue can't
// pay for without a membership.
const MATURE_NSFW_LEVELS = new Set(['r', 'x', 'xxx']);

export function isMatureNsfwLevel(level: string | null | undefined): boolean {
  return !!level && MATURE_NSFW_LEVELS.has(level);
}

const NSFW_LEVEL_LABELS: Record<string, string> = {
  pg: 'PG',
  pg13: 'PG-13',
  r: 'R',
  x: 'X',
  xxx: 'XXX',
};

/** A scan rating as users see it on civitai.com; undefined when unrated (`na`) or unknown. */
export function nsfwLevelLabel(level: string | null | undefined): string | undefined {
  return level ? NSFW_LEVEL_LABELS[level] : undefined;
}
