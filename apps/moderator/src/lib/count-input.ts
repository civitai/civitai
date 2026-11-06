/**
 * A count a person typed, as they would write it: digits, optionally grouped with commas, spaces or
 * underscores. Anything else is null, never a guess: a dot may be a decimal point or a thousands
 * separator, and a count that confirms a bulk write must mean one thing.
 */
export function parseTypedCount(raw: string): number | null {
  const digits = raw.trim().replace(/[,\s_]/g, '');
  if (!/^\d{1,9}$/.test(digits)) return null;
  return Number(digits);
}
