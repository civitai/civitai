/**
 * `YYYY-MM-DD HH:MM:SS.mmm` (UTC) — the input form a `DateTime64(3)` column accepts in a
 * JSONEachRow insert.
 *
 * A raw `toISOString()` (`T` separator, `Z` suffix) is rejected at parse time, and because the
 * shared client inserts with `wait_for_async_insert: 0` that rejection never reaches the caller:
 * the insert "succeeds" and the table stays empty. That silence is why there is one spelling of
 * this, not one per writer.
 */
export function formatClickhouseDateTime64(at: number | Date) {
  return new Date(at).toISOString().slice(0, 23).replace('T', ' ');
}
