import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { GetAnnouncement } from '~/server/services/announcement.service';
import { trpc } from '~/utils/trpc';
import { useLocalStorage } from '@mantine/hooks';

const Context = createContext<{ dismiss: (id: number) => void } | null>(null);
export function useAnnouncementsContext() {
  const context = useContext(Context);
  if (!context) throw new Error('missing AnnouncementsProvider in tree');
  return context;
}

const KEY = 'dismissed';
export function AnnouncementsProvider({
  children,
}: {
  children: (args: { announcement: GetAnnouncement }) => React.ReactNode;
}) {
  const { data } = trpc.announcement.getAnnouncements.useQuery();
  const [dismissed, setDismissed] = useLocalStorage<number[]>({
    key: KEY,
    defaultValue: [],
  });

  function dismiss(id: number) {
    setDismissed((dismissed) => [...dismissed, id]);
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
      setDismissed((ids) => ids.filter((id) => announcementIds.includes(id)));
    }
  }, [data]); // eslint-disable-line

  const announcements = useMemo(
    () => data?.filter((announcement) => !dismissed.includes(announcement.id)),
    [data, dismissed]
  );

  // TODO - welcome announcement

  if (!announcements?.length) return null;

  return (
    <Context.Provider value={{ dismiss }}>
      {children({ announcement: announcements[0] })}
    </Context.Provider>
  );
}
