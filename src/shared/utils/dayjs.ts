import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import isBetween from 'dayjs/plugin/isBetween';
import minMax from 'dayjs/plugin/minMax';
import relativeTime from 'dayjs/plugin/relativeTime';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import CustomParseFormat from 'dayjs/plugin/customParseFormat';
import { lazyProxy } from '~/shared/utils/lazy';

const lazyDayjs = lazyProxy(() => {
  dayjs.extend(minMax);
  dayjs.extend(utc);
  dayjs.extend(duration);
  dayjs.extend(isBetween);
  dayjs.extend(relativeTime);
  dayjs.extend(timezone);
  dayjs.extend(CustomParseFormat);
  return dayjs;
});

export default lazyDayjs;
