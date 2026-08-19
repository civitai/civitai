import type { ButtonVariant } from '@mantine/core';
import { Button, Text, Title, useMantineTheme } from '@mantine/core';
import clsx from 'clsx';
import React from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { TwCard } from '~/components/TwCard/TwCard';
import { ANNOUNCEMENT_IMAGE_WIDTH } from '~/components/Announcements/announcement-image';
import type { CreatorAnnouncement as CreatorAnnouncementModel } from '~/components/Announcements/creator-announcement.types';

export const DEFAULT_ANNOUNCEMENT_TITLE = 'Creator announcement';

export function CreatorAnnouncement({
  announcement,
  actions,
  className,
  style,
  ...props
}: {
  announcement: CreatorAnnouncementModel;
  actions?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const theme = useMantineTheme();
  const { cover } = announcement;
  const buttons = announcement.metadata?.actions ?? [];
  const color = theme.colors[announcement.color]?.[4] ?? theme.colors.blue[4];
  // Migrated profile banners carry no title — they were bio text, not announcements — so
  // they fall back to a generic one rather than rendering a card with no heading. Applied
  // at render, not stored: the row keeps what the creator actually wrote, and a creator
  // who later titles it simply overrides this.
  const heading =
    [announcement.emoji, announcement.title].filter(Boolean).join(' ').trim() ||
    DEFAULT_ANNOUNCEMENT_TITLE;

  return (
    <TwCard
      className={clsx('items-stretch border', className)}
      direction="row"
      style={{ borderColor: color, ...style }}
      {...props}
    >
      {cover && (
        <div className="relative min-h-40 w-40 shrink-0 @max-xs:hidden">
          <ImageGuard2 image={{ ...cover, nsfwLevel: announcement.nsfwLevel ?? cover.nsfwLevel }}>
            {(safe) =>
              !safe ? (
                <MediaHash {...cover} style={{ width: '100%', height: '100%' }} />
              ) : (
                <EdgeMedia
                  src={cover.url}
                  type={cover.type}
                  name={cover.name ?? cover.id.toString()}
                  alt={cover.name ?? undefined}
                  width={ANNOUNCEMENT_IMAGE_WIDTH}
                  className="absolute inset-0 size-full object-cover"
                />
              )
            }
          </ImageGuard2>
        </div>
      )}
      <div className="flex flex-1 flex-col justify-center gap-2 p-3">
        {(!!heading || !!actions) && (
          <div className="flex justify-between gap-2">
            {!!heading && <Title order={4}>{heading}</Title>}
            {actions}
          </div>
        )}
        <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
          {announcement.content}
        </CustomMarkdown>
        {!!buttons.length && (
          <div className="flex gap-2">
            {buttons.map((action, index) => (
              <Button
                key={index}
                component={Link}
                href={action.link}
                variant={action.variant ? (action.variant as ButtonVariant) : 'outline'}
                color={action.color ?? announcement.color}
              >
                {action.linkText}
              </Button>
            ))}
          </div>
        )}
        <Text c="dimmed" size="xs">
          <DaysFromNow date={announcement.startsAt ?? announcement.createdAt} />
        </Text>
      </div>
    </TwCard>
  );
}
