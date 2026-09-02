import { Text } from '@mantine/core';
import React from 'react';
import { AnnouncementCard } from '~/components/Announcements/AnnouncementCard';
import type { CreatorAnnouncement as CreatorAnnouncementModel } from '~/components/Announcements/creator-announcement.types';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';

export const DEFAULT_ANNOUNCEMENT_TITLE = 'Creator Announcement';

/**
 * A creator-authored announcement. Layout lives in `AnnouncementCard`, shared with the
 * sitewide variant; what is specific here is the cover coming from a real `Image` row, the
 * fallback title, and the posted-at line.
 *
 * `withAuthor` is off by default because the surface decides, not the row: on the author's
 * own profile the byline is noise, while in the notifications panel creator and Civitai
 * cards are interleaved in one list and a reader has to be able to tell them apart. The
 * author sits in the card's top bar rather than beside the title so that identity is part
 * of the frame, not of the content the author wrote.
 */
export function CreatorAnnouncement({
  announcement,
  actions,
  withAuthor = false,
  ...props
}: {
  announcement: CreatorAnnouncementModel;
  actions?: React.ReactNode;
  withAuthor?: boolean;
} & React.HTMLAttributes<HTMLDivElement>) {
  const { cover, user } = announcement;
  const showAuthor = withAuthor && !!user;
  const postedAt = announcement.startsAt ?? announcement.createdAt;

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
      // With a top bar the controls belong up there beside the author, not indented into
      // the content; without one there is nowhere else for them to go.
      controls={showAuthor ? undefined : actions}
      topBar={
        showAuthor ? (
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <UserAvatar user={user} size="sm" withUsername linkToProfile withHoverCard={false} />
              <Text c="dimmed" size="xs" className="whitespace-nowrap">
                <DaysFromNow date={postedAt} />
              </Text>
            </div>
            {actions}
          </div>
        ) : null
      }
      footer={
        showAuthor ? null : (
          <Text c="dimmed" size="xs">
            <DaysFromNow date={postedAt} />
          </Text>
        )
      }
      {...props}
    />
  );
}
