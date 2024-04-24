import { useCardStyles } from '~/components/Cards/Cards.styles';
import { FeedCard } from '~/components/Cards/FeedCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { DEFAULT_EDGE_IMAGE_WIDTH, constants } from '~/server/common/constants';
import { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { IconCategory, IconPhoto } from '@tabler/icons-react';
import { truncate } from 'lodash-es';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';

export function GenericImageCard({
  image: image,
  entityType,
  entityId,
  disabled,
}: {
  image: ImageProps;
  entityType?: string;
  entityId?: number;
  disabled?: boolean;
}) {
  const { classes: sharedClasses } = useCardStyles({
    aspectRatio: image.width && image.height ? image.width / image.height : 1,
  });

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

  return (
    <FeedCard
      href={disabled ? undefined : url}
      style={disabled ? { cursor: 'initial' } : undefined}
      frameDecoration={image.cosmetic}
      aspectRatio="portrait"
      useCSSAspectRatio
    >
      <div className={sharedClasses.root}>
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
                      <ImageGuard2.BlurToggle className="absolute top-2 left-2 z-10" />
                      <ImageContextMenu image={image} className="absolute top-2 right-2 z-10" />
                    </>
                  )}
                  {safe ? (
                    <EdgeMedia
                      src={image.url}
                      name={image.name ?? image.id.toString()}
                      alt={
                        image.meta
                          ? truncate(image.meta.prompt, { length: constants.altTruncateLength })
                          : image.name ?? undefined
                      }
                      type={image.type}
                      width={
                        originalAspectRatio > 1
                          ? DEFAULT_EDGE_IMAGE_WIDTH * originalAspectRatio
                          : DEFAULT_EDGE_IMAGE_WIDTH
                      }
                      placeholder="empty"
                      className={sharedClasses.image}
                      wrapperProps={{ style: { height: '100%', width: '100%' } }}
                      loading="lazy"
                      contain
                    />
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
}
