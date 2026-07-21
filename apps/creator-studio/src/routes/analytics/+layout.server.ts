import type { LayoutServerLoad } from './$types';
import { parseMonthRange, resolveCompareMonth } from '$lib/date-range';

// Month + comparison month are shared across every analytics tab (from/to/cmp in the URL); each tab's own load
// re-resolves them for its fetch, and `compare` here feeds the shared RangeSelector.
export const load: LayoutServerLoad = ({ url }) => {
  const range = parseMonthRange(url.searchParams.get('from'), url.searchParams.get('to'));
  const compare = resolveCompareMonth(url.searchParams.get('cmp'), range);
  // `through` = last elapsed day of the selected month; the charts draw the full month but stop each line where its
  // data actually ends (the current line at today, the comparison line at its own shorter month).
  const todayIso = new Date().toISOString().slice(0, 10);
  const through = range.to < todayIso ? range.to : todayIso;
  return {
    range,
    through,
    compare: { key: compare.key, label: compare.label, from: compare.range.from, to: compare.range.to },
  };
};
