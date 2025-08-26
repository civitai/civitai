import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useDomainColor } from '~/hooks/useDomainColor';
import { trpc } from '~/utils/trpc';

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
  const { data, ...rest } = trpc.announcement.getAnnouncements.useQuery(
    { domain: domainColor },
    {
      onSettled: (data) => {
        if (!data?.length) return;
        const announcementIds = data.map((x) => x.id);
        const newDismissed = dismissed.filter((dismissedId) =>
          announcementIds.includes(dismissedId)
        );
        useAnnouncementsStore.setState({ dismissed: newDismissed });
      },
    }
  );

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
