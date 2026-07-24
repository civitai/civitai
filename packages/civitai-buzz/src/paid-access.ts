// One canonical answer to "is this version behind paid access, and in which mode?".
//
// Four fields encode this today — `earlyAccessEndsAt`, `earlyAccessPermanent`, and the `timeframe` / `permanent`
// keys inside `earlyAccessConfig`. Permanent access is the case that breaks every timed-window assumption: it has
// NO end date and `timeframe: 0`. Re-deriving the answer at each call site is what produced a run of "permanent
// versions are invisible / uneditable / silently wiped" bugs, so derive it here instead.
//
// `ModelVersion.earlyAccessPermanent` is the authoritative field: a DB trigger keeps it in sync with
// `earlyAccessConfig.permanent`, and it is what the download paywall reads. Pass the unsaved config flag only
// when reading a form value that hasn't been written yet.

export type PaidAccessMode = 'none' | 'timed' | 'permanent';

export type PaidAccessInput = {
  earlyAccessEndsAt?: Date | string | null;
  permanent?: boolean | null;
};

const toDate = (value: Date | string | null | undefined): Date | null =>
  value == null ? null : value instanceof Date ? value : new Date(value);

export function paidAccessMode(input: PaidAccessInput, now: Date = new Date()): PaidAccessMode {
  if (input.permanent) return 'permanent';
  const endsAt = toDate(input.earlyAccessEndsAt);
  return endsAt && endsAt > now ? 'timed' : 'none';
}

/** Currently gated behind payment — permanent, or a timed window that hasn't elapsed. */
export function isPaidAccessActive(input: PaidAccessInput, now?: Date): boolean {
  return paidAccessMode(input, now) !== 'none';
}

/**
 * A timed window has elapsed (or never started). Permanent access has no window, so it is never "over" — this is
 * the check that must not disable permanent controls after publishing.
 */
export function isTimedWindowOver(input: PaidAccessInput, now: Date = new Date()): boolean {
  if (input.permanent) return false;
  const endsAt = toDate(input.earlyAccessEndsAt);
  return !endsAt || endsAt <= now;
}

/**
 * SQL predicate for "currently behind paid access", for queries that can't use the helpers above. Filtering on
 * `earlyAccessEndsAt` alone silently drops permanent versions. The column is NOT NULL DEFAULT false, so no
 * coalesce is needed.
 */
export function paidAccessSql(alias = 'mv'): string {
  return `(${alias}."earlyAccessPermanent" OR ${alias}."earlyAccessEndsAt" > NOW())`;
}
