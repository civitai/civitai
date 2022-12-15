import { Embla, useAnimationOffsetEffect, Carousel } from '@mantine/carousel';
import {
  Loader,
  Modal,
  Center,
  AspectRatio,
  Badge,
  Grid,
  Text,
  Group,
  Rating,
  Stack,
  CloseButton,
} from '@mantine/core';
import { useRef } from 'react';
import { z } from 'zod';
import CommentSection from '~/components/CommentSection/CommentSection';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { Media } from '~/components/Media/Media';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { daysFromNow } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const TRANSITION_DURATION = 200;

export default createRoutedContext({
  schema: z.object({
    reviewId: z.number(),
  }),
  Element: ({ context, props: { reviewId } }) => {
    const { data: review, isLoading: reviewLoading } = trpc.review.getDetail.useQuery({
      id: reviewId,
    });
    const { data: comments, isLoading: commentsLoading } = trpc.review.getReviewComments.useQuery({
      id: reviewId,
    });

    const emblaRef = useRef<Embla | null>(null);

    const isLoading = reviewLoading || commentsLoading;
    const hasImages = !!review?.images.length;
    const hasMultipleImages = hasImages && review.images.length > 1;
    const firstImage = hasImages ? review.images[0] : undefined;

    useAnimationOffsetEffect(emblaRef.current, TRANSITION_DURATION);

    const carousel = review && (
      <Carousel
        align="center"
        slidesToScroll={1}
        slideSize="100%"
        withControls={hasMultipleImages}
        getEmblaApi={(embla) => (emblaRef.current = embla)}
        loop
      >
        {review.images.map((image) => {
          return (
            <Carousel.Slide key={image.id}>
              <Center style={{ height: '100%' }}>
                <ImagePreview
                  image={image}
                  aspectRatio={0}
                  edgeImageProps={{ height: 400 }}
                  radius="md"
                  withMeta
                />
              </Center>
            </Carousel.Slide>
          );
        })}
      </Carousel>
    );

    return (
      <Modal opened={context.opened} onClose={context.close} withCloseButton={false} size={800}>
        {isLoading ? (
          <Center style={{ height: '300px' }}>
            <Loader />
          </Center>
        ) : (
          review && (
            <Stack>
              <Group position="apart" align="flex-start" noWrap>
                <Group spacing="xs" align="center">
                  <UserAvatar
                    user={review.user}
                    subText={daysFromNow(review.createdAt)}
                    size="lg"
                    spacing="xs"
                    withUsername
                  />
                  <Rating value={review.rating} fractions={2} readOnly />
                </Group>
                <CloseButton onClick={context.close} />
              </Group>
              <Grid gutter="xl">
                <Grid.Col span={12}>
                  <Text>{review?.text}</Text>
                </Grid.Col>
                {hasImages ? (
                  <Grid.Col span={12} sx={{ position: 'relative' }}>
                    <Media type="review" id={review.id} nsfw={review.nsfw}>
                      <Media.ToggleNsfw
                        placeholder={
                          <AspectRatio ratio={16 / 9} style={{ height: 400 }}>
                            {firstImage && (
                              <MediaHash {...firstImage} style={{ borderRadius: 8 }} />
                            )}
                          </AspectRatio>
                        }
                      />
                      <Media.Count count={review.images.length} />
                      <Media.Content>{carousel}</Media.Content>
                    </Media>
                  </Grid.Col>
                ) : null}
                {isLoading ? (
                  <Grid.Col span={12}>
                    <Center my="xl">
                      <Loader />
                    </Center>
                  </Grid.Col>
                ) : (
                  <Grid.Col span={12}>
                    {review && (
                      <CommentSection
                        comments={comments?.comments ?? []}
                        modelId={review.modelId}
                        reviewId={review.id}
                      />
                    )}
                  </Grid.Col>
                )}
              </Grid>
            </Stack>
          )
        )}
      </Modal>
    );
  },
});
