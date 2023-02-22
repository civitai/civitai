import { Carousel } from '@mantine/carousel';
import {
  Anchor,
  AspectRatio,
  Badge,
  Button,
  Card,
  Group,
  Rating,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { ReviewReactions } from '@prisma/client';
import { IconExclamationCircle, IconLock, IconMessageCircle2 } from '@tabler/icons';
import { useEffect, useState } from 'react';
import { useInView } from 'react-intersection-observer';

import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { ReviewGetAllItem } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import Router, { useRouter } from 'next/router';
import { ReviewDiscussionMenu } from '~/components/Model/ModelDiscussion/ReviewDiscussionMenu';
import { openRoutedContext } from '~/providers/RoutedContextProvider';
import { AnchorNoTravel } from '~/components/AnchorNoTravel/AnchorNoTravel';

export function ReviewDiscussionItem({ review, width }: Props) {
  // const { openContext } = useRoutedContext();
  const currentUser = useCurrentUser();
  const { ref, inView } = useInView();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (inView) setVisible(true);
  }, [inView]);

  const { data: reactions = [] } = trpc.review.getReactions.useQuery(
    { reviewId: review.id },
    { initialData: review.reactions }
  );
  const { data: commentCount = 0 } = trpc.review.getCommentsCount.useQuery(
    { id: review.id },
    { initialData: review._count.comments }
  );
  const { data: model } = trpc.model.getById.useQuery({ id: review.modelId });

  const queryUtils = trpc.useContext();

  const toggleReactionMutation = trpc.review.toggleReaction.useMutation({
    async onMutate({ id, reaction }) {
      await queryUtils.review.getReactions.cancel({ reviewId: id });

      const previousReactions = queryUtils.review.getReactions.getData({ reviewId: id }) ?? [];
      const latestReaction =
        previousReactions.length > 0 ? previousReactions[previousReactions.length - 1] : { id: 0 };

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
    onError(_error, variables, context) {
      queryUtils.review.getReactions.setData(
        { reviewId: variables.id },
        context?.previousReactions
      );
    },
  });
  const handleReactionClick = (reaction: ReviewReactions) => {
    toggleReactionMutation.mutate({ id: review.id, reaction });
  };

  const hasImages = review.images.length > 0;

  return (
    <Card radius="md" p="md" withBorder ref={ref}>
      <Stack spacing={4} mb="sm">
        <Group align="flex-start" position="apart" noWrap>
          <UserAvatar
            user={review.user}
            subText={
              <>
                <DaysFromNow date={review.createdAt} /> - {review.modelVersion?.name}
              </>
            }
            subTextForce
            badge={
              review.user.id === model?.user.id ? (
                <Badge size="xs" color="violet">
                  OP
                </Badge>
              ) : null
            }
            withUsername
            linkToProfile
          />
          <ReviewDiscussionMenu review={review} user={currentUser} hideLockOption />
        </Group>
        <Group position="apart">
          <Rating
            value={review.rating}
            fractions={2}
            size={!hasImages && !review.text ? 'xl' : undefined}
            sx={{ alignSelf: !hasImages && !review.text ? 'center' : undefined }}
            readOnly
          />
          {review.exclude && (
            <Badge size="xs" color="red">
              Excluded from average
            </Badge>
          )}
        </Group>
      </Stack>
      {hasImages && (
        <Card.Section mb="sm" style={{ position: 'relative', height: width }}>
          <ReviewCarousel
            key={review.id}
            review={review}
            inView={inView}
            height={width}
            visible={visible}
          />
        </Card.Section>
      )}

      {review.text ? (
        <ContentClamp maxHeight={100}>
          <RenderHtml html={review.text} sx={(theme) => ({ fontSize: theme.fontSizes.sm })} />
        </ContentClamp>
      ) : null}

      <Group mt="sm" align="flex-start" position="apart" noWrap>
        <ReactionPicker
          reactions={reactions}
          onSelect={handleReactionClick}
          disabled={toggleReactionMutation.isLoading}
        />
        <Group spacing={4} noWrap>
          {currentUser?.isModerator && review.tosViolation && (
            <Tooltip label="Has TOS Violation">
              <ThemeIcon color="orange" size="xs">
                <IconExclamationCircle />
              </ThemeIcon>
            </Tooltip>
          )}
          {review.locked && (
            <ThemeIcon color="yellow" size="xs">
              <IconLock />
            </ThemeIcon>
          )}
          <Button
            size="xs"
            radius="xl"
            variant="subtle"
            onClick={() => openRoutedContext('reviewThread', { reviewId: review.id })}
            compact
          >
            <Group spacing={2} noWrap>
              <IconMessageCircle2 size={14} />
              <Text>{abbreviateNumber(commentCount)}</Text>
            </Group>
          </Button>
        </Group>
      </Group>
    </Card>
  );
}

type Props = { review: ReviewGetAllItem; width: number };

function ReviewCarousel({
  review,
  inView,
  height,
  visible,
}: {
  review: ReviewGetAllItem;
  inView: boolean;
  height: number;
  visible: boolean;
}) {
  const [renderIndexes, setRenderIndexes] = useState([0]);
  const router = useRouter();

  const hasMultipleImages = review.images.length > 1;

  const handleNavigate = (imageId: number) => {
    openRoutedContext('galleryDetailModal', {
      galleryImageId: imageId,
      reviewId: review.id,
      infinite: false,
      returnUrl: Router.asPath,
    });
  };

  // this is used to keep content rendered while scrolling - carousel unmounted
  if (!inView && review.images.length > 0)
    return (
      <ImageGuard
        images={[review.images[0]]}
        connect={{ entityType: 'review', entityId: review.id }}
        nsfw={review.nsfw}
        render={(image, index) => (
          <div style={{ height, position: 'relative' }}>
            <ImageGuard.ToggleConnect />
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height }}>
              <AspectRatio
                ratio={1}
                sx={{
                  width: '100%',
                  overflow: 'hidden',
                }}
              >
                <MediaHash {...image} cropFocus="top" />
              </AspectRatio>
            </div>
            <ImageGuard.Safe>
              {inView && renderIndexes.includes(index) && (
                <ImagePreview
                  image={image}
                  edgeImageProps={{ width: 400 }}
                  aspectRatio={1}
                  onClick={() => handleNavigate(image.id)}
                  cropFocus="top"
                  withMeta
                />
              )}
            </ImageGuard.Safe>
          </div>
        )}
      />
    );

  return (
    <div style={{ position: 'relative' }}>
      <Carousel
        withControls={hasMultipleImages}
        draggable={hasMultipleImages}
        loop
        style={{ height }}
        onSlideChange={(index) => {
          setRenderIndexes((indexes) => (!indexes.includes(index) ? [...indexes, index] : indexes));
        }}
        withIndicators={hasMultipleImages}
        controlSize={32}
        styles={{
          indicators: {
            bottom: 8,
          },
          indicator: {
            width: 16,
            height: 8,
            transition: 'width 250ms ease',
          },
        }}
      >
        <ImageGuard
          images={review.images}
          connect={{ entityType: 'review', entityId: review.id }}
          nsfw={review.nsfw}
          render={(image, index) => (
            <Carousel.Slide style={{ height }}>
              <ImageGuard.ToggleConnect />
              <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height }}>
                <AspectRatio
                  ratio={1}
                  sx={{
                    width: '100%',
                    overflow: 'hidden',
                  }}
                >
                  <MediaHash {...image} cropFocus="top" />
                </AspectRatio>
              </div>
              <ImageGuard.Safe>
                {visible && inView && renderIndexes.includes(index) && (
                  <AnchorNoTravel
                    href={`/gallery/${image.id}?reviewId=${
                      review.id
                    }&infinite=false&returnUrl=${encodeURIComponent(router.asPath)}`}
                  >
                    <ImagePreview
                      image={image}
                      edgeImageProps={{ width: 400 }}
                      aspectRatio={1}
                      onClick={() => handleNavigate(image.id)}
                      cropFocus="top"
                      withMeta
                    />
                  </AnchorNoTravel>
                )}
                <ImageGuard.ReportNSFW />
              </ImageGuard.Safe>
            </Carousel.Slide>
          )}
        />
      </Carousel>
    </div>
  );
}
