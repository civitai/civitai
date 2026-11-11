/** Moderators work in percentages; the stored value is a 0–1 rate. */
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;

/** Null for anything that is not a plain number from 0 to 100 with at most two decimals. */
export function percentToRate(text: string): number | null {
  const trimmed = text.trim();
  if (!PERCENT.test(trimmed)) return null;
  const percent = Number(trimmed);
  return percent > 100 ? null : Math.round(percent * 100) / 10_000;
}

export function rateToPercent(rate: number): string {
  return String(Math.round(rate * 10_000) / 100);
}
