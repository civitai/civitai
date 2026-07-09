import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { useDomainColor } from '~/hooks/useDomainColor';
import { useIsClient } from '~/providers/IsClientProvider';
import { useAppContext } from '~/providers/AppProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { AnnouncementType } from '~/server/schema/announcement.schema';
import { trpc } from '~/utils/trpc';
import type { DismissedByType } from '~/components/Announcements/announcements-dismissed-cookie';
import {
  migrateLegacyLocalStorageToCookie,
  readDismissedCookieClient,
  writeDismissedCookieClient,
} from '~/components/Announcements/announcements-dismissed-cookie';
import { resolveAnnouncementExposure } from '~/components/Announcements/announcements-exposure';

// The announcements query is SSR-seeded (see AppProvider / `/api/user/settings`).
// A non-zero staleTime is what actually skips the per-bootstrap fetch: with
// `initialData` but staleTime 0, RQ still fires a background refetch on mount.
// Announcements are low-churn (mod edits clear the redis cache; time windows
// open/close), so a few-minutes stale window keeps them eventually-fresh within
// a long SPA session while cutting the bootstrap call. Every hard navigation
// re-runs getInitialProps and reseeds anyway.
const ANNOUNCEMENTS_STALE_TIME = 5 * 60 * 1000;

// Stable empty-array reference so `dismissedSeed`'s fallback doesn't churn deps.
const EMPTY_DISMISSED: number[] = [];

// Client-only: migrate the legacy localStorage `announcements` dismissed state to
// the cookie BEFORE the store reads its initial value, so existing dismissers
// don't see dismissed announcements reappear. No-op on the server and when a
// cookie already exists.
migrateLegacyLocalStorageToCookie();

// Cookie-backed dismissed store (was localStorage `persist`). The switch to a
// cookie is GLOBAL + behavior-preserving — the client still filters dismissed and
// renders identically; only WHERE dismissed lives changes, so the SERVER can read
// it too. On the server there is no `document.cookie`, so the store initializes
// empty; SSR rendering reads the per-request dismissed value threaded through
// AppProvider context (`announcementsDismissed`) instead of this store.
export const useAnnouncementsStore = create<{
  dismissed: DismissedByType;
}>(() => ({
  dismissed: readDismissedCookieClient(),
}));

// Single writer for the dismissed set: update the store AND persist the cookie so
// the server sees the change on the next request.
function setDismissed(dismissed: DismissedByType) {
  useAnnouncementsStore.setState({ dismissed });
  writeDismissedCookieClient(dismissed);
}

export function dismissAnnouncements(ids: number | number[], type: AnnouncementType = 'site') {
  const { dismissed } = useAnnouncementsStore.getState();
  setDismissed({
    ...dismissed,
    [type]: [...new Set(dismissed[type].concat(ids))],
  });
}

export function useGetAnnouncements(type: AnnouncementType = 'site') {
  const features = useFeatureFlags();
  const isClient = useIsClient();
  const dismissedStore = useAnnouncementsStore((state) => state.dismissed[type]);
  const domainColor = useDomainColor();
  // Seed from the SSR snapshot carried by AppProvider. We seed HERE (not in
  // AppProvider) because the query key is `{ domain: useDomainColor() }` and only
  // this hook — below FeatureFlagsProvider — can resolve that color. The seed
  // content was computed server-side with `getRequestDomainColor(req)`, exactly
  // what the resolver's domain middleware uses, so it matches a live fetch under
  // this key even though the two color functions can diverge (e.g. on red).
  // `announcementsDismissed` is the server-read dismissed set (from the same
  // cookie the client store reads) — present on the SSR render AND the first
  // client paint (it rides pageProps), so both read the identical value.
  const { announcements: initialData, announcementsDismissed } = useAppContext();
  const dismissedSeed = announcementsDismissed?.[type] ?? EMPTY_DISMISSED;
  const { data, ...rest } = trpc.announcement.getAnnouncements.useQuery(
    { domain: domainColor },
    { initialData, staleTime: ANNOUNCEMENTS_STALE_TIME }
  );
  // The query returns every announcement for the domain (all types); narrow to the
  // requested type client-side. `?? 'site'` keeps untyped/legacy announcements in
  // the default `site` bucket.
  const typed = useMemo(
    () => (data ?? []).filter((x) => (x.metadata.type ?? 'site') === type),
    [data, type]
  );

  // v5: query onSettled removed — prune this type's dismissed ids to those still
  // present once data loads. Only WRITE (store + cookie) when something actually
  // pruned, to avoid a gratuitous cookie write on every mount.
  useEffect(() => {
    if (!typed.length) return;
    const announcementIds = typed.map((x) => x.id);
    const { dismissed } = useAnnouncementsStore.getState();
    const pruned = dismissed[type].filter((id) => announcementIds.includes(id));
    if (pruned.length !== dismissed[type].length) {
      setDismissed({ ...dismissed, [type]: pruned });
    }
  }, [typed, type]);

  // SSR-exact dismiss (durable feed-CLS fix), gated on `feedReserveCls` for the
  // `site` feed placement. When ON, the server + first client paint both read the
  // dismissed set from the SAME cookie (`dismissedSeed`), so SSR renders the REAL
  // carousel (or nothing) at its true height from frame 0 — no `isClient` gate, no
  // min-height reserve, and (steady state) no post-hydration collapse. Post-
  // hydration we switch to the store (initialized from the same cookie → identical
  // value → no visual change) so live dismisses stay reactive.
  //
  // BOUNDED exception: on a legacy dismisser's FIRST load of the new bundle the
  // cookie doesn't exist server-side yet (the localStorage→cookie migration is
  // client-only), so `dismissedSeed` is empty while the migrated `dismissedStore`
  // is not → SSR/first-paint expose the carousel (seed, isClient=false) and post-
  // hydration filters it (store, isClient=true) = one self-healing upward shift
  // (fixed on the 2nd load once the cookie exists). Not a hydration error — first
  // paint matches SSR. Modeled by the migration-transition case in
  // `announcements-exposure.test.ts`.
  //
  // When OFF (or type !== 'site'): behavior is byte-identical to before — the
  // `isClient` gate zeroes `data` on the server + first client render (deferring
  // dismissed-dependent rendering to after hydration), and the store drives
  // `dismissed`. The RQ seed still primes the cache, so no bootstrap fetch fires.
  const exposeSSR = features.feedReserveCls && type === 'site';

  const announcements = useMemo(
    () =>
      resolveAnnouncementExposure({
        typed,
        exposeSSR,
        isClient,
        dismissedStore,
        dismissedSeed,
      }),
    [typed, exposeSSR, isClient, dismissedStore, dismissedSeed]
  );

  // `seededCount` is the SSR-seeded, dismissed-independent count of this type's
  // announcements — stable across the SSR→hydration boundary. Retained for
  // consumers that want the dismissed-independent count.
  return { data: announcements, seededCount: typed.length, isClient, ...rest };
}
