import { Center, Loader, Text } from '@mantine/core';
import React from 'react';
import { Announcement } from '~/components/Announcements/Announcement';
import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import { CreatorAnnouncement } from '~/components/Announcements/CreatorAnnouncement';
import { DeleteCreatorAnnouncementButton } from '~/components/Announcements/CreatorAnnouncementsCarousel';
import { AnnouncementMuteMenuItem } from '~/components/Announcements/AnnouncementMuteToggle';
import {
  useCreatorAnnouncementsFeature,
  useMutedCreators,
  useQueryFollowedAnnouncements,
} from '~/components/Announcements/creator-announcements.utils';
import { Menu } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export type AnnouncementSource = 'civitai' | 'creators';

export function AnnouncementsPanel({ sources }: { sources: AnnouncementSource[] }) {
  const creatorAnnouncementsEnabled = useCreatorAnnouncementsFeature();
  const showCivitai = sources.includes('civitai');
  const showCreators = sources.includes('creators') && creatorAnnouncementsEnabled;

  const { data: civitai, isLoading: loadingCivitai } = useGetAnnouncements();
  const { announcements: creators, isLoading: loadingCreators } =
    useQueryFollowedAnnouncements(showCreators);
  const mutedCreatorIds = useMutedCreators();

  const isLoading = (showCivitai && loadingCivitai) || (showCreators && loadingCreators);
  const civitaiItems = showCivitai ? civitai : [];
  const creatorItems = showCreators ? creators : [];

  if (isLoading)
    return (
      <Center p="sm">
        <Loader />
      </Center>
    );

  if (!civitaiItems.length && !creatorItems.length)
    return (
      <Center p="sm">
        <Text>All caught up! Nothing to see here</Text>
      </Center>
    );

  return (
    <div className="flex flex-col gap-3 @container">
      {civitaiItems.map((announcement) => (
        <Announcement
          key={announcement.id}
          announcement={announcement}
          style={announcement.dismissed ? { background: 'transparent' } : undefined}
        />
      ))}
      {creatorItems.map((announcement) => (
        <CreatorAnnouncement
          key={announcement.id}
          announcement={announcement}
          actions={
            <div className="flex items-center gap-1">
              <DeleteCreatorAnnouncementButton announcement={announcement} />
              {!!announcement.user && (
                <Menu withinPortal position="bottom-end">
                  <Menu.Target>
                    <LegacyActionIcon
                      variant="subtle"
                      color="gray"
                      radius="xl"
                      aria-label="Announcement options"
                    >
                      <IconDotsVertical size={16} />
                    </LegacyActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <AnnouncementMuteMenuItem
                      creatorId={announcement.user.id}
                      creatorName={announcement.user.username}
                      muted={mutedCreatorIds.includes(announcement.user.id)}
                    />
                  </Menu.Dropdown>
                </Menu>
              )}
            </div>
          }
        />
      ))}
    </div>
  );
}
