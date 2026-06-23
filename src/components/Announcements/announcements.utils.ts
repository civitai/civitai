import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useDomainColor } from '~/hooks/useDomainColor';
import { useIsClient } from '~/providers/IsClientProvider';
import { useAppContext } from '~/providers/AppProvider';
import type { AnnouncementType } from '~/server/schema/announcement.schema';
import { trpc } from '~/utils/trpc';

// The announcements query is SSR-seeded (see AppProvider / `/api/user/settings`).
// A non-zero staleTime is what actually skips the per-bootstrap fetch: with
// `initialData` but staleTime 0, RQ still fires a background refetch on mount.
// Announcements are low-churn (mod edits clear the redis cache; time windows
// open/close), so a few-minutes stale window keeps them eventually-fresh within
// a long SPA session while cutting the bootstrap call. Every hard navigation
// re-runs getInitialProps and reseeds anyway.
const ANNOUNCEMENTS_STALE_TIME = 5 * 60 * 1000;

type DismissedByType = Record<AnnouncementType, number[]>;

// Explicit literal (rather than deriving from `announcementTypes`) so adding a new
// announcement type is a compile error here until its dismissed bucket is wired up.
function emptyDismissed(): DismissedByType {
  return { site: [], generator: [], training: [] };
}

export const useAnnouncementsStore = create<{
  dismissed: DismissedByType;
}>()(
  persist(
    () => ({
      dismissed: emptyDismissed(),
    }),
    {
      name: 'announcements',
      // v2: dismissed went from a flat `number[]` to a per-type record. Existing
      // dismissed ids predate placements, so they belong to the `site` bucket.
      version: 2,
      migrate: (persisted, version) => {
        if (version < 2) {
          const legacy = (persisted as { dismissed?: number[] } | undefined)?.dismissed ?? [];
          return { dismissed: { ...emptyDismissed(), site: legacy } };
        }
        return persisted as { dismissed: DismissedByType };
      },
    }
  )
);

export function dismissAnnouncements(ids: number | number[], type: AnnouncementType = 'site') {
  useAnnouncementsStore.setState((state) => ({
    dismissed: {
      ...state.dismissed,
      [type]: [...new Set(state.dismissed[type].concat(ids))],
    },
  }));
}

export function useGetAnnouncements(type: AnnouncementType = 'site') {
  const isClient = useIsClient();
  const dismissed = useAnnouncementsStore((state) => state.dismissed[type]);
  const domainColor = useDomainColor();
  // Seed from the SSR snapshot carried by AppProvider. We seed HERE (not in
  // AppProvider) because the query key is `{ domain: useDomainColor() }` and only
  // this hook — below FeatureFlagsProvider — can resolve that color. The seed
  // content was computed server-side with `getRequestDomainColor(req)`, exactly
  // what the resolver's domain middleware uses, so it matches a live fetch under
  // this key even though the two color functions can diverge (e.g. on red).
  const { announcements: initialData } = useAppContext();
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
  // present once data loads. Functional setState avoids depending on `dismissed`
  // (which would re-loop the effect).
  useEffect(() => {
    if (!typed.length) return;
    const announcementIds = typed.map((x) => x.id);
    useAnnouncementsStore.setState((state) => ({
      dismissed: {
        ...state.dismissed,
        [type]: state.dismissed[type].filter((dismissedId) =>
          announcementIds.includes(dismissedId)
        ),
      },
    }));
  }, [typed, type]);

  // Only EXPOSE the seeded data once hydrated. `dismissed` comes from a
  // localStorage-backed zustand store that rehydrates synchronously on the
  // client — so server (dismissed=[]) and client-first-paint (dismissed=[...])
  // would render different banners off the SSR seed → hydration mismatch / a
  // flash of a previously-dismissed announcement. Gating on `useIsClient()`
  // (false on the server AND the first client render) makes SSR output match
  // `main` (empty) and defers dismissed-dependent rendering to after hydration.
  // The network cut is unaffected — the seed stays in the RQ cache, so no fetch
  // fires; we just don't surface it until the client paint where `dismissed` is
  // authoritative.
  const announcements = useMemo(
    () =>
      isClient
        ? typed.map((announcement) => ({
            ...announcement,
            dismissed: dismissed.includes(announcement.id),
          }))
        : [],
    [typed, dismissed, isClient]
  );

  return { data: announcements, ...rest };
}
