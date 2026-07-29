/**
 * Pure exposure resolver for the announcement feed-CLS fix — extracted from
 * `useGetAnnouncements` so the SSR-exact / hydration behaviour is unit-testable
 * WITHOUT a browser or the provider/trpc graph. This is the heart of the durable
 * fix; a regression here is the net-negative CLS mechanism coming back.
 *
 * Inputs:
 *  - `typed`         — this type's SSR-seeded announcements (dismissed-independent).
 *  - `exposeSSR`     — `feedReserveCls` ON AND `type === 'site'`. When true, the
 *                      dismissed set is read from the cookie on BOTH the server and
 *                      the first client paint, so the REAL banner renders from SSR.
 *  - `isClient`      — false on the server AND the first client render (the
 *                      `useIsClient` hydration boundary), true afterwards.
 *  - `dismissedStore`— the client cookie-backed store's dismissed ids for the type.
 *  - `dismissedSeed` — the server-read cookie's dismissed ids for the type (from
 *                      AppProvider context; present on SSR + first client paint).
 *
 * Behaviour:
 *  - exposeSSR OFF (flag off or non-site): keep the original `isClient` gate — []
 *    on the server + first client paint, store-driven afterwards. BYTE-IDENTICAL
 *    to the pre-fix behaviour.
 *  - exposeSSR ON: always expose; the driving dismissed set is `dismissedSeed`
 *    pre-hydration (server + first client paint agree → no hydration mismatch) and
 *    `dismissedStore` post-hydration. Because the store is initialised from the
 *    SAME cookie as the seed, the value is identical at the handoff → no visual
 *    change, no collapse.
 */
export function resolveAnnouncementExposure<T extends { id: number }>(args: {
  typed: T[];
  exposeSSR: boolean;
  isClient: boolean;
  dismissedStore: number[];
  dismissedSeed: number[];
}): Array<T & { dismissed: boolean }> {
  const { typed, exposeSSR, isClient, dismissedStore, dismissedSeed } = args;
  if (!(exposeSSR || isClient)) return [];
  const dismissed = exposeSSR ? (isClient ? dismissedStore : dismissedSeed) : dismissedStore;
  return typed.map((announcement) => ({
    ...announcement,
    dismissed: dismissed.includes(announcement.id),
  }));
}
