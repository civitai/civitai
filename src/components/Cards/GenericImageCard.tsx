import { useCardStyles } from '~/components/Cards/Cards.styles';
import { FeedCard } from '~/components/Cards/FeedCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { IconApiApp, IconPhoto } from '@tabler/icons-react';

export function GenericImageCard({
  image: coverImage,
  entityType,
  entityId,
}: {
  image: ImageProps;
  entityType: string;
  entityId: number;
}) {
  console.log(coverImage);
  const { classes: sharedClasses, cx } = useCardStyles({
    aspectRatio: coverImage.width && coverImage.height ? coverImage.width / coverImage.height : 1,
  });

  const url = (() => {
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
        return IconApiApp;
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
    <FeedCard href={url} aspectRatio="portrait" useCSSAspectRatio>
      <div className={sharedClasses.root}>
        <ImageGuard
          images={[coverImage]}
          render={(image) => (
            <ImageGuard.Content>
              {({ safe }) => {
                // Small hack to prevent blurry landscape images
                const originalAspectRatio =
                  image.width && image.height ? image.width / image.height : 1;

                return (
                  <>
                    <ImageGuard.Report context="image" position="top-right" withinPortal />
                    <ImageGuard.ToggleImage position="top-left" />
                    {safe ? (
                      <EdgeMedia
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={image.name ?? undefined}
                        type={image.type}
                        width={
                          originalAspectRatio > 1
                            ? DEFAULT_EDGE_IMAGE_WIDTH * originalAspectRatio
                            : DEFAULT_EDGE_IMAGE_WIDTH
                        }
                        placeholder="empty"
                        className={sharedClasses.image}
                        loading="lazy"
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
            </ImageGuard.Content>
          )}
        />
      </div>
    </FeedCard>
  );
}
