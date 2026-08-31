import type { LayoutServerLoad } from './$types';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

// Month + comparison month are shared across every analytics tab, stored in a host-only cookie (not the URL) so the
// choice persists across tabs/sessions; each tab's own load re-reads it, and `compare` feeds the RangeSelector.
export const load: LayoutServerLoad = ({ cookies }) => {
  const { range, compare } = readAnalyticsPeriod(cookies);
  // `through` = last elapsed day of the selected month; the charts draw the full month but stop each line where its
  // data actually ends (the current line at today, the comparison line at its own shorter month).
  const todayIso = new Date().toISOString().slice(0, 10);
  const through = range.to < todayIso ? range.to : todayIso;
  return {
    range,
    through,
    compare: {
      key: compare.key,
      label: compare.label,
      from: compare.range.from,
      to: compare.range.to,
    },
  };
};
