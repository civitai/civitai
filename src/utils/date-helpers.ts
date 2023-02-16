import dayjs from 'dayjs';

export function formatDate(value: Date, format = 'MMM DD, YYYY') {
  return dayjs(value).format(format);
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
  return dayjs.max(parsedDates).toDate();
}

export function isBetweenToday(value: Date) {
  const today = dayjs();
  return dayjs(value).isBetween(today.startOf('day'), today.clone().endOf('day'), null, '[]');
}
