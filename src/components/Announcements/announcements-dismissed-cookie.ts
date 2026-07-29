import { getCookie, setCookie } from 'cookies-next';
import * as z from 'zod';
import type { AnnouncementType } from '~/server/schema/announcement.schema';

/**
 * Cookie-backed storage for the announcement `dismissed` state.
 *
 * WHY a cookie (not localStorage): the dismissed set has to be readable by the
 * SERVER so SSR can render the REAL announcement carousel (or nothing) from
 * frame 0 — matching first-client paint exactly. localStorage is client-only, so
 * SSR could only ever render a placeholder/reserve and then collapse it
 * post-hydration for a user who'd dismissed the active announcement — the
 * net-negative feed-CLS mechanism this replaces. A cookie is sent with every
 * request, so `_app`'s `getInitialProps` reads the same value the client will.
 *
 * The cookie is small (dismissed ids are pruned to currently-active
 * announcements — usually 0-3 ints), UNENCRYPTED + non-httpOnly (the client
 * reads AND writes it on dismiss; the server only reads it), `SameSite=Lax`,
 * `path=/`, 1-year expiry. It carries the same per-type
 * `{ site, generator, training }` shape the localStorage store used.
 *
 * 🔴 Hydration safety: `parseDismissedCookieValue` is the SINGLE parser used by
 * BOTH the server (`_app` → AppProvider context) and the client store, so the
 * dismissed set is computed identically on both sides. Keep it pure +
 * deterministic (no Date.now/random) — a divergence here is a hydration mismatch.
 */

export type DismissedByType = Record<AnnouncementType, number[]>;

export const ANNOUNCEMENTS_DISMISSED_COOKIE = 'announcements-dismissed';
// The legacy zustand-`persist` localStorage key we migrate FROM (see below).
const LEGACY_LOCALSTORAGE_KEY = 'announcements';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

// Explicit literal (rather than deriving from `announcementTypes`) so adding a new
// announcement type is a compile error here until its dismissed bucket is wired up.
export function emptyDismissed(): DismissedByType {
  return { site: [], generator: [], training: [] };
}

// A per-field `.catch([])` tolerates a missing key or a non-array value; the
// object-level `safeParse` fallback (in `parseDismissedCookieValue`) handles a
// non-object payload. Numbers only — ids.
const numberArray = z.array(z.number()).catch([]);
const dismissedSchema = z.object({
  site: numberArray,
  generator: numberArray,
  training: numberArray,
});

/**
 * Pure parser for a raw cookie value → `DismissedByType`. Used by BOTH the server
 * (`_app` reads it from `getCookies(ctx)`) and the client store (`getCookie`),
 * which both hand us the URL-DECODED JSON string, so both sides parse to the same
 * value — the hydration-match guarantee. Any malformed/absent value → empty.
 */
export function parseDismissedCookieValue(raw: string | undefined | null): DismissedByType {
  if (!raw) return emptyDismissed();
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return emptyDismissed();
  }
  const parsed = dismissedSchema.safeParse(obj);
  return parsed.success ? parsed.data : emptyDismissed();
}

/**
 * Read + parse the dismissed cookie on the CLIENT. On the server there is no
 * `document.cookie`, so this returns empty — SSR rendering reads the per-request
 * dismissed value threaded through AppProvider context instead of this store.
 */
export function readDismissedCookieClient(): DismissedByType {
  if (typeof window === 'undefined') return emptyDismissed();
  const raw = getCookie(ANNOUNCEMENTS_DISMISSED_COOKIE);
  return parseDismissedCookieValue(typeof raw === 'string' ? raw : undefined);
}

/**
 * Persist the dismissed set to the cookie (client only). `cookies-next`
 * JSON-stringifies the object (its value starts with `{`) and URL-encodes it;
 * `parseDismissedCookieValue` reverses that. Non-httpOnly so the client can write
 * it; `SameSite=Lax` + `path=/` so it rides every navigation the SSR seed needs.
 */
export function writeDismissedCookieClient(dismissed: DismissedByType): void {
  if (typeof window === 'undefined') return;
  setCookie(ANNOUNCEMENTS_DISMISSED_COOKIE, dismissed, {
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'lax',
  });
}

/**
 * Parse the legacy zustand-`persist` localStorage payload into a
 * `DismissedByType`. Handles both shapes the old store wrote:
 *   - v2 (current): `{ state: { dismissed: { site, generator, training } }, version: 2 }`
 *   - v0/v1 (pre-placements): `{ state: { dismissed: number[] }, version: <2 }`
 *     — a flat id list that belonged to the `site` bucket.
 * Also tolerates a bare `{ dismissed: ... }` (no persist envelope).
 */
export function parseLegacyPersisted(raw: string | null | undefined): DismissedByType {
  if (!raw) return emptyDismissed();
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return emptyDismissed();
  }
  const state = obj?.state ?? obj;
  const dismissed = state?.dismissed;
  // v0/v1: flat number[] → site bucket (mirrors the old persist `migrate`).
  if (Array.isArray(dismissed)) {
    return { ...emptyDismissed(), site: dismissed.filter((n: unknown) => typeof n === 'number') };
  }
  const parsed = dismissedSchema.safeParse(dismissed);
  return parsed.success ? parsed.data : emptyDismissed();
}

/**
 * One-time client migration: if the dismissed COOKIE is absent but the legacy
 * localStorage key exists, seed the cookie from it (and clear the legacy key) so
 * existing dismissers do NOT see previously-dismissed announcements reappear when
 * we switch the backing store. No-op on the server, when a cookie already exists,
 * or when there's no legacy data.
 */
export function migrateLegacyLocalStorageToCookie(): void {
  if (typeof window === 'undefined') return;
  const existing = getCookie(ANNOUNCEMENTS_DISMISSED_COOKIE);
  if (typeof existing === 'string' && existing.length > 0) return;
  let legacyRaw: string | null = null;
  try {
    legacyRaw = window.localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
  } catch {
    return;
  }
  if (!legacyRaw) return;
  writeDismissedCookieClient(parseLegacyPersisted(legacyRaw));
  try {
    // Rollout-window caveat: clearing the legacy key means if this session THEN
    // loads a stale OLD (pre-cookie) bundle, it reads the now-empty localStorage
    // key → dismissals reappear for that session. Bounded by the rollout window +
    // the flag's mod-gate; the cookie is authoritative once the new bundle sticks.
    window.localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
  } catch {
    // Best-effort cleanup; the cookie now wins regardless.
  }
}
