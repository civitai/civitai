import { Carousel } from '@mantine/carousel';
import { AspectRatio, Center, Grid, Loader, Text } from '@mantine/core';
import { ContextModalProps } from '@mantine/modals';

import CommentSection from '~/components/CommentSection/CommentSection';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { SensitiveContent } from '~/components/SensitiveContent/SensitiveContent';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ReviewGetAllItem } from '~/types/router';
import { trpc } from '~/utils/trpc';

export default function ReviewThreadModal({ innerProps }: ContextModalProps<Props>) {
  const { review, showNsfw = false } = innerProps;
  const mobile = useIsMobile();
  const { data: reviewDetails, isLoading } = trpc.review.getById.useQuery({ id: review.id });

  const hasImages = review.images.length > 0;
  const hasMultipleImages = review.images.length > 2;
  const firstImage = hasImages ? review.images[0] : undefined;

  const carousel = (
    <Carousel
      breakpoints={[{ minWidth: 'sm', slideSize: '50%', slideGap: 'xl' }]}
      align="center"
      slidesToScroll={mobile ? 1 : 2}
      withControls={hasMultipleImages}
      loop
    >
      {review.images.map((image) => (
        <Carousel.Slide key={image.id}>
          <Center style={{ height: '100%' }}>
            <ImagePreview
              image={image}
              edgeImageProps={{ width: 400 }}
              radius="md"
              lightboxImages={review.images}
              style={{ width: '100%' }}
              withMeta
            />
          </Center>
        </Carousel.Slide>
      ))}
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
                <AspectRatio ratio={16 / 9}>
                  {firstImage && <MediaHash {...firstImage} style={{ borderRadius: 8 }} />}
                </AspectRatio>
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
