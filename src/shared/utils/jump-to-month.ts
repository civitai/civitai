import * as z from 'zod';

const JUMP_TO_MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** A gallery start point as a UTC calendar month, `YYYY-MM`. */
export const jumpToMonthSchema = z.string().regex(JUMP_TO_MONTH_RE);
/** The URL form: a junk month must not fail the whole object, which drops every other filter. */
export const jumpToMonthParam = jumpToMonthSchema.optional().catch(undefined);

/** Only a chronological sort has a place in time to start from. */
export const isJumpToSort = (sort: string | undefined) => sort === 'Newest' || sort === 'Oldest';

/** The month as `[startMs, endMs)` in UTC. */
export function jumpToMonthBounds(month: string) {
  const match = JUMP_TO_MONTH_RE.exec(month);
  if (!match) throw new Error(`Invalid jump-to month: ${month}`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return { startMs: Date.UTC(year, monthIndex, 1), endMs: Date.UTC(year, monthIndex + 1, 1) };
}

/**
 * Where a creator-scoped chronological feed starts, or undefined when the jump does not apply.
 * Newest scrolls back from the end of the month, Oldest forward from its start.
 */
export function resolveJumpTo(input: {
  jumpTo?: string | null;
  sort?: string;
  userId?: number | null;
}) {
  if (!input.jumpTo || !input.userId || !isJumpToSort(input.sort)) return undefined;
  const { startMs, endMs } = jumpToMonthBounds(input.jumpTo);
  return input.sort === 'Oldest'
    ? { direction: 'after' as const, startMs, endMs }
    : { direction: 'before' as const, startMs, endMs };
}

/** The month a picker shows, read as the viewer's calendar month. */
export const monthToPickerDate = (month: string | undefined) => {
  if (!month || !JUMP_TO_MONTH_RE.test(month)) return null;
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(year, monthNumber - 1, 1);
};

/** A month and a relative period contradict each other, so setting one clears the other. */
export const jumpToPatch = <TReset>(jumpTo: string | undefined, periodReset: TReset) =>
  jumpTo ? { jumpTo, period: periodReset } : { jumpTo };
export const periodPatch = <TPeriod extends string>(period: TPeriod) =>
  period === 'AllTime' ? { period } : { period, jumpTo: undefined };

/** Why a jumped feed is empty: nothing on the side of the month it scrolls toward. */
export function jumpToEmptyMessage(jumpTo: string | undefined, sort: string | undefined) {
  if (!jumpTo || !isJumpToSort(sort) || !JUMP_TO_MONTH_RE.test(jumpTo)) return undefined;
  const month = new Date(jumpToMonthBounds(jumpTo).startMs).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return sort === 'Oldest' ? `Nothing from ${month} or later` : `Nothing from ${month} or earlier`;
}

export const pickerDateToMonth = (date: Date | null) =>
  date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : undefined;
