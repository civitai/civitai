import * as z from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isCalendarDate = (value: string) => {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** A UTC calendar day, `YYYY-MM-DD`. */
export const publishedDateSchema = z.string().refine(isCalendarDate, 'Expected YYYY-MM-DD');
/** The URL form: a junk date must not fail the whole object, which drops every other filter. */
export const publishedDateParam = publishedDateSchema.optional().catch(undefined);

/**
 * A from/to pair of UTC days as the half-open range `[gte, lt)`. `to` is the last day wanted, so
 * the bound is the midnight after it.
 */
export function publishedRangeBounds({ from, to }: { from?: string; to?: string }) {
  return {
    gte: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
    lt: to ? new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS) : undefined,
  };
}

/** A wider range scans too much of the feed; "models from December 2024" is one month. */
export const PUBLISHED_RANGE_MAX_DAYS = 31;

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00.000Z`) / DAY_MS;
const shiftDay = (day: string, days: number) =>
  new Date((dayNumber(day) + days) * DAY_MS).toISOString().slice(0, 10);

/** Why the pair cannot be queried, or undefined when it can (or when neither end is set). */
export function publishedRangeError({ from, to }: { from?: string; to?: string }) {
  if (!from && !to) return undefined;
  if (!from || !to) return 'Set both publishedFrom and publishedTo, or neither.';
  if (dayNumber(to) < dayNumber(from)) return 'publishedTo must not be before publishedFrom.';
  if (dayNumber(to) - dayNumber(from) > PUBLISHED_RANGE_MAX_DAYS) {
    return `The published range can span at most ${PUBLISHED_RANGE_MAX_DAYS} days.`;
  }
  return undefined;
}

/**
 * The pair after one end was edited: the other end is filled in when empty and pulled along when
 * the edit would leave a reversed or over-wide range. Clearing either end clears both.
 */
export function adjustPublishedRange(
  range: { from?: string; to?: string },
  edited: 'from' | 'to'
): { from?: string; to?: string } {
  const value = range[edited];
  if (!value) return { from: undefined, to: undefined };
  if (edited === 'from') {
    const to = range.to;
    if (!to || dayNumber(to) < dayNumber(value)) return { from: value, to: value };
    return {
      from: value,
      to:
        dayNumber(to) - dayNumber(value) > PUBLISHED_RANGE_MAX_DAYS
          ? shiftDay(value, PUBLISHED_RANGE_MAX_DAYS)
          : to,
    };
  }
  const from = range.from;
  if (!from || dayNumber(from) > dayNumber(value)) return { from: value, to: value };
  return {
    from:
      dayNumber(value) - dayNumber(from) > PUBLISHED_RANGE_MAX_DAYS
        ? shiftDay(value, -PUBLISHED_RANGE_MAX_DAYS)
        : from,
    to: value,
  };
}
