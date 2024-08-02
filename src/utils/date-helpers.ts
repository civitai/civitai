import dayjs from 'dayjs';
import minMax from 'dayjs/plugin/minMax';
dayjs.extend(minMax);

export function formatDate(value: dayjs.ConfigType, format = 'MMM D, YYYY', utc = false) {
  if (utc) return dayjs.utc(value).format(format);
  return dayjs(value).format(format);
}

export function formatDateNullable(value: dayjs.ConfigType, format = 'MMM D, YYYY', utc = false) {
  if (!value) return;
  else return formatDate(value, format, utc);
}

export function formatDateMin(value: Date, includeTime = true) {
  const time = includeTime ? 'h:mma' : '';
  if (dayjs().isSame(value, 'day')) return dayjs(value).format(includeTime ? 'h:mma' : 'MMM D');
  if (dayjs().isSame(value, 'week')) return dayjs(value).format('dddd ' + time);
  if (dayjs().isSame(value, 'month')) return dayjs(value).format('MMM D ' + time);
  if (dayjs().isSame(value, 'year')) return dayjs(value).format('MMM D ' + time);
  return dayjs(value).format('MMM D, YYYY ' + time);
}

// Deprecated: Use DaysFromNow component instead
export function daysFromNow(
  value: Date,
  options: { withoutSuffix?: boolean } = { withoutSuffix: false }
) {
  const { withoutSuffix } = options;

  return dayjs(value).fromNow(withoutSuffix);
}

export function increaseDate(value: Date, duration: number, unit: dayjs.ManipulateType) {
  return dayjs(value).add(duration, unit).toDate();
}

export function decreaseDate(value: Date, duration: number, unit: dayjs.ManipulateType) {
  return dayjs(value).subtract(duration, unit).toDate();
}

export function isFutureDate(value: Date) {
  return dayjs().isBefore(value);
}

export function maxDate(...dates: Date[]) {
  const parsedDates = dates.map(dayjs);
  return dayjs.max(parsedDates)?.toDate() ?? dates[0];
}

export function minDate(...dates: Date[]) {
  const parsedDates = dates.map(dayjs);
  return dayjs.min(parsedDates)?.toDate() ?? dates[0];
}

export function isBetweenToday(value: Date) {
  const today = dayjs();
  return dayjs(value).isBetween(today.startOf('day'), today.clone().endOf('day'), null, '[]');
}

export const aDayAgo = dayjs().subtract(1, 'day').toDate();

export function stripTime(value: Date) {
  return value.toISOString().substring(0, 10);
}

export function toUtc(value: dayjs.ConfigType) {
  return dayjs.utc(value).toDate();
}

export function startOfDay(value: dayjs.ConfigType) {
  return dayjs(value).startOf('day').toDate();
}

export function endOfDay(value: dayjs.ConfigType) {
  return dayjs(value).endOf('day').toDate();
}

export function getDatesAsList(startDate: Date, endDate: Date, unit: dayjs.ManipulateType = 'day') {
  const dates = [];
  let currentDate = startDate;

  while (currentDate <= endDate) {
    dates.push(currentDate);
    currentDate = increaseDate(currentDate, 1, unit);
  }

  return dates;
}

export function secondsAsMinutes(seconds: number) {
  const duration = dayjs.duration(seconds, 'seconds');
  const sec = duration.seconds();
  const min = duration.minutes();

  if (min === 0) return `${sec}s`;

  return `${min}m ${sec}s`;
}

export function dateWithoutTimezone(date: Date) {
  const withoutTimezone = new Date(date.valueOf()).toISOString().slice(0, -1);
  return new Date(withoutTimezone);
}
