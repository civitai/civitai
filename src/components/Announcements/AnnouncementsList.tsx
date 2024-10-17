import { Center, Loader, Text } from '@mantine/core';
import { Announcement } from '~/components/Announcements/Announcement';
import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';

export function AnnouncementsList() {
  const { data, isLoading } = useGetAnnouncements();

  return isLoading ? (
    <Center p="sm">
      <Loader />
    </Center>
  ) : !!data.length ? (
    <div className="flex flex-col gap-3 @container">
      {data.map((announcement) => (
        <Announcement
          key={announcement.id}
          announcement={announcement}
          style={announcement.dismissed ? { background: 'transparent' } : undefined}
        />
      ))}
    </div>
  ) : (
    <Center p="sm">
      <Text>All caught up! Nothing to see here</Text>
    </Center>
  );
}
