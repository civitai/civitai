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
