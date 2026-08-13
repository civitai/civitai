import type { Session } from '~/types/session';

/**
 * Make the session safe to hand to Next as a prop.
 *
 * Props are plain JSON — nothing transforms them the way `trpcState` is transformed — and a warm
 * `session:data2` hit is msgpack, which round-trips both real `Date`s and `undefined` values with their
 * keys intact (`@civitai/auth`'s `getSessionUser` documents the Date half; only the cold-miss HTTP path
 * yields plain JSON). Next rejects BOTH with a page-wide 500 under the dev server, and production
 * serializes them silently — so the two are inseparable and normalizing only the Dates fixes nothing.
 *
 * A JSON round-trip is deliberate rather than a field-by-field pass: it drops `undefined`, ISO-strings
 * Dates, recurses into nested values like `meta`, and needs no list to maintain. It is also exactly what
 * `/api/auth/session` does to the same object, so the SSR seed and every later refetch now agree.
 */
export const jsonSafeSession = (session: Session | null): Session | null =>
  session ? (JSON.parse(JSON.stringify(session)) as Session) : session;
