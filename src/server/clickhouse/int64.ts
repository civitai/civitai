/**
 * Int64 columns are written and read as JSON, where a JS `number` holds only 53 bits —
 * a 64-bit value silently arrives rounded and nothing errors. Move these as decimal
 * strings: ClickHouse's JSON number parser accepts a quoted integer for a numeric column
 * and stores it exactly. Reads need the same care in reverse, because the client sets
 * `output_format_json_quote_64bit_integers: 0` — select `toString(col)` rather than the
 * bare column, or the value is rounded before any of this can help.
 */
export function toClickhouseInt64(value: bigint | string): string {
  return (typeof value === 'bigint' ? value : BigInt(value)).toString();
}
