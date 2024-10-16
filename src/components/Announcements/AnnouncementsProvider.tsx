import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { trpc } from '~/utils/trpc';
import { useLocalStorage } from '@mantine/hooks';

const Context = createContext<{
  dismiss: (id: number) => void;
  dismissAll: () => void;
  dismissed: number[];
} | null>(null);
export function useAnnouncementsContext() {
  const context = useContext(Context);
  if (!context) throw new Error('missing AnnouncementsProvider in tree');
  return context;
}

const KEY = 'dismissed-announcements';
export function AnnouncementsProvider({ children }: { children: React.ReactNode }) {
  const { data } = trpc.announcement.getAnnouncements.useQuery();
  const [dismissed, setDismissed] = useLocalStorage<number[]>({
    key: KEY,
    defaultValue: [],
  });

  function dismiss(id: number) {
    setDismissed((dismissed) => [...dismissed, id]);
  }

  function dismissAll() {
    setDismissed(data?.map((x) => x.id) ?? []);
  }

  useEffect(() => {
    if (!data) return;
    const legacyKeys = Object.keys(localStorage).filter((key) => key.startsWith('announcement-'));
    const legacyIds = legacyKeys.map((key) => Number(key.replace('announcement-', '')));
    const announcementIds = data.map(({ id }) => id);

    // remove legacy announcment id storage
    if (legacyIds) {
      setDismissed(legacyIds.filter((id) => announcementIds.includes(id)));
      for (const key of legacyKeys) {
        localStorage.removeItem(key);
      }
    }

    // remove old announcementIds from storage
    if (announcementIds.some((id) => dismissed.includes(id))) {
      setDismissed(dismissed.filter((id) => announcementIds.includes(id)));
    }
  }, [data]); // eslint-disable-line

  // TODO - handle welcome announcement

  return <Context.Provider value={{ dismiss, dismissed, dismissAll }}>{children}</Context.Provider>;
}

export function useGetAnnouncements(args?: { showHidden: boolean }) {
  const { showHidden } = args ?? {};
  const { dismissed } = useAnnouncementsContext();
  const { data, ...rest } = trpc.announcement.getAnnouncements.useQuery();

  const announcements = useMemo(
    () =>
      (showHidden ? data : data?.filter((announcement) => !dismissed.includes(announcement.id))) ??
      [],
    [data, dismissed, showHidden]
  );

  return { data: announcements, ...rest };
}
