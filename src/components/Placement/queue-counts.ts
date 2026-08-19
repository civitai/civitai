/**
 * How many of your own submissions are still outstanding.
 *
 * Its own module for the reason `free-filter` is: this feeds a badge on a
 * settings card, and the rule worth testing is the filter rather than the
 * count. An approved placement is live rather than outstanding, so counting it
 * gives a creator a number that only ever grows with nothing behind it to do —
 * and the badge would keep asking them to go and look.
 */
export function pendingCount(rows: { status: string }[]) {
  return rows.filter((row) => row.status === 'pending').length;
}
