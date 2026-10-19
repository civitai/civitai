import { urlWith } from '$lib/url';

type ChipTarget = { key: string; defaultValue: string; active: string; toggle?: boolean };

/** An active toggle chip switches itself off by returning to the default. Every filter change drops
 *  the page and the open item, which index the old result set. */
export function chipHref(
  url: URL,
  group: ChipTarget,
  value: string,
  selectionParam: string
): string {
  const next = group.toggle && group.active === value ? group.defaultValue : value;
  return urlWith(url, {
    [group.key]: next === group.defaultValue ? null : next,
    page: null,
    [selectionParam]: null,
  });
}

type SplittableGroup<G> = G & ChipTarget & { values: readonly string[]; more?: readonly string[] };

/**
 * One filter row: every chip in group order, except a group's `more` values, which wait behind a
 * "More" menu unless one is the filter in force (then it shows on the row, so the row never hides
 * what is filtering the list). A toggle group has no default chip.
 */
export function splitChips<G>(groups: readonly SplittableGroup<G>[]) {
  type Chip = { group: SplittableGroup<G>; value: string };
  const row: Chip[] = [];
  const more: Chip[] = [];
  for (const group of groups)
    for (const value of group.values) {
      if (group.toggle && value === group.defaultValue) continue;
      const overflow = group.more?.includes(value) && group.active !== value;
      (overflow ? more : row).push({ group, value });
    }
  return { row, more };
}

const DROPPED_ON_SEARCH = ['q', 'page', 'item', 'appeal', 'model'];

/** Params a search form carries over: the tab's filters and sort, not the search or the old result set. */
export function carriedSearchParams(params: URLSearchParams): [string, string][] {
  return [...params.entries()].filter(([name]) => !DROPPED_ON_SEARCH.includes(name));
}
