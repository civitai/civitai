import { Anchor, Button, Text } from '@mantine/core';
import { IconSpeakerphone } from '@tabler/icons-react';
import clsx from 'clsx';

import {
  CREATOR_ANNOUNCEMENTS_URL,
  creatorAnnouncementsEntryVariant,
} from '~/components/Announcements/creator-announcements-entry';
import { useCreatorAnnouncementsFeature } from '~/components/Announcements/creator-announcements.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function CreatorAnnouncementsEntry({
  userId,
  userMuted,
  announcementCount,
  announcementsLoading,
  className,
}: {
  userId: number;
  userMuted: boolean;
  announcementCount: number;
  announcementsLoading: boolean;
  className?: string;
}) {
  const currentUser = useCurrentUser();
  const featureEnabled = useCreatorAnnouncementsFeature();

  const variant = creatorAnnouncementsEntryVariant({
    featureEnabled,
    currentUserId: currentUser?.id,
    profileUserId: userId,
    profileUserMuted: userMuted,
    announcementCount,
    announcementsLoading,
  });

  if (!variant) return null;

  if (variant === 'manage')
    return (
      <div className={clsx('flex justify-end', className)}>
        <Anchor href={CREATOR_ANNOUNCEMENTS_URL} target="_blank" rel="noreferrer" size="xs">
          Manage announcements in Creator Studio
        </Anchor>
      </div>
    );

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-3 p-3 dark:border-dark-4">
        <IconSpeakerphone size={24} className="shrink-0" />
        <Text size="sm" className="flex-1">
          Post an announcement to tell your followers what you&apos;re working on.
        </Text>
        <Button
          component="a"
          href={CREATOR_ANNOUNCEMENTS_URL}
          target="_blank"
          rel="noreferrer"
          size="compact-sm"
          variant="light"
        >
          Open Creator Studio
        </Button>
      </div>
    </div>
  );
}
