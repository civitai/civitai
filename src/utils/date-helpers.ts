import type { ConfigType, ManipulateType } from 'dayjs';
import dayjs from '~/shared/utils/dayjs';

export function formatDate(value: ConfigType, format = 'MMM D, YYYY', utc = false) {
  if (utc) return dayjs.utc(value).format(format);
  return dayjs(value).format(format);
}

export function formatDateNullable(value: ConfigType, format = 'MMM D, YYYY', utc = false) {
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

export function increaseDate(value: Date, duration: number, unit: ManipulateType) {
  return dayjs(value).add(duration, unit).toDate();
}

export function decreaseDate(value: Date, duration: number, unit: ManipulateType) {
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
export const aDayAhead = dayjs().add(1, 'day').toDate();

export function stripTime(value: Date | string | number) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().substring(0, 10);
}

export function isValidDate(d: unknown) {
  return d instanceof Date && !isNaN(d as unknown as number);
}

export function toUtc(value: ConfigType) {
  return dayjs.utc(value).toDate();
}

export function startOfDay(value: ConfigType, opts?: { utc?: boolean }) {
  const date = opts?.utc ? dayjs.utc(value) : dayjs(value);
  return date.startOf('day').toDate();
}

export function endOfDay(value: ConfigType, opts?: { utc?: boolean }) {
  const date = opts?.utc ? dayjs.utc(value) : dayjs(value);
  return date.endOf('day').toDate();
}

export function getDatesAsList(startDate: Date, endDate: Date, unit: ManipulateType = 'day') {
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

export function getThanksgivingDate(year: number) {
  // Start with November 1st of the given year
  const novemberFirst = dayjs(new Date(year, 10, 1));
  // Calculate the offset to the first Thursday
  const offsetToThursday = (4 - novemberFirst.day() + 7) % 7;
  // Add the offset to get the first Thursday, then add 21 days (3 weeks) to get the fourth Thursday
  const thanksgiving = novemberFirst.add(offsetToThursday + 21, 'day');

  return thanksgiving.toDate();
}

export function isHolidaysTime() {
  const today = dayjs();
  return today.month() === 11;
}

export function isApril1() {
  const today = dayjs.utc();
  // return today.month() === 3 && today.date() === 1;
  return today.month() === 3 && today.date() >= 1 && today.date() <= 7;
}

export function roundMinutes(d: Date | string) {
  const date = dayjs(d).toDate();
  date.setHours(date.getHours() + Math.round(date.getMinutes() / 60));
  date.setMinutes(0, 0, 0); // Resets also seconds and milliseconds

  return date;
}
