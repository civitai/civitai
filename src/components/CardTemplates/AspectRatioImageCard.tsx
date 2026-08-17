import { Text } from '@mantine/core';
import clsx from 'clsx';
import React, { type Key } from 'react';
import type { ImpressionTarget } from '~/components/TrackView/useTrackImpression';
import type { DialogKey, DialogState } from '~/components/Dialog/routed-dialog/registry';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import type { ConnectType } from '~/components/ImageGuard/ImageGuard2';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { NextLink } from '~/components/NextLink/NextLink';
import type { VideoMetadata } from '~/server/schema/media.schema';
import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { AspectRatioCard } from './AspectRatioCard';
import cardStyles from './AspectRatioCard.module.scss';
import styles from './AspectRatioImageCard.module.scss';

type ContentTypeProps =
  | {
      contentType?: never;
      contentId?: never;
    }
  | {
      contentType: ConnectType;
      contentId: Key;
    };

type ImageProps = {
  id: number;
  url: string;
  type: MediaType;
  name?: string | null;
  metadata: MixedObject | null;
  nsfwLevel?: number;
  userId?: number;
  user?: { id: number };
  width?: number | null;
  height?: number | null;
  hash?: string | null;
  thumbnailUrl?: string | null;
};

type RoutedDialogProps<T extends DialogKey> = { name: T; state: DialogState<T> };

export type AspectRatioImageCardProps<T extends DialogKey> = {
  href?: string;
  aspectRatio?: 'portrait' | 'landscape' | 'square';
  onClick?: React.MouseEventHandler;
  cosmetic?: ContentDecorationCosmetic['data'];
  className?: string;
  image?: ImageProps;
  header?: React.ReactNode | ((props: { safe?: boolean }) => React.ReactNode);
  footer?: React.ReactNode | ((props: { safe?: boolean }) => React.ReactNode);
  /**
   * Drawn over the media, under the header and footer. Unlike those it gets the
   * whole content box rather than a padded strip, because what goes here is
   * positioned against the artwork.
   */
  overlay?: React.ReactNode | ((props: { safe?: boolean }) => React.ReactNode);
  footerGradient?: boolean;
  onSite?: boolean;
  routedDialog?: RoutedDialogProps<T>;
  target?: string;
  isRemix?: boolean;
  explain?: boolean;
  /**
   * Force the corner browsing-level badge to render on every card, not just
   * mod/owner views of safe content. Mirrors `ImageGuard2.BlurToggle`'s
   * `alwaysVisible`. With this on, the corner slot is a static level
   * indicator; the click-to-reveal toggle on blurred content stays on the
   * centered "This image is rated X" overlay rendered by ImageGuard2.
   */
  alwaysVisibleBadge?: boolean;
  /** Accessible fallback alt text when the image itself has no name (e.g. the card's title). */
  alt?: string;
  /**
   * The entity this card IS, for impression tracking. The image it renders is
   * added automatically — a model card presents both a model and whichever cover
   * image the viewer's browsing level selected, and the image's creator is
   * entitled to that impression even though the card is not about the image.
   */
  impression?: ImpressionTarget;
} & ContentTypeProps;

const IMAGE_CARD_WIDTH = 450;

export function AspectRatioImageCard<T extends DialogKey>({
  href,
  aspectRatio = 'portrait',
  onClick,
  cosmetic,
  className,
  contentType,
  contentId,
  image,
  header,
  footer,
  overlay,
  footerGradient,
  onSite,
  routedDialog,
  target,
  isRemix,
  explain,
  alwaysVisibleBadge,
  alt,
  impression,
}: AspectRatioImageCardProps<T>) {
  const originalAspectRatio = image && image.width && image.height ? image.width / image.height : 1;

  // Rebuilt every render, deliberately not memoized: useTrackImpression keys its
  // effect on the entity IDENTITIES rather than on the array's identity, so a new
  // array per render costs nothing and a memo would only add a stale-deps hazard.
  const impressions: ImpressionTarget[] | undefined =
    impression || image
      ? [
          ...(impression ? [impression] : []),
          // An image card passes its own image as `impression` too; the buffer
          // dedupes on entity identity, so the duplicate costs nothing and no
          // caller has to know whether the shell already covered it.
          ...(image ? [{ entityType: 'Image' as const, entityId: image.id }] : []),
        ]
      : undefined;

  return (
    <AspectRatioCard
      aspectRatio={aspectRatio}
      cosmetic={cosmetic}
      className={className}
      impressions={impressions}
      render={({ inView }) => {
        if (!inView) return null;

        if (!image) {
          return (
            <>
              <LinkOrClick
                href={href}
                onClick={onClick}
                routedDialog={routedDialog}
                className={styles.linkOrClick}
                // No-image branch already contains visible "No Image" text; only
                // override the name when the caller supplied a semantic title.
                aria-label={alt || undefined}
              >
                <div className="flex h-full items-center justify-center">
                  <Text c="dimmed">No Image</Text>
                </div>
              </LinkOrClick>
              {header && (
                <div className={cardStyles.header}>
                  {typeof header === 'function' ? header({}) : header}
                </div>
              )}
              {footer && (
                <div
                  className={clsx(cardStyles.footer, {
                    [cardStyles.gradient]: footerGradient,
                  })}
                >
                  {typeof footer === 'function' ? footer({}) : footer}
                </div>
              )}
              {onSite && <OnsiteIndicator isRemix={isRemix} />}
            </>
          );
        }

        return (
          <ImageGuard2
            connectId={contentId as any}
            connectType={contentType as any}
            image={image}
            explain={explain}
          >
            {(safe) => (
              <>
                <LinkOrClick
                  href={href}
                  onClick={onClick}
                  routedDialog={routedDialog}
                  className={styles.linkOrClick}
                  target={target}
                  // Prefer the caller-supplied `alt` (a semantic title, e.g. the
                  // model name) over the raw image name (often an upload filename).
                  // `||` (not `??`) so an empty-string name can't yield an empty label.
                  aria-label={alt || image.name || 'View media'}
                >
                  {!safe ? (
                    image.hash ? (
                      <MediaHash {...image} />
                    ) : (
                      <EdgeMedia2
                        metadata={image.metadata as MixedObject}
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={image.name ?? alt ?? undefined}
                        type={image.type}
                        imageId={image.id}
                        thumbnailUrl={image.thumbnailUrl}
                        placeholder="empty"
                        className={clsx(styles.image, styles.blurred, {
                          [styles.top]: originalAspectRatio < 1,
                        })}
                        wrapperProps={{ className: 'flex-1 h-full' }}
                        width={IMAGE_CARD_WIDTH}
                        contain
                      />
                    )
                  ) : (
                    <EdgeMedia2
                      metadata={image.metadata as MixedObject}
                      src={image.url}
                      name={image.name ?? image.id.toString()}
                      alt={image.name ?? alt ?? undefined}
                      type={image.type}
                      imageId={image.id}
                      thumbnailUrl={image.thumbnailUrl}
                      placeholder="empty"
                      className={clsx(styles.image, {
                        [styles.top]: originalAspectRatio < 1,
                      })}
                      wrapperProps={{ className: 'flex-1 h-full' }}
                      width={
                        originalAspectRatio > 1
                          ? IMAGE_CARD_WIDTH * originalAspectRatio
                          : IMAGE_CARD_WIDTH
                      }
                      skip={
                        image.type === 'video'
                          ? getSkipValue({
                              type: image.type,
                              metadata: image.metadata as VideoMetadata,
                            })
                          : undefined
                      }
                      contain
                    />
                  )}
                </LinkOrClick>
                {overlay && (typeof overlay === 'function' ? overlay({ safe }) : overlay)}
                <div className={cardStyles.header}>
                  <ImageGuard2.BlurToggle
                    className={cardStyles.chip}
                    alwaysVisible={alwaysVisibleBadge}
                  />
                  {typeof header === 'function' ? header({ safe }) : header}
                </div>
                {footer && (
                  <div
                    className={clsx(cardStyles.footer, {
                      [cardStyles.gradient]: footerGradient,
                    })}
                  >
                    {typeof footer === 'function' ? footer({ safe }) : footer}
                  </div>
                )}
                {onSite && <OnsiteIndicator isRemix={isRemix} />}
              </>
            )}
          </ImageGuard2>
        );
      }}
    />
  );
}

export function LinkOrClick<T extends DialogKey>({
  href,
  onClick,
  children,
  routedDialog,
  className,
  target,
  'aria-label': ariaLabel,
}: {
  href?: string;
  onClick?: React.MouseEventHandler;
  children: React.ReactElement;
  routedDialog?: RoutedDialogProps<T>;
  className?: string;
  target?: string;
  'aria-label'?: string;
}) {
  return href ? (
    <NextLink href={href} className={className} target={target} aria-label={ariaLabel}>
      {children}
    </NextLink>
  ) : routedDialog ? (
    <RoutedDialogLink {...routedDialog} className={className} aria-label={ariaLabel}>
      {children}
    </RoutedDialogLink>
  ) : onClick ? (
    <button onClick={onClick} className={className} aria-label={ariaLabel}>
      {children}
    </button>
  ) : (
    children
  );
}
