import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  AspectRatio,
  Badge,
  Button,
  Card,
  Group,
  Menu,
  Rating,
  Stack,
  Text,
} from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { ReviewReactions } from '@prisma/client';
import {
  IconDotsVertical,
  IconTrash,
  IconEdit,
  IconFlag,
  IconMessageCircle2,
  IconCalculatorOff,
  IconCalculator,
} from '@tabler/icons';

import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useRoutedContext } from '~/routed-context/routed-context.provider';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { ReportEntity } from '~/server/schema/report.schema';
import { ReviewGetAllItem } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { ShowHide } from '~/components/ShowHide/ShowHide';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { useInView } from 'react-intersection-observer';
import { useEffect, useState } from 'react';

export function ReviewDiscussionItem({ review, width }: Props) {
  const { openContext } = useRoutedContext();
  const currentUser = useCurrentUser();
  const isOwner = currentUser?.id === review.user.id;
  const isMod = currentUser?.isModerator ?? false;
  const { ref, inView } = useInView({ triggerOnce: true });
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
  const deleteMutation = trpc.review.delete.useMutation({
    async onSuccess() {
      await queryUtils.review.getAll.invalidate();
      closeAllModals();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not delete review',
      });
    },
  });
  const handleDeleteReview = () => {
    openConfirmModal({
      title: 'Delete Review',
      children: (
        <Text size="sm">
          Are you sure you want to delete this review? This action is destructive and cannot be
          reverted.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete Review', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: deleteMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => {
        deleteMutation.mutate({ id: review.id });
      },
    });
  };

  const excludeMutation = trpc.review.toggleExclude.useMutation({
    async onSuccess() {
      await queryUtils.review.getAll.invalidate();
      closeAllModals();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not exclude review',
      });
    },
  });
  const handleExcludeReview = () => {
    openConfirmModal({
      title: 'Exclude Review',
      children: (
        <Text size="sm">
          Are you sure you want to exclude this review from the average score of this model? You
          will not be able to revert this.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Exclude Review', cancel: "No, don't exclude it" },
      confirmProps: { color: 'red', loading: deleteMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => {
        excludeMutation.mutate({ id: review.id });
      },
    });
  };
  const handleUnexcludeReview = () => {
    excludeMutation.mutate({ id: review.id });
  };

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
  const hasMultipleImages = review.images.length > 1;

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
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon size="xs" variant="subtle">
                <IconDotsVertical size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {(isOwner || isMod) && (
                <>
                  <Menu.Item
                    icon={<IconTrash size={14} stroke={1.5} />}
                    color="red"
                    onClick={handleDeleteReview}
                  >
                    Delete review
                  </Menu.Item>
                  <Menu.Item
                    icon={<IconEdit size={14} stroke={1.5} />}
                    onClick={() => openContext('reviewEdit', { reviewId: review.id })}
                  >
                    Edit review
                  </Menu.Item>
                  {!review.exclude && (
                    <Menu.Item
                      icon={<IconCalculatorOff size={14} stroke={1.5} />}
                      onClick={handleExcludeReview}
                    >
                      Exclude from average
                    </Menu.Item>
                  )}
                  {isMod && review.exclude && (
                    <Menu.Item
                      icon={<IconCalculator size={14} stroke={1.5} />}
                      onClick={handleUnexcludeReview}
                    >
                      Unexclude from average
                    </Menu.Item>
                  )}
                </>
              )}
              {(!currentUser || !isOwner) && (
                <LoginRedirect reason="report-model">
                  <Menu.Item
                    icon={<IconFlag size={14} stroke={1.5} />}
                    onClick={() =>
                      openContext('report', { type: ReportEntity.Review, entityId: review.id })
                    }
                  >
                    Report
                  </Menu.Item>
                </LoginRedirect>
              )}
            </Menu.Dropdown>
          </Menu>
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
          <ReviewCarousel review={review} inView={visible} height={width} />
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
        <Button
          size="xs"
          radius="xl"
          variant="subtle"
          onClick={() => openContext('reviewThread', { reviewId: review.id })}
          compact
        >
          <Group spacing={2} noWrap>
            <IconMessageCircle2 size={14} />
            <Text>{abbreviateNumber(commentCount)}</Text>
          </Group>
        </Button>
      </Group>
    </Card>
  );
}

type Props = { review: ReviewGetAllItem; width: number };

function ReviewCarousel({
  review,
  inView,
  height,
}: {
  review: ReviewGetAllItem;
  inView: boolean;
  height: number;
}) {
  const { openContext } = useRoutedContext();
  const [renderImages, setRenderImages] = useState([review.images[0].id]);

  const hasMultipleImages = review.images.length > 1;

  return (
    <Carousel
      withControls={hasMultipleImages}
      draggable={hasMultipleImages}
      loop
      style={{ height: '100%' }}
      onSlideChange={(index) => {
        const image = review.images[index];
        setRenderImages((ids) => (!ids.includes(image.id) ? [...ids, image.id] : ids));
      }}
    >
      <ImageGuard
        images={review.images}
        connect={{ entityType: 'review', entityId: review.id }}
        nsfw={review.nsfw}
        render={(image, index) => (
          <Carousel.Slide style={{ height }}>
            <ImageGuard.ToggleConnect>{ShowHide}</ImageGuard.ToggleConnect>
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height }}>
              <AspectRatio
                ratio={1}
                sx={{
                  width: '100%',
                  overflow: 'hidden',
                }}
              >
                <MediaHash {...image} />
              </AspectRatio>
            </div>
            <ImageGuard.Safe>
              {inView && renderImages.includes(image.id) && (
                <ImagePreview
                  image={image}
                  edgeImageProps={{ width: 400 }}
                  aspectRatio={1}
                  onClick={() =>
                    openContext('reviewLightbox', {
                      initialSlide: index,
                      reviewId: review.id,
                    })
                  }
                  withMeta
                />
              )}
            </ImageGuard.Safe>
          </Carousel.Slide>
        )}
      />
    </Carousel>
  );
}
