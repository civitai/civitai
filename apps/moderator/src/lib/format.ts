export const LINK_CLASS = 'text-blue-4 hover:underline';

export const dateTime = (value: Date | string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

export const num = (value: number) => value.toLocaleString();

/**
 * Milliseconds for a UTC timestamp that may or may not carry its zone marker.
 *
 * 🔴 ClickHouse returns `YYYY-MM-DD HH:MM:SS` unzoned and means UTC; `Date.parse` reads that shape as
 * LOCAL. Never call `Date.parse` on a ClickHouse timestamp directly — both shapes come through here.
 */
export const utcMs = (value: string): number =>
  Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);

/**
 * "3 hours ago" / "11 months ago". An absolute timestamp is precise and says nothing about whether a
 * value is fresh: a resume point reading "Sep 8, 2025" is a year stale, and no one reads that off the
 * date while working. Retool put the same phrasing on its own sweep button.
 */
export const relativeTime = (value: Date | string | null): string => {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((then - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size) return fmt.format(Math.round(seconds / size), unit);
  return fmt.format(seconds, 'second');
};

/**
 * User-authored rich text (review `details`, comment bodies) is stored as HTML. Svelte escapes it, so
 * rendering it raw shows a moderator the markup — and any filter matching on it matches the tags, which
 * made a search for "p" hit every row. Strips tags and decodes the handful of entities that survive.
 *
 * Deliberately NOT a route to `{@html}`: this is display and search text for hostile user input, and
 * the only safe thing to do with it is stop treating it as markup.
 */
export const plainText = (value: string | null | undefined): string =>
  (value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A server row as it arrives over `/api/*`: `Date` becomes `string`, everything else is unchanged.
 *
 * Importing a TYPE from `$lib/server` is erased at build and pulls no database client into the client
 * bundle — only value imports do. Hand-copying these shapes instead is what let `ResourceReview.nsfw`
 * and `Bounty.type` exist server-side and be invisible to the panel rendering them.
 */
export type Jsonified<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null
    ? string | null
    : T[K] extends object
    ? Jsonified<T[K]>
    : T[K];
};

/** Scales through the units, unlike a fixed MB divisor — a 3 GB training set read "3072.0 MB". */
export const bytes = (kb: number): string => {
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = kb;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};
