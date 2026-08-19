import { Text } from '@mantine/core';
import React from 'react';
import { AnnouncementCard } from '~/components/Announcements/AnnouncementCard';
import type { CreatorAnnouncement as CreatorAnnouncementModel } from '~/components/Announcements/creator-announcement.types';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';

export const DEFAULT_ANNOUNCEMENT_TITLE = 'Creator announcement';

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

  // Migrated profile banners carry no title — they were bio text, not announcements — so
  // they fall back to a generic one rather than rendering a card with no heading. Applied
  // at render, not stored: the row keeps what the creator actually wrote, and a creator who
  // later titles it simply overrides this.
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
