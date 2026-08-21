import { Text } from '@mantine/core';
import React from 'react';
import { AnnouncementCard } from '~/components/Announcements/AnnouncementCard';
import type { CreatorAnnouncement as CreatorAnnouncementModel } from '~/components/Announcements/creator-announcement.types';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';

export const DEFAULT_ANNOUNCEMENT_TITLE = 'Creator Announcement';

/**
 * A creator-authored announcement. Layout lives in `AnnouncementCard`, shared with the
 * sitewide variant; what is specific here is the cover coming from a real `Image` row, the
 * fallback title, and the posted-at line.
 */
export function CreatorAnnouncement({
  announcement,
  actions,
  ...props
}: {
  announcement: CreatorAnnouncementModel;
  actions?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const { cover } = announcement;

  // The backfill stores this title on migrated banners, so this fallback is for the case
  // it does not cover: a creator writing a body-only announcement. Same wording, so the two
  // paths cannot disagree about what an untitled announcement is called.
  const title =
    [announcement.emoji, announcement.title].filter(Boolean).join(' ').trim() ||
    DEFAULT_ANNOUNCEMENT_TITLE;

  return (
    <AnnouncementCard
      title={title}
      content={announcement.content}
      color={announcement.color}
      cover={
        cover
          ? {
              kind: 'image',
              ...cover,
              // The announcement is never safer than its cover; the service already maxes
              // these, and passing the resolved level keeps the guard consistent with the
              // level the feed filtered on.
              nsfwLevel: announcement.nsfwLevel ?? cover.nsfwLevel,
            }
          : null
      }
      actions={announcement.metadata?.actions ?? []}
      controls={actions}
      footer={
        <Text c="dimmed" size="xs">
          <DaysFromNow date={announcement.startsAt ?? announcement.createdAt} />
        </Text>
      }
      {...props}
    />
  );
}
