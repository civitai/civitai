import { urlWithMulti } from '$lib/url';
import { LIVE_STATUSES, statusLabel } from './statuses';
import { NONE } from './view-query';

export const NO_VALUE_LABEL = 'None';

export type FilterOption = { value: string; label: string; count: number; active: boolean };

/** Live statuses in status order. Empty ones are hidden unless selected, so a stale link can still be undone. */
export function statusOptions(
  selected: readonly number[],
  counts: Readonly<Record<string, number>>
): FilterOption[] {
  return LIVE_STATUSES.map((status) => ({
    value: String(status),
    label: statusLabel(status),
    count: counts[String(status)] ?? 0,
    active: selected.includes(status),
  })).filter((o) => o.count > 0 || o.active);
}

/**
 * Feature or topic values, most common first. A value with no tickets is listed only while selected, so
 * a filter that matches nothing can still be turned off. `NONE` is the bucket for tickets without one.
 */
export function valueOptions(
  selected: readonly string[],
  counts: Readonly<Record<string, number>>,
  noneLabel = NO_VALUE_LABEL
): FilterOption[] {
  const values = new Set([...Object.keys(counts), ...selected]);
  return [...values]
    .map((value) => ({
      value,
      label: value === NONE ? noneLabel : value,
      count: counts[value] ?? 0,
      active: selected.includes(value),
    }))
    .filter((o) => o.count > 0 || o.active)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The URL with `value` toggled in the repeated param `key`. Every filter change drops `drop` (the page
 * and the open ticket), which index the result set being replaced.
 */
export function toggleHref(url: URL, key: string, value: string, drop: readonly string[]): string {
  const next = new URL(url);
  for (const param of drop) next.searchParams.delete(param);
  const current = next.searchParams.getAll(key);
  const values = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return urlWithMulti(next, key, values);
}

/** "just now" / "4m ago" / "3h ago", for how fresh the snapshot is. */
export function syncedAgo(syncedAt: number, now: number): string {
  const minutes = Math.floor((now - syncedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
