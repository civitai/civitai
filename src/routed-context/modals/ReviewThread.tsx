import { Embla, useAnimationOffsetEffect, Carousel } from '@mantine/carousel';
import {
  Loader,
  Modal,
  Center,
  AspectRatio,
  Grid,
  Text,
  Group,
  Rating,
  Stack,
  CloseButton,
  Alert,
} from '@mantine/core';
import { useRef } from 'react';
import { z } from 'zod';

import CommentSection from '~/components/CommentSection/CommentSection';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { SFW } from '~/components/Media/SFW';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { daysFromNow } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const TRANSITION_DURATION = 200;

export default createRoutedContext({
  schema: z.object({
    reviewId: z.number(),
    commentId: z.number().optional(),
  }),
  Element: ({ context, props: { reviewId, commentId } }) => {
    const queryUtils = trpc.useContext();
    const currentUser = useCurrentUser();

    const emblaRef = useRef<Embla | null>(null);

    const { data: review, isLoading: reviewLoading } = trpc.review.getDetail.useQuery({
      id: reviewId,
    });
    const { data: comments = [], isLoading: commentsLoading } =
      trpc.review.getCommentsById.useQuery({
        id: reviewId,
      });
    const { data: reactions = [] } = trpc.review.getReactions.useQuery(
      { reviewId },
      { enabled: !!review, initialData: review?.reactions ?? [] }
    );

    const toggleReactionMutation = trpc.review.toggleReaction.useMutation({
      async onMutate({ id, reaction }) {
        await queryUtils.review.getReactions.cancel({ reviewId });

        const previousReactions = queryUtils.review.getReactions.getData({ reviewId }) ?? [];
        const latestReaction =
          previousReactions.length > 0
            ? previousReactions[previousReactions.length - 1]
            : { id: 0 };

        if (currentUser) {
          const newReaction: ReactionDetails = {
            id: latestReaction.id + 1,
            reaction,
            user: {
              id: currentUser.id,
              name: currentUser.name ?? '',
              username: currentUser.username ?? '',
              image: currentUser.image ?? '',
            },
          };
          const reacted = previousReactions.find(
            (r) => r.reaction === reaction && r.user.id === currentUser.id
          );
          queryUtils.review.getReactions.setData({ reviewId: id }, (old = []) =>
            reacted
              ? old.filter((oldReaction) => oldReaction.id !== reacted.id)
              : [...old, newReaction]
          );
        }

        return { previousReactions };
      },
      onError(_error, _variables, context) {
        queryUtils.review.getReactions.setData({ reviewId }, context?.previousReactions);
      },
    });

    const loading = reviewLoading || commentsLoading;
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
        {loading ? (
          <Center style={{ height: '300px' }}>
            <Loader />
          </Center>
        ) : review ? (
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
                <Stack>
                  <Text>{review?.text}</Text>
                  <ReactionPicker
                    reactions={reactions}
                    onSelect={(reaction) =>
                      toggleReactionMutation.mutate({ id: reviewId, reaction })
                    }
                  />
                </Stack>
              </Grid.Col>
              {hasImages ? (
                <Grid.Col span={12} sx={{ position: 'relative' }}>
                  <SFW type="review" id={review.id} nsfw={review.nsfw}>
                    <SFW.ToggleNsfw
                      placeholder={
                        <AspectRatio ratio={16 / 9} style={{ height: 400 }}>
                          {firstImage && <MediaHash {...firstImage} style={{ borderRadius: 8 }} />}
                        </AspectRatio>
                      }
                    />
                    <SFW.Count count={review.images.length} />
                    <SFW.Content>{carousel}</SFW.Content>
                  </SFW>
                </Grid.Col>
              ) : null}
              <Grid.Col span={12}>
                <CommentSection
                  comments={comments}
                  modelId={review.modelId}
                  reviewId={review.id}
                  highlights={commentId ? [commentId] : undefined}
                />
              </Grid.Col>
            </Grid>
          </Stack>
        ) : (
          <Alert>Review could not be found</Alert>
        )}
      </Modal>
    );
  },
});
