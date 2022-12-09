import { Carousel, Embla, useAnimationOffsetEffect } from '@mantine/carousel';
import { AspectRatio, Center, Grid, Loader, Text, Badge } from '@mantine/core';
import { ContextModalProps } from '@mantine/modals';
import { useRef } from 'react';

import CommentSection from '~/components/CommentSection/CommentSection';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { SensitiveContent } from '~/components/SensitiveContent/SensitiveContent';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ReviewGetAllItem } from '~/types/router';
import { trpc } from '~/utils/trpc';

const TRANSITION_DURATION = 200;

export default function ReviewThreadModal({ innerProps }: ContextModalProps<Props>) {
  const { review, showNsfw = false } = innerProps;
  const mobile = useIsMobile();
  // const { openImageLightbox } = useImageLightbox({ withRouter: false });

  const emblaRef = useRef<Embla | null>(null);

  const { data: reviewDetails, isLoading } = trpc.review.getById.useQuery({ id: review.id });

  const hasImages = review.images.length > 0;
  const hasMultipleImages = review.images.length > 1;
  const firstImage = hasImages ? review.images[0] : undefined;

  useAnimationOffsetEffect(emblaRef.current, TRANSITION_DURATION);

  const carousel = (
    <Carousel
      align="center"
      slidesToScroll={1}
      withControls={hasMultipleImages}
      getEmblaApi={(embla) => (emblaRef.current = embla)}
      loop
    >
      {review.images.map((image, index) => {
        return (
          <Carousel.Slide key={image.id}>
            <Center>
              <ImagePreview
                image={image}
                aspectRatio={0}
                edgeImageProps={{ width: 400 }}
                radius="md"
                withMeta
                style={{ height: 400 }}
              />
            </Center>
          </Carousel.Slide>
        );
      })}
    </Carousel>
  );

  return (
    <Grid gutter="xl">
      <Grid.Col span={12}>
        <Text>{review?.text}</Text>
      </Grid.Col>
      {hasImages ? (
        <Grid.Col span={12} sx={{ position: 'relative' }}>
          {review.nsfw && !showNsfw ? (
            <SensitiveContent
              controls={<SensitiveContent.Toggle my="xs" mx="md" />}
              placeholder={
                <>
                  <AspectRatio ratio={16 / 9} style={{ height: 400 }}>
                    {firstImage && <MediaHash {...firstImage} style={{ borderRadius: 8 }} />}
                  </AspectRatio>
                  {hasMultipleImages && (
                    <Badge
                      variant="filled"
                      color="gray"
                      size="sm"
                      sx={(theme) => ({
                        position: 'absolute',
                        top: theme.spacing.xs,
                        right: theme.spacing.md,
                      })}
                    >
                      {review.images.length}
                    </Badge>
                  )}
                </>
              }
            >
              {carousel}
            </SensitiveContent>
          ) : (
            carousel
          )}
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
          <CommentSection
            comments={reviewDetails?.comments ?? []}
            modelId={review.modelId}
            reviewId={review.id}
          />
        </Grid.Col>
      )}
    </Grid>
  );
}

type Props = {
  review: ReviewGetAllItem;
  showNsfw?: boolean;
};
