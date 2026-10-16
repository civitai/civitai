import { POST_MINIMUM_SCHEDULE_MINUTES } from '~/server/common/constants';
import { formatDate } from '~/utils/date-helpers';

// Headroom over the minimum so the default still validates after the user spends a few
// minutes in the modal; the schema re-checks against the clock at submit.
const DEFAULT_SCHEDULE_BUFFER_MINUTES = 5;
const DEFAULT_SCHEDULE_ROUNDING_MINUTES = 5;

export function getDefaultScheduleDate(now = new Date()) {
  const step = DEFAULT_SCHEDULE_ROUNDING_MINUTES * 60 * 1000;
  const earliest =
    now.getTime() + (POST_MINIMUM_SCHEDULE_MINUTES + DEFAULT_SCHEDULE_BUFFER_MINUTES) * 60 * 1000;
  return new Date(Math.ceil(earliest / step) * step);
}

export function withScheduleDay(current: Date, day: Date) {
  const next = new Date(current);
  next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  return next;
}

/** `time` is a native time input's value (`HH:mm`); an empty or partial value keeps `current`. */
export function withScheduleTime(current: Date, time: string) {
  const match = /^(\d{2}):(\d{2})/.exec(time);
  if (!match) return current;
  const next = new Date(current);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return next;
}

export function formatScheduleTime(date: Date) {
  return formatDate(date, 'HH:mm');
}
