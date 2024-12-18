import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import styles from './AspectRatioImageCard.module.scss';
import { useInView } from '~/hooks/useInView';
import clsx from 'clsx';
import React, { type Key } from 'react';
import { ConnectType, ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaType } from '~/shared/utils/prisma/enums';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { VideoMetadata } from '~/server/schema/media.schema';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { Text } from '@mantine/core';
import { NextLink } from '~/components/NextLink/NextLink';
import type { DialogKey, DialogState } from '~/components/Dialog/routed-dialog-registry';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { CosmeticCard } from '~/components/CardTemplates/CosmeticCard';

type AspectRatio = keyof typeof aspectRatioMap;
const aspectRatioMap = {
  portrait: '7/9',
  landscape: '9/7',
  square: '1',
} as const;

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
  thumbnailUrl?: string | null;
};

type RoutedDialogProps<T extends DialogKey> = { name: T; state: DialogState<T> };

type AspectRatioImageCardProps<T extends DialogKey> = {
  href?: string;
  aspectRatio?: AspectRatio;
  onClick?: React.MouseEventHandler;
  cosmetic?: ContentDecorationCosmetic['data'];
  className?: string;
  image?: ImageProps;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  footerGradient?: boolean;
  onSite?: boolean;
  routedDialog?: RoutedDialogProps<T>;
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
}: AspectRatioImageCardProps<T>) {
  const { ref, inView } = useInView();

  // Small hack to prevent blurry landscape images
  const originalAspectRatio = image && image.width && image.height ? image.width / image.height : 1;
  const wrapperStyle = { aspectRatio: aspectRatioMap[aspectRatio] };

  return (
    <CosmeticCard
      cosmetic={cosmetic}
      cosmeticStyle={cosmetic ? wrapperStyle : undefined}
      ref={ref}
      style={!cosmetic ? wrapperStyle : undefined}
      className={clsx(className)}
    >
      <>
        <div className={clsx(styles.content, { [styles.inView]: inView })}>
          {inView && (
            <>
              {image ? (
                <ImageGuard2
                  connectId={contentId as any}
                  connectType={contentType as any}
                  image={image}
                >
                  {(safe) => (
                    <>
                      <LinkOrClick
                        href={href}
                        onClick={onClick}
                        routedDialog={routedDialog}
                        className={styles.linkOrClick}
                      >
                        {!safe ? (
                          <MediaHash {...image} />
                        ) : (
                          <EdgeMedia2
                            metadata={image.metadata as MixedObject}
                            src={image.url}
                            name={image.name ?? image.id.toString()}
                            alt={image.name ?? undefined}
                            type={image.type}
                            thumbnailUrl={image.thumbnailUrl}
                            placeholder="empty"
                            className={clsx(styles.image, {
                              [styles.top]: originalAspectRatio < 1,
                            })}
                            wrapperProps={{ className: 'flex-1' }}
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
                      <div className={styles.header}>
                        <ImageGuard2.BlurToggle className={styles.chip} />
                        {header}
                      </div>
                    </>
                  )}
                </ImageGuard2>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <Text color="dimmed">No Image</Text>
                  {header && <div className={styles.header}>{header}</div>}
                </div>
              )}
              {footer && (
                <div className={clsx(styles.footer, { [styles.gradient]: footerGradient })}>
                  {footer}
                </div>
              )}
              {onSite && <OnsiteIndicator />}
            </>
          )}
        </div>
      </>
    </CosmeticCard>
  );
}

function LinkOrClick<T extends DialogKey>({
  href,
  onClick,
  children,
  routedDialog,
  className,
}: {
  href?: string;
  onClick?: React.MouseEventHandler;
  children: React.ReactElement;
  routedDialog?: RoutedDialogProps<T>;
  className?: string;
}) {
  return href ? (
    <NextLink href={href} className={className}>
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
