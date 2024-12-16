import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import styles from './ContentCard.module.scss';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import { TwCard } from '~/components/TwCard/TwCard';
import { useInView } from '~/hooks/useInView';
import clsx from 'clsx';
import React, { Fragment, type Key } from 'react';
import { ConnectType, ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaType } from '~/shared/utils/prisma/enums';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { VideoMetadata } from '~/server/schema/media.schema';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { Text } from '@mantine/core';

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
  name?: string;
  metadata: MixedObject | null;
  nsfwLevel?: number;
  userId?: number;
  user?: { id: number };
  width?: number | null;
  height?: number | null;
};

type ContentCardProps = {
  href?: string;
  aspectRatio?: AspectRatio;
  onClick?: React.MouseEventHandler;
  cosmetic?: ContentDecorationCosmetic['data'];
  className?: string;
  image?: ImageProps;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  onSite?: boolean;
} & ContentTypeProps;

const IMAGE_CARD_WIDTH = 450;

export function ContentCard({
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
  onSite,
}: ContentCardProps) {
  const { ref, inView } = useInView();

  // Small hack to prevent blurry landscape images
  const originalAspectRatio = image && image.width && image.height ? image.width / image.height : 1;
  const wrapperStyle = { aspectRatio: aspectRatioMap[aspectRatio] };

  return (
    <TwCosmeticWrapper cosmetic={cosmetic} style={cosmetic ? wrapperStyle : undefined}>
      <TwCard
        ref={ref as any}
        style={!cosmetic ? wrapperStyle : undefined}
        onClick={onClick}
        href={href}
        className={clsx(className)}
      >
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
                      {!safe ? (
                        <MediaHash {...image} />
                      ) : (
                        <EdgeMedia2
                          metadata={image.metadata as MixedObject}
                          src={image.url}
                          name={image.name ?? image.id.toString()}
                          alt={image.name ?? undefined}
                          type={image.type}
                          placeholder="empty"
                          className={clsx(styles.image, { [styles.top]: originalAspectRatio < 1 })}
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
              {footer && <div className={styles.footer}>{footer}</div>}
              {onSite && <OnsiteIndicator />}
            </>
          )}
        </div>
      </TwCard>
    </TwCosmeticWrapper>
  );
}
