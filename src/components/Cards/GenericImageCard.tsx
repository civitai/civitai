import cardClasses from '~/components/Cards/Cards.module.css';
import { FeedCard } from '~/components/Cards/FeedCard';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import type { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { IconCategory, IconPhoto } from '@tabler/icons-react';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';

export function GenericImageCard({
  image,
  entityType,
  entityId,
  disabled,
}: {
  image: ImageProps;
  entityId: number;
  entityType?: string;
  disabled?: boolean;
}) {
  const url = (() => {
    if (!entityType || !entityId) return undefined;

    switch (entityType) {
      case 'Model': {
        return `/models/${entityId}`;
      }
      case 'Collection': {
        return `/collections/${entityId}`;
      }
      case 'Bounty': {
        return `/bounties/${entityId}`;
      }
      case 'Image': {
        return `/images/${entityId}`;
      }
      default: {
        return '/';
      }
    }
  })();

  const Icon = (() => {
    switch (entityType) {
      case 'Model': {
        return IconCategory;
      }
      case 'Image': {
        return IconPhoto;
      }
      default: {
        return null;
      }
    }
  })();

  const isImageEntity = entityType === 'Image';

  const cardContent = (
    <FeedCard
      style={{
        cursor: disabled ? 'initial' : undefined,
      }}
      href={disabled ? undefined : url}
      frameDecoration={image.cosmetic}
      aspectRatio="portrait"
      useCSSAspectRatio
    >
      <div className={cardClasses.root}>
        {image && (
          <ImageGuard2 image={image}>
            {(safe) => {
              // Small hack to prevent blurry landscape images
              const originalAspectRatio =
                image.width && image.height ? image.width / image.height : 1;
              return (
                <>
                  {!disabled && (
                    <>
                      <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                      <ImageContextMenu image={image} className="absolute right-2 top-2 z-10" />
                    </>
                  )}
                  {safe ? (
                    <div style={{ height: '100%' }}>
                      <EdgeMedia2
                        metadata={image.metadata}
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={image.name ?? undefined}
                        type={image.type}
                        width={
                          originalAspectRatio > 1
                            ? DEFAULT_EDGE_IMAGE_WIDTH * originalAspectRatio
                            : DEFAULT_EDGE_IMAGE_WIDTH
                        }
                        skip={getSkipValue(image)}
                        placeholder="empty"
                        className={cardClasses.image}
                        wrapperProps={{ style: { height: '100%', width: '100%' } }}
                        loading="lazy"
                        contain
                      />
                    </div>
                  ) : (
                    <MediaHash {...image} />
                  )}

                  {Icon && (
                    <Icon
                      size={20}
                      style={{
                        position: 'absolute',
                        bottom: '10px',
                        left: '10px',
                        zIndex: 1,
                        borderRadius: '50%',
                        width: '20px',
                        height: '20px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    />
                  )}
                </>
              );
            }}
          </ImageGuard2>
        )}
      </div>
    </FeedCard>
  );

  if (isImageEntity && !disabled)
    return (
      <RoutedDialogLink
        name="imageDetail"
        state={{ imageId: entityId, filters: { postId: image.postId } }}
        passHref
      >
        {cardContent}
      </RoutedDialogLink>
    );

  return cardContent;
}
