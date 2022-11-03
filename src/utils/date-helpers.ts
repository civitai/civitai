import dayjs from 'dayjs';

export function formatDate(value: Date, format = 'MMM DD, YYYY') {
  return dayjs(value).format(format);
}
