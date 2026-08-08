export const LINK_CLASS = 'text-blue-4 hover:underline';

export const dateTime = (value: Date | string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

export const num = (value: number) => value.toLocaleString();
