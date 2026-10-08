/**
 * Escape a value for a single-quoted ClickHouse string literal. `clickhouse.$query` interpolates
 * values raw, without quoting or escaping them.
 */
export function escapeClickhouseString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
