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
    { name: 'announcements' }
  )
);

export function dismissAnnouncements(ids: number | number[]) {
  useAnnouncementsStore.setState((state) => ({ dismissed: state.dismissed.concat(ids) }));
}

export function useGetAnnouncements(args?: { showHidden: boolean }) {
  const { showHidden } = args ?? {};
  const dismissed = useAnnouncementsStore((state) => state.dismissed);
  const { data, ...rest } = trpc.announcement.getAnnouncements.useQuery();

  const announcements = useMemo(
    () =>
      (showHidden ? data : data?.filter((announcement) => !dismissed.includes(announcement.id))) ??
      [],
    [data, dismissed, showHidden]
  );

  return { data: announcements, ...rest };
}
