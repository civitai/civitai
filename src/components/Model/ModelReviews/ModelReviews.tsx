import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  AspectRatio,
  Badge,
  Card,
  Grid,
  Group,
  LoadingOverlay,
  Menu,
  Paper,
  Rating,
  Stack,
  Text,
} from '@mantine/core';
import { closeAllModals, openConfirmModal, openContextModal } from '@mantine/modals';
import { hideNotification, showNotification } from '@mantine/notifications';
import { ReportReason, ReviewReactions } from '@prisma/client';
import { IconDotsVertical, IconEdit, IconFlag, IconTrash } from '@tabler/icons';
import dayjs from 'dayjs';
import { useSession } from 'next-auth/react';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { SensitiveContent } from '~/components/SensitiveContent/SensitiveContent';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ReviewFilter } from '~/server/common/enums';
import { ImageModel } from '~/server/validators/image/selectors';
import { ReviewDetails } from '~/server/validators/reviews/getAllReviews';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function ModelReviews({ items, loading = false }: Props) {
  return (
    <Grid>
      <Grid.Col span={12} sx={{ position: 'relative' }}>
        <LoadingOverlay visible={loading} />
        {items.length > 0 ? (
          <MasonryGrid items={items} render={ReviewItem} />
        ) : (
          <Paper p="xl" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Stack>
              <Text size="xl">There are no reviews for this model yet.</Text>
              <Text color="dimmed">
                Be the first to let the people know about this model by leaving your review.
              </Text>
            </Stack>
          </Paper>
        )}
      </Grid.Col>
    </Grid>
  );
}

type ModReviewDetails = Omit<ReviewDetails, 'imagesOnReviews'> & {
  images: ImageModel[];
};

type Props = {
  items: ModReviewDetails[];
  onFilterChange: (values: ReviewFilter[]) => void;
  loading?: boolean;
};

function ReviewItem({ data: review }: ItemProps) {
  const { data: session } = useSession();
  const isOwner = session?.user?.id === review.user.id;
  const isMod = session?.user?.isModerator ?? false;

  const queryUtils = trpc.useContext();
  const deleteMutation = trpc.review.delete.useMutation({
    async onSuccess() {
      await queryUtils.review.getAll.invalidate({ modelId: review.modelId });
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
          Are you sure you want to delete this model? This action is destructive and cannot be
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

  const reportMutation = trpc.review.report.useMutation({
    onMutate() {
      showNotification({
        id: 'sending-review-report',
        loading: true,
        disallowClose: true,
        autoClose: false,
        message: 'Sending report...',
      });
    },
    async onSuccess() {
      await queryUtils.review.getAll.invalidate({ modelId: review.modelId });
      showSuccessNotification({
        title: 'Review reported',
        message: 'Your request has been received',
      });
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Unable to send report',
        reason: 'An unexpected error occurred, please try again',
      });
    },
    onSettled() {
      hideNotification('sending-review-report');
    },
  });
  const handleReportReview = (reason: ReportReason) => {
    reportMutation.mutate({ id: review.id, reason });
  };

  const toggleReactionMutation = trpc.review.toggleReaction.useMutation({
    async onSuccess() {
      await queryUtils.review.getAll.invalidate({ modelId: review.modelId });
    },
  });
  const handleReactionClick = (reaction: ReviewReactions) => {
    toggleReactionMutation.mutate({ id: review.id, reaction });
  };

  const hasImages = review.images.length > 0;
  const hasMultipleImages = review.images.length > 1;
  const firstImage = hasImages ? review.images[0] : undefined;

  const carousel = (
    <Carousel withControls={hasMultipleImages} draggable={hasMultipleImages} loop>
      {review.images.map((image) => (
        <Carousel.Slide key={image.id}>
          <ImagePreview
            image={image}
            edgeImageProps={{ width: 400 }}
            aspectRatio={1}
            lightboxImages={review.images.map((image) => image)}
            withMeta
          />
        </Carousel.Slide>
      ))}
    </Carousel>
  );

  return (
    <Card radius="md" p="md" withBorder>
      <Stack spacing={4} mb="sm">
        <Group align="flex-start" sx={{ justifyContent: 'space-between' }} noWrap>
          <UserAvatar
            user={review.user}
            subText={`${dayjs(review.createdAt).fromNow()} - ${review.modelVersion?.name}`}
            withUsername
          />
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon size="xs" variant="subtle">
                <IconDotsVertical size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {isOwner || isMod ? (
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
                    onClick={() =>
                      openContextModal({
                        modal: 'reviewEdit',
                        title: `Editing review`,
                        closeOnClickOutside: false,
                        innerProps: { review },
                      })
                    }
                  >
                    Edit review
                  </Menu.Item>
                </>
              ) : null}
              {!session || !isOwner ? (
                <>
                  <LoginRedirect reason="report-review">
                    <Menu.Item
                      icon={<IconFlag size={14} stroke={1.5} />}
                      onClick={() => handleReportReview(ReportReason.NSFW)}
                    >
                      Report as NSFW
                    </Menu.Item>
                  </LoginRedirect>
                  <LoginRedirect reason="report-review">
                    <Menu.Item
                      icon={<IconFlag size={14} stroke={1.5} />}
                      onClick={() => handleReportReview(ReportReason.TOSViolation)}
                    >
                      Report as Terms Violation
                    </Menu.Item>
                  </LoginRedirect>
                </>
              ) : null}
            </Menu.Dropdown>
          </Menu>
        </Group>
        <Rating
          value={review.rating}
          fractions={2}
          size={!hasImages && !review.text ? 'xl' : undefined}
          sx={{ alignSelf: !hasImages && !review.text ? 'center' : undefined }}
          readOnly
        />
      </Stack>
      {hasImages && (
        <Card.Section mb="sm" style={{ position: 'relative' }}>
          {review.nsfw ? (
            <SensitiveContent
              controls={<SensitiveContent.Toggle my="xs" mx="md" />}
              placeholder={
                <AspectRatio ratio={1}>{firstImage && <MediaHash {...firstImage} />}</AspectRatio>
              }
            >
              {carousel}
            </SensitiveContent>
          ) : (
            carousel
          )}
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
        </Card.Section>
      )}

      <ContentClamp maxHeight={100}>
        <Text>{review.text}</Text>
      </ContentClamp>

      <ReactionPicker
        reactions={review.reactions}
        onSelect={handleReactionClick}
        disabled={toggleReactionMutation.isLoading}
      />
    </Card>
  );
}

type ItemProps = {
  data: Props['items'][number];
};
