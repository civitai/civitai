/**
 * Int64 columns are written and read as JSON, where a JS `number` holds only 53 bits —
 * a 64-bit value silently arrives rounded and nothing errors. Move these as decimal
 * strings: the server parses them exactly
 * (`input_format_json_read_numbers_as_strings`), and reads must ask for `toString(col)`
 * because the client sets `output_format_json_quote_64bit_integers: 0`.
 */
export function toClickhouseInt64(value: bigint | number | string): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return BigInt(value).toString();
  if (!Number.isInteger(value)) throw new Error(`Not an integer: ${value}`);
  if (!Number.isSafeInteger(value))
    throw new Error(`Value has already lost precision as a number: ${value}`);
  return value.toString();
}

export function fromClickhouseInt64(value: string | number | bigint): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error(`Value arrived as a rounded number; select toString(col) instead: ${value}`);
  return BigInt(value);
}
