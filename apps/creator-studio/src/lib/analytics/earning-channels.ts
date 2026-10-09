// The six ways a model earns, as separate columns on /analytics/models and the per-model page. `licenseFee`,
// `compensation` and `tip` come from resourceCompensations; the other three are buyer-funded and only exist in
// buzzTransactions. Client-safe so the server read and both pages share one list.
export const PERFORMANCE_CHANNELS = [
  'licenseFee',
  'compensation',
  'tip',
  'earlyAccess',
  'permanentAccess',
  'donation',
] as const;
export type PerformanceChannel = (typeof PERFORMANCE_CHANNELS)[number];

// Short headers: eight columns at full width push the last one past the container's right edge and behind the
// horizontal scroll, where it reads as missing. `tip` says "Generation" because the /earnings Tips card means
// user-to-user tips, a different thing.
export const CHANNEL_HEAD: Record<PerformanceChannel, string> = {
  licenseFee: 'License Fees',
  compensation: 'Compensation',
  tip: 'Generation Tips',
  earlyAccess: 'Early Access',
  permanentAccess: 'Perm. Access',
  donation: 'Donations',
};

// Namespaced so a channel key can never collide with `generations` / `downloads` in a table's sort key.
export const CHANNEL_SORT_PREFIX = 'channel:';

type TipRow = { channels: { tip: { received: { total: number }[] } } };

// The Generation Tips column appears only when a row earned tips in the range, as the main app's creator
// dashboard shows its Tips tab: most creators have none, and an always-empty column pushes the table past its
// container. It stays while the table is sorted by it, so a stored sort never points at a missing column.
export function shownChannels(rows: TipRow[], sortKey: string): PerformanceChannel[] {
  const hasTips =
    sortKey === CHANNEL_SORT_PREFIX + 'tip' ||
    rows.some((r) => r.channels.tip.received.some((x) => x.total > 0));
  return PERFORMANCE_CHANNELS.filter((c) => c !== 'tip' || hasTips);
}
