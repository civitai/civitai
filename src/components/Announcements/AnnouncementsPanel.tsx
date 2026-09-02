import { Center, Loader, Text } from '@mantine/core';
import React from 'react';
import { Announcement } from '~/components/Announcements/Announcement';
import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import { CreatorAnnouncement } from '~/components/Announcements/CreatorAnnouncement';
import {
  dismissCreatorAnnouncement,
  pruneDismissedCreatorAnnouncements,
  useDismissedCreatorAnnouncements,
} from '~/components/Announcements/creator-announcement-dismissals';
import { DeleteCreatorAnnouncementMenuItem } from '~/components/Announcements/CreatorAnnouncementsCarousel';
import { AnnouncementMuteMenuItem } from '~/components/Announcements/AnnouncementMuteToggle';
import {
  useCreatorAnnouncementsFeature,
  useMutedCreators,
  useQueryFollowedAnnouncements,
} from '~/components/Announcements/creator-announcements.utils';
import { Menu } from '@mantine/core';
import { IconDotsVertical, IconX } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export type AnnouncementSource = 'civitai' | 'creators';

// Stable reference so the memo below does not churn when creators are switched off.
const EMPTY_CREATOR_ITEMS: never[] = [];

export function AnnouncementsPanel({ sources }: { sources: AnnouncementSource[] }) {
  const creatorAnnouncementsEnabled = useCreatorAnnouncementsFeature();
  const showCivitai = sources.includes('civitai');
  const showCreators = sources.includes('creators') && creatorAnnouncementsEnabled;

  const { data: civitai, isLoading: loadingCivitai } = useGetAnnouncements();
  const { announcements: creators, isLoading: loadingCreators } =
    useQueryFollowedAnnouncements(showCreators);
  const mutedCreatorIds = useMutedCreators();
  const dismissedCreatorIds = useDismissedCreatorAnnouncements();

  const isLoading = (showCivitai && loadingCivitai) || (showCreators && loadingCreators);
  const civitaiItems = showCivitai ? civitai : [];
  // Memoised because the prune effect below depends on it: a fresh array each render would
  // re-run the effect every render.
  const creatorItems = React.useMemo(
    () => (showCreators ? creators : EMPTY_CREATOR_ITEMS),
    [showCreators, creators]
  );

  // Same contract as the sitewide prune: only once the live set has resolved, or an empty
  // load would drop every dismissal.
  React.useEffect(() => {
    if (!creatorItems.length) return;
    pruneDismissedCreatorAnnouncements(creatorItems.map((x) => x.id));
  }, [creatorItems]);

  const visibleCreatorItems = creatorItems.filter((x) => !dismissedCreatorIds.includes(x.id));

  if (isLoading)
    return (
      <Center p="sm">
        <Loader />
      </Center>
    );

  if (!civitaiItems.length && !visibleCreatorItems.length)
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
      {visibleCreatorItems.map((announcement) => (
        <CreatorAnnouncement
          key={announcement.id}
          announcement={announcement}
          withAuthor
          actions={
            <div className="flex items-center gap-1">
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
                    <DeleteCreatorAnnouncementMenuItem announcement={announcement} />
                  </Menu.Dropdown>
                </Menu>
              )}
              <LegacyActionIcon
                variant="subtle"
                color="gray"
                radius="xl"
                className="text-dark-9 dark:text-white"
                onClick={() => dismissCreatorAnnouncement(announcement.id)}
                aria-label="Dismiss creator announcement"
              >
                <IconX size={16} />
              </LegacyActionIcon>
            </div>
          }
        />
      ))}
    </div>
  );
}
