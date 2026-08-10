export const LINK_CLASS = 'text-blue-4 hover:underline';

export const dateTime = (value: Date | string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

export const num = (value: number) => value.toLocaleString();

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
