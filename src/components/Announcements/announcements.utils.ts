import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
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
  const { data, ...rest } = trpc.announcement.getAnnouncements.useQuery();

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
