import type { ButtonVariant } from '@mantine/core';
import { Button, Title, useMantineTheme } from '@mantine/core';
import clsx from 'clsx';
import React from 'react';
import { ANNOUNCEMENT_IMAGE_WIDTH } from '~/components/Announcements/announcement-image';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { TwCard } from '~/components/TwCard/TwCard';

export type AnnouncementCardAction = {
  link: string;
  linkText: string;
  variant?: string;
  color?: string;
};

/**
 * The cover, in the two shapes the two authoring paths produce.
 *
 * `key` is a bare storage key with no `Image` row — how sitewide announcements have always
 * stored theirs, deliberately, so no row deletion can take the object with it. `image` is a
 * real `Image` row, which is what a creator upload becomes and what gets it NSFW-scanned.
 * A key cannot be guarded because there is nothing to rate; a row always is.
 */
export type AnnouncementCardCover =
  | { kind: 'key'; src: string }
  | {
      kind: 'image';
      nsfwLevel: number;
      id: number;
      url: string;
      type: 'image' | 'video' | 'audio';
      name?: string | null;
      hash?: string | null;
      width?: number | null;
      height?: number | null;
    };

/**
 * The one announcement card. Sitewide and creator announcements render through this so they
 * cannot drift apart visually — they had already drifted twice, on the cover breakpoint and
 * on how a missing title renders, before this existed.
 *
 * Everything that differs between the two lives in the call sites: dismissal and its store,
 * moderator or author controls, and the footer. This component decides layout and nothing
 * about policy.
 */
export function AnnouncementCard({
  title,
  content,
  color,
  cover,
  actions = [],
  controls,
  overlay,
  footer,
  className,
  style,
  ...props
}: {
  title?: string;
  content: string;
  color: string;
  cover?: AnnouncementCardCover | null;
  actions?: AnnouncementCardAction[];
  /** Rendered beside the title — moderator or author controls. */
  controls?: React.ReactNode;
  /** Absolutely positioned over the card, e.g. the dismiss button. */
  overlay?: React.ReactNode;
  footer?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const theme = useMantineTheme();
  const borderColor = theme.colors[color]?.[4] ?? theme.colors.blue[4];

  return (
    <TwCard
      className={clsx('items-stretch border', className)}
      direction="row"
      style={{ borderColor, ...style }}
      {...props}
    >
      {overlay}

      {cover && (
        // Both halves of `size-40` are load-bearing. The height is what makes this square:
        // it is a definite cross size, so the row's `items-stretch` no longer applies, and
        // every child here is `absolute inset-0` and contributes no in-flow height, so
        // dropping it collapses the cover to nothing rather than falling back to the image.
        // Do not make the width responsive without pairing a height.
        //
        // Hidden only when the card itself is under 20rem — this is a container query, so
        // it tracks the card's width, not the viewport's.
        <div className="relative size-40 shrink-0 @max-xs:hidden">
          {cover.kind === 'key' ? (
            <EdgeMedia
              src={cover.src}
              // Shared with `announcement-media-check` so the monitored variant stays the
              // variant users actually load. See announcement-image.ts.
              width={ANNOUNCEMENT_IMAGE_WIDTH}
              alt="Announcement banner image"
              className="absolute inset-0 size-full object-cover"
            />
          ) : (
            <ImageGuard2 image={cover}>
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
          )}
        </div>
      )}

      <div className="flex flex-1 flex-col justify-center gap-2 p-3">
        {(!!title || !!controls) && (
          <div className="flex justify-between gap-2">
            {!!title && <Title order={4}>{title}</Title>}
            {controls}
          </div>
        )}
        <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
          {content}
        </CustomMarkdown>
        {!!actions.length && (
          <div className="flex gap-2">
            {actions.map((action, index) => (
              <Button
                key={index}
                component={Link}
                href={action.link}
                variant={action.variant ? (action.variant as ButtonVariant) : 'outline'}
                color={action.color ?? color}
              >
                {action.linkText}
              </Button>
            ))}
          </div>
        )}
        {footer}
      </div>
    </TwCard>
  );
}
