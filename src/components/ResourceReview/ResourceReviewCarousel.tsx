import { Button, Container, Text, Loader } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { IconInfoCircle } from '@tabler/icons-react';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';

import { MediaHash } from '~/components/ImageHash/ImageHash';
import { Reactions } from '~/components/Reaction/Reactions';
import { ImageSort } from '~/server/common/enums';
import type { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import classes from './ResourceReviewCarousel.module.css';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function ResourceReviewCarousel({
  userId,
  modelVersionId,
  reviewId,
}: {
  userId: number;
  modelVersionId: number;
  reviewId: number;
}) {
  const mobile = useContainerSmallerThan('md');

  // today, typescript was not cool.
  // functions will only check extra parameters if it's fresh
  const filters: GetInfiniteImagesInput = {
    userId,
    modelVersionId,
    sort: ImageSort.MostReactions,
    period: MetricTimeframe.AllTime,
    limit: 10,
    useIndex: true,
  };

  const { data, images, isLoading } = useQueryImages(filters);

  const viewMore = data?.pages.some((x) => x.nextCursor !== undefined) ?? false;

  const totalItems = images.length + (viewMore ? 1 : 0);
  const slidesToShow = mobile ? 1 : 2;

  return (
    <div className="mb-4 bg-gray-2 dark:bg-dark-9">
      <Container py="md">
        {isLoading ? (
          <div className="flex h-96 items-center justify-center">
            <Loader />
          </div>
        ) : (
          <Embla
            key={reviewId}
            align={totalItems > slidesToShow ? 'start' : 'center'}
            withControls={totalItems > slidesToShow ? true : false}
            loop
          >
            <Embla.Viewport>
              <Embla.Container className="-ml-3 flex @md:-ml-6">
                {images.map((image, i) => (
                  <Embla.Slide
                    key={image.id}
                    index={i}
                    className="flex flex-[0_0_100%] items-center justify-center pl-3 @md:flex-[0_0_50%] @md:pl-6"
                  >
                    <ImageGuard2 image={image} connectType="review" connectId={reviewId}>
                      {(safe) => (
                        <div className="relative">
                          <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                          <ImageContextMenu image={image} className="absolute right-2 top-2 z-10" />

                          <RoutedDialogLink
                            name="imageDetail"
                            state={{ imageId: image.id, images }}
                          >
                            {!safe ? (
                              <MediaHash {...image} />
                            ) : (
                              <EdgeMedia
                                src={image.url}
                                name={image.name ?? image.id.toString()}
                                alt={image.name ?? undefined}
                                type={image.type}
                                width={450}
                                placeholder="empty"
                                style={{ width: '100%', objectPosition: 'top' }}
                              />
                            )}
                          </RoutedDialogLink>
                          <Reactions
                            entityId={image.id}
                            entityType="image"
                            reactions={image.reactions}
                            metrics={{
                              likeCount: image.stats?.likeCountAllTime,
                              dislikeCount: image.stats?.dislikeCountAllTime,
                              heartCount: image.stats?.heartCountAllTime,
                              laughCount: image.stats?.laughCountAllTime,
                              cryCount: image.stats?.cryCountAllTime,
                            }}
                            readonly={!safe}
                            className={classes.reactions}
                            targetUserId={image.user.id}
                            disableBuzzTip={image.poi}
                          />
                          {image.hasMeta && (
                            <div className="absolute bottom-0.5 right-0.5 z-10">
                              <ImageMetaPopover2 imageId={image.id} type={image.type}>
                                <LegacyActionIcon component="div" variant="transparent" size="lg">
                                  <IconInfoCircle
                                    color="white"
                                    filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                                    opacity={0.8}
                                    strokeWidth={2.5}
                                    size={26}
                                  />
                                </LegacyActionIcon>
                              </ImageMetaPopover2>
                            </div>
                          )}
                        </div>
                      )}
                    </ImageGuard2>
                  </Embla.Slide>
                ))}
                {viewMore && (
                  <Embla.Slide className="flex flex-[0_0_100%] items-center justify-center pl-3 @md:flex-[0_0_50%] @md:pl-6">
                    <div className="aspect-square w-full max-w-[450px]">
                      <Button
                        component={Link}
                        href={`/images?view=feed&periodMode=stats&modelVersionId=${modelVersionId}&userId=${userId}`}
                        rel="nofollow"
                        variant="outline"
                        fullWidth
                        className="size-full"
                        radius="md"
                      >
                        View more
                      </Button>
                    </div>
                  </Embla.Slide>
                )}
              </Embla.Container>
            </Embla.Viewport>
          </Embla>
        )}

        <Text size="xs" c="dimmed" mt="xs" mb="-xs">
          Images this user generated with this resource
        </Text>
      </Container>
    </div>
  );
}
