import { AspectRatio } from '@mantine/core';
import { useMemo } from 'react';
import { InView } from 'react-intersection-observer';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { PostsInfiniteModel } from '~/server/services/post.service';

export function PostsCard({
  data: { image, id },
  width: cardWidth,
}: {
  data: PostsInfiniteModel;
  width: number;
}) {
  const height = useMemo(() => {
    if (!image.width || !image.height) return 300;
    const width = cardWidth > 0 ? cardWidth : 300;
    const aspectRatio = image.width / image.height;
    const imageHeight = Math.floor(width / aspectRatio) + (aspectRatio >= 1 ? 60 : 0);
    return Math.min(imageHeight, 600);
  }, [cardWidth, image.width, image.height]);

  return (
    <InView>
      {({ inView, ref }) => (
        <MasonryCard withBorder shadow="sm" p={0} height={height} ref={ref}>
          {inView && (
            <>
              <ImageGuard
                images={[image as any]}
                connect={{ entityId: id, entityType: 'post' }}
                render={(image) => (
                  <>
                    <ImageGuard.Unsafe>
                      <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                        <MediaHash {...image} />
                      </AspectRatio>
                    </ImageGuard.Unsafe>
                    <ImageGuard.Safe>
                      <EdgeImage
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={image.name ?? undefined}
                        width={450}
                        placeholder="empty"
                        style={{ width: '100%', zIndex: 2, position: 'relative' }}
                      />
                    </ImageGuard.Safe>
                  </>
                )}
              />
            </>
          )}
        </MasonryCard>
      )}
    </InView>
  );
}
