import type { CookieSlot } from './cookies';

export type SlotCounts = Record<CookieSlot, number>;

/**
 * Counts session reads by cookie slot and hands the counts to `flush` on the first read after each
 * `intervalMs`, so a busy app writes one line per interval rather than one per request. Counts gathered after
 * the last flush are not written until the next read past the interval.
 */
export function createSlotTally(
  flush: (counts: SlotCounts) => void,
  { intervalMs = 60_000, now = Date.now }: { intervalMs?: number; now?: () => number } = {}
): (slot: CookieSlot) => void {
  let counts: SlotCounts = { host: 0, shared: 0 };
  let since = now();
  return (slot) => {
    counts[slot]++;
    const t = now();
    if (t - since < intervalMs) return;
    const out = counts;
    counts = { host: 0, shared: 0 };
    since = t;
    flush(out);
  };
}
