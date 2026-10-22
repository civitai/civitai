import { urlWith } from '$lib/url';

type ChipTarget = {
  key: string;
  defaultValue: string;
  active: string;
  toggle?: boolean;
  /** Params that only make sense for the old value (a sort that follows the status), cleared with it. */
  resets?: readonly string[];
};

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
    ...Object.fromEntries((group.resets ?? []).map((key) => [key, null])),
    [group.key]: next === group.defaultValue ? null : next,
    page: null,
    [selectionParam]: null,
  });
}

type ChipRowGroup<G> = G & ChipTarget & { values: readonly string[] };

/** One filter row: every chip in group order. A toggle group has no default chip. */
export function rowChips<G>(groups: readonly ChipRowGroup<G>[]) {
  const row: { group: ChipRowGroup<G>; value: string }[] = [];
  for (const group of groups)
    for (const value of group.values) {
      if (group.toggle && value === group.defaultValue) continue;
      row.push({ group, value });
    }
  return row;
}

const DROPPED_ON_SEARCH = ['q', 'page', 'item', 'hold', 'appeal', 'model', 'selected'];

/** Params a search form carries over: the tab's filters and sort, not the search or the old result set. */
export function carriedSearchParams(params: URLSearchParams): [string, string][] {
  return [...params.entries()].filter(([name]) => !DROPPED_ON_SEARCH.includes(name));
}
