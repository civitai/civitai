import { POST_MINIMUM_SCHEDULE_MINUTES } from '~/server/common/constants';

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
