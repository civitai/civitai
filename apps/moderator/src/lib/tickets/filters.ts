import { urlWithMulti } from '$lib/url';
import { LIVE_STATUSES, statusLabel } from './statuses';
import type { TicketView } from './routing';
import { NONE, TICKET_QUERY_MULTI_KEYS, type TicketListQuery } from './view-query';

export const NO_VALUE_LABEL = 'None';

export type FilterOption = { value: string; label: string; count: number; active: boolean };

/** Every live status in status order. An empty one stays listed (dimmed by the control) so the set reads the same each time. */
export function statusOptions(
  selected: readonly number[],
  counts: Readonly<Record<string, number>>
): FilterOption[] {
  return LIVE_STATUSES.map((status) => ({
    value: String(status),
    label: statusLabel(status),
    count: counts[String(status)] ?? 0,
    active: selected.includes(status),
  }));
}

/**
 * Feature or topic values, most common first. A value the view holds none of is still listed (the
 * facets name every value the view has) and so is a selected one, so a filter that matches nothing can
 * be turned off. `NONE` is the bucket for tickets without one.
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
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export type FilterKey = 'status' | 'feature' | 'topic' | 'sent';

/**
 * The filter controls a view shows. Feature and router topic define the moderation queue, so they
 * would only repeat it there; their URL params still apply.
 */
export const visibleFilters = (view: TicketView): FilterKey[] =>
  view === 'support' ? ['status', 'feature', 'topic', 'sent'] : ['status'];

/** "Status", or "Status · 2" with two selected. */
export const triggerText = (label: string, selected: number): string =>
  selected > 0 ? `${label} · ${selected}` : label;

/** "Waiting on Mod Lead 131". */
export const optionText = (o: { label: string; count: number }): string => `${o.label} ${o.count}`;

export type SentOption = { value: '' | 'only' | 'exclude'; label: string; count: number };

/** The sent-to-support choices; "All" is the sum, since the two halves partition the view. */
export function sentOptions(counts: { only: number; exclude: number }): SentOption[] {
  return [
    { value: '', label: 'All', count: counts.only + counts.exclude },
    { value: 'only', label: 'Sent by moderators', count: counts.only },
    { value: 'exclude', label: 'Not sent', count: counts.exclude },
  ];
}

type SortKey = TicketListQuery['sort'];
type SortDir = TicketListQuery['dir'];

export const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'updated:desc', label: 'Updated newest' },
  { value: 'updated:asc', label: 'Updated oldest' },
  { value: 'created:desc', label: 'Created newest' },
  { value: 'created:asc', label: 'Created oldest' },
];

export const sortValue = (sort: SortKey, dir: SortDir): string => `${sort}:${dir}`;

export function parseSortValue(value: string): { sort: SortKey; dir: SortDir } {
  const known = SORT_OPTIONS.some((o) => o.value === value);
  const [sort, dir] = (known ? value : 'updated:desc').split(':');
  return { sort: sort as SortKey, dir: dir as SortDir };
}

/**
 * The URL with the repeated param `key` set to `values`. Every filter change drops the
 * `dropOnChange` params (the page and the open ticket), which index the result set being replaced.
 */
export function selectionHref(
  url: URL,
  key: string,
  values: string[],
  dropOnChange: readonly string[]
): string {
  const next = new URL(url);
  for (const param of dropOnChange) next.searchParams.delete(param);
  return urlWithMulti(next, key, values);
}

/** The URL without any filter, keeping the search and the sort. */
export function clearFiltersHref(url: URL, dropOnChange: readonly string[]): string {
  const next = new URL(url);
  for (const param of [...dropOnChange, ...TICKET_QUERY_MULTI_KEYS, 'sent'])
    next.searchParams.delete(param);
  return next.pathname + next.search;
}

/** "just now" / "4m ago" / "3h ago", for how fresh the snapshot is. */
export function syncedAgo(syncedAt: number, now: number): string {
  const minutes = Math.floor((now - syncedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
