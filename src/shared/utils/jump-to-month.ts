import * as z from 'zod';

const JUMP_TO_MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** A gallery start point as a UTC calendar month, `YYYY-MM`. */
export const jumpToMonthSchema = z.string().regex(JUMP_TO_MONTH_RE);

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

export const pickerDateToMonth = (date: Date | null) =>
  date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}` : undefined;
