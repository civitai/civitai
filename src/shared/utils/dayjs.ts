import dayjs from 'dayjs';
import minMax from 'dayjs/plugin/minMax';
import utc from 'dayjs/plugin/utc';
import { lazyProxy } from '~/shared/utils/lazy';

const lazyDayjs = lazyProxy(() => {
  dayjs.extend(minMax);
  dayjs.extend(utc);
  return dayjs;
});

export default lazyDayjs;
