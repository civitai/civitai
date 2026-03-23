import { Text } from '@mantine/core';
import clsx from 'clsx';
import React, { type Key } from 'react';
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
  footerGradient?: boolean;
  onSite?: boolean;
  routedDialog?: RoutedDialogProps<T>;
  target?: string;
  isRemix?: boolean;
  explain?: boolean;
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
  footerGradient,
  onSite,
  routedDialog,
  target,
  isRemix,
  explain,
}: AspectRatioImageCardProps<T>) {
  const originalAspectRatio = image && image.width && image.height ? image.width / image.height : 1;

  return (
    <AspectRatioCard
      aspectRatio={aspectRatio}
      cosmetic={cosmetic}
      className={className}
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
                >
                  {!safe ? (
                    image.hash ? (
                      <MediaHash {...image} />
                    ) : (
                      <EdgeMedia2
                        metadata={image.metadata as MixedObject}
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={image.name ?? undefined}
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
                      alt={image.name ?? undefined}
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
                <div className={cardStyles.header}>
                  <ImageGuard2.BlurToggle className={cardStyles.chip} />
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
}: {
  href?: string;
  onClick?: React.MouseEventHandler;
  children: React.ReactElement;
  routedDialog?: RoutedDialogProps<T>;
  className?: string;
  target?: string;
}) {
  return href ? (
    <NextLink href={href} className={className} target={target}>
      {children}
    </NextLink>
  ) : routedDialog ? (
    <RoutedDialogLink {...routedDialog} className={className}>
      {children}
    </RoutedDialogLink>
  ) : onClick ? (
    <button onClick={onClick} className={className}>
      {children}
    </button>
  ) : (
    children
  );
}
