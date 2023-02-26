import { Carousel, Embla, useAnimationOffsetEffect } from '@mantine/carousel';
import {
  Alert,
  AspectRatio,
  Badge,
  Center,
  CloseButton,
  Grid,
  Group,
  Loader,
  Modal,
  Rating,
  Stack,
} from '@mantine/core';
import { useRef } from 'react';
import { z } from 'zod';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { CommentSection } from '~/components/CommentSection/CommentSection';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createRoutedContext } from '~/routed-context/create-routed-context';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import { ReviewDiscussionMenu } from '~/components/Model/ModelDiscussion/ReviewDiscussionMenu';
import { IconExclamationCircle } from '@tabler/icons';
import { AnchorNoTravel } from '~/components/AnchorNoTravel/AnchorNoTravel';

const TRANSITION_DURATION = 200;

export default createRoutedContext({
  schema: z.object({
    reviewId: z.number(),
    highlight: z.number().optional(),
  }),
  Element: ({ context, props: { reviewId, highlight } }) => {
    const router = useRouter();
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
      { enabled: !!review, initialData: review?.reactions }
    );
    const { data: model } = trpc.model.getById.useQuery(
      { id: review?.modelId ?? -1 },
      { enabled: !!review }
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
              deletedAt: null,
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

    useAnimationOffsetEffect(emblaRef.current, TRANSITION_DURATION);

    const handleNavigate = (imageId: number) => {
      router.push({
        pathname: `/gallery/${imageId}`,
        query: {
          reviewId,
          infinite: false,
          returnUrl: router.asPath,
        },
      });
    };

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
                  subText={<DaysFromNow date={review.createdAt} />}
                  subTextForce
                  badge={
                    review.user.id === model?.user.id ? (
                      <Badge size="xs" color="violet">
                        OP
                      </Badge>
                    ) : null
                  }
                  size="lg"
                  spacing="xs"
                  withUsername
                  linkToProfile
                />
                <Rating value={review.rating} fractions={2} readOnly />
              </Group>
              <Group spacing={4} noWrap>
                <ReviewDiscussionMenu review={review} user={currentUser} />
                <CloseButton onClick={context.close} />
              </Group>
            </Group>
            {currentUser?.isModerator && review.tosViolation && (
              <AlertWithIcon color="yellow" iconColor="yellow" icon={<IconExclamationCircle />}>
                This review has been marked with a TOS Violation. This is only visible for
                moderators.
              </AlertWithIcon>
            )}
            <Grid gutter="xl">
              <Grid.Col span={12}>
                {review?.text ? <RenderHtml html={review.text} /> : null}
              </Grid.Col>
              {hasImages ? (
                <Grid.Col span={12} sx={{ position: 'relative' }}>
                  <Carousel
                    align="center"
                    slidesToScroll={1}
                    slideSize="100%"
                    withControls={hasMultipleImages}
                    getEmblaApi={(embla) => (emblaRef.current = embla)}
                    loop
                  >
                    <ImageGuard
                      images={review.images}
                      nsfw={review.nsfw}
                      connect={{ entityType: 'review', entityId: review.id }}
                      render={(image) => {
                        const width = image.width ?? 1;
                        const height = image.height ?? 1;
                        const screenHeight = 400;
                        // const parsedWidth = width * (400 / width);
                        const parsedWidth = screenHeight * (width / height);
                        return (
                          <Carousel.Slide key={image.id}>
                            <Center style={{ height: '100%' }}>
                              <div
                                style={{
                                  position: 'relative',
                                  height: '100%',
                                  width: parsedWidth,
                                }}
                              >
                                <ImageGuard.ToggleConnect />
                                <ImageGuard.Unsafe>
                                  <AspectRatio
                                    ratio={(image.width ?? 1) / (image.height ?? 1)}
                                    sx={(theme) => ({
                                      height: '100%',
                                      borderRadius: theme.radius.md,
                                      overflow: 'hidden',
                                    })}
                                  >
                                    <MediaHash {...image} />
                                  </AspectRatio>
                                </ImageGuard.Unsafe>
                                <ImageGuard.Safe>
                                  <AnchorNoTravel
                                    href={`/gallery/${image.id}?reviewId=${
                                      review.id
                                    }&infinite=false&returnUrl=${encodeURIComponent(
                                      router.asPath
                                    )}`}
                                  >
                                    <ImagePreview
                                      image={image}
                                      aspectRatio={0}
                                      edgeImageProps={{ height: screenHeight }} // TODO Optimization: look at using width 400, since we already have that in cache
                                      radius="md"
                                      withMeta
                                      onClick={() => handleNavigate(image.id)}
                                    />
                                  </AnchorNoTravel>
                                </ImageGuard.Safe>
                              </div>
                            </Center>
                          </Carousel.Slide>
                        );
                      }}
                    />
                  </Carousel>
                </Grid.Col>
              ) : null}
              <Grid.Col span={12} py={0}>
                <ReactionPicker
                  reactions={reactions}
                  onSelect={(reaction) => toggleReactionMutation.mutate({ id: reviewId, reaction })}
                />
              </Grid.Col>
              <Grid.Col span={12}>
                <CommentSection
                  comments={comments}
                  modelId={review.modelId}
                  review={review}
                  highlights={highlight ? [highlight] : undefined}
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
