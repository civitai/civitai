import {
  dismissAnnouncements,
  useAnnouncementsStore,
} from '~/components/Announcements/announcements.utils';
import React, { useEffect, useMemo } from 'react';
import { Announcement } from '~/components/Announcements/Announcement';
import { trpc } from '~/utils/trpc';

export function Announcements() {
  const { data } = trpc.announcement.getAnnouncements.useQuery();
  const dismissed = useAnnouncementsStore((state) => state.dismissed);

  useEffect(() => {
    if (!data?.length) return;
    const legacyKeys = Object.keys(localStorage).filter((key) => key.startsWith('announcement-'));
    const legacyIds = legacyKeys.map((key) => Number(key.replace('announcement-', '')));
    const announcementIds = data.map(({ id }) => id);

    // remove legacy announcment id storage
    if (legacyIds) {
      dismissAnnouncements(legacyIds.filter((id) => announcementIds.includes(id)));
      for (const key of legacyKeys) {
        localStorage.removeItem(key);
      }
    }

    // remove old announcementIds from storage
    if (dismissed.some((id) => !announcementIds.includes(id))) {
      dismissAnnouncements(dismissed.filter((id) => announcementIds.includes(id)));
    }
  }, [data]); // eslint-disable-line

  const announcements = useMemo(
    () => data?.filter((announcement) => !dismissed.includes(announcement.id)) ?? [],
    [data, dismissed]
  );

  if (!announcements.length) return null;

  return (
    <div className="mb-3 ">
      <div className="container">
        <Announcement announcement={announcements[0]} />
      </div>
    </div>
  );
}
