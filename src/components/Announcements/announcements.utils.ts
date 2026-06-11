import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useDomainColor } from '~/hooks/useDomainColor';
import { useAppContext } from '~/providers/AppProvider';
import { trpc } from '~/utils/trpc';

// The announcements query is SSR-seeded (see AppProvider / `/api/user/settings`).
// A non-zero staleTime is what actually skips the per-bootstrap fetch: with
// `initialData` but staleTime 0, RQ still fires a background refetch on mount.
// Announcements are low-churn (mod edits clear the redis cache; time windows
// open/close), so a few-minutes stale window keeps them eventually-fresh within
// a long SPA session while cutting the bootstrap call. Every hard navigation
// re-runs getInitialProps and reseeds anyway.
const ANNOUNCEMENTS_STALE_TIME = 5 * 60 * 1000;

export const useAnnouncementsStore = create<{
  dismissed: number[];
}>()(
  persist(
    (set) => ({
      dismissed: [],
    }),
    { name: 'announcements', version: 1 }
  )
);

export function dismissAnnouncements(ids: number | number[]) {
  useAnnouncementsStore.setState((state) => ({
    dismissed: [...new Set(state.dismissed.concat(ids))],
  }));
}

export function useGetAnnouncements() {
  const dismissed = useAnnouncementsStore((state) => state.dismissed);
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
  // v5: query onSettled removed — prune dismissed ids to those still present once data loads.
  // Functional setState avoids depending on `dismissed` (which would re-loop the effect).
  useEffect(() => {
    if (!data?.length) return;
    const announcementIds = data.map((x) => x.id);
    useAnnouncementsStore.setState((state) => ({
      dismissed: state.dismissed.filter((dismissedId) => announcementIds.includes(dismissedId)),
    }));
  }, [data]);

  const announcements = useMemo(
    () =>
      data?.map((announcement) => ({
        ...announcement,
        dismissed: dismissed.includes(announcement.id),
      })) ?? [],
    [data, dismissed]
  );

  return { data: announcements, ...rest };
}
