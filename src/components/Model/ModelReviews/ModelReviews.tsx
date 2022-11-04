import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  AspectRatio,
  Badge,
  Box,
  Grid,
  Group,
  Image,
  LoadingOverlay,
  Menu,
  Paper,
  Rating,
  Stack,
  Text,
} from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { hideNotification, showNotification } from '@mantine/notifications';
import { ReportReason } from '@prisma/client';
import { IconDotsVertical, IconEyeOff, IconFlag, IconTrash } from '@tabler/icons';
import dayjs from 'dayjs';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ReviewFilter } from '~/server/common/enums';
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

type Props = {
  items: ReviewDetails[];
  onFilterChange: (values: ReviewFilter[]) => void;
  loading?: boolean;
};

function ReviewItem({ data: review }: ItemProps) {
  const { data: session } = useSession();
  const router = useRouter();
  const isOwner = session?.user?.id === review.user.id;
  const shouldBlur = session?.user?.blurNsfw;

  const [blurContent, setBlurContent] = useState(review.nsfw && shouldBlur);

  const queryUtils = trpc.useContext();
  const deleteMutation = trpc.review.delete.useMutation({
    onSuccess() {
      queryUtils.review.getAll.invalidate({ modelId: review.modelId });
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
    onSuccess() {
      queryUtils.review.getAll.invalidate({ modelId: review.modelId });
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
    if (!session) return router.push(`/login?returnUrl=${router.asPath}`);
    reportMutation.mutate({ id: review.id, reason });
  };

  const hasImages = review.imagesOnReviews.length > 0;
  const hasMultipleImages = review.imagesOnReviews.length > 1;
  const firstImage = hasImages ? review.imagesOnReviews[0].image : null;

  return (
    <Paper radius="md" p="md" withBorder>
      <Stack spacing="xs">
        <Stack spacing={4}>
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
                {isOwner ? (
                  <Menu.Item
                    icon={<IconTrash size={14} stroke={1.5} />}
                    color="red"
                    onClick={handleDeleteReview}
                  >
                    Delete review
                  </Menu.Item>
                ) : null}
                {!session || !isOwner ? (
                  <>
                    <Menu.Item
                      icon={<IconFlag size={14} stroke={1.5} />}
                      onClick={() => handleReportReview(ReportReason.NSFW)}
                    >
                      Report as NSFW
                    </Menu.Item>
                    <Menu.Item
                      icon={<IconFlag size={14} stroke={1.5} />}
                      onClick={() => handleReportReview(ReportReason.TOSViolation)}
                    >
                      Report as Terms Violation
                    </Menu.Item>
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
        {hasImages ? (
          <Box sx={{ position: 'relative' }}>
            {blurContent ? (
              <Box
                sx={(theme) => ({ position: 'relative', margin: `0 ${theme.spacing.md * -1}px` })}
              >
                <AspectRatio ratio={16 / 9}>
                  {firstImage ? <MediaHash {...firstImage} /> : null}
                  <Stack
                    align="center"
                    spacing={0}
                    sx={(theme) => ({
                      position: 'absolute',
                      padding: `0 ${theme.spacing.xs * 4}px`, // 40px horizontal padding
                    })}
                  >
                    <IconEyeOff size={20} color="white" />
                    <Text color="white">Sensitive Content</Text>
                    <Text size="xs" color="white" align="center">
                      This is marked as NSFW
                    </Text>
                  </Stack>
                </AspectRatio>
              </Box>
            ) : (
              <Carousel
                withControls={hasMultipleImages}
                draggable={hasMultipleImages}
                sx={(theme) => ({
                  margin: `0 ${theme.spacing.md * -1}px`,
                })}
                loop
              >
                {review.imagesOnReviews.map(({ image }) => (
                  <Carousel.Slide key={image.id}>
                    <AspectRatio ratio={16 / 9}>
                      <Image
                        src={image.url}
                        alt={image.name ?? 'Visual representation of the user review'}
                        sx={{ objectFit: 'cover', objectPosition: 'center' }}
                      />
                    </AspectRatio>
                  </Carousel.Slide>
                ))}
              </Carousel>
            )}
            {hasMultipleImages ? (
              <Badge
                variant="filled"
                color="gray"
                size="sm"
                sx={(theme) => ({ position: 'absolute', top: theme.spacing.xs, right: 0 })}
              >
                {review.imagesOnReviews.length}
              </Badge>
            ) : null}
            {review.nsfw && shouldBlur ? (
              <Badge
                color="red"
                variant="filled"
                size="sm"
                onClick={shouldBlur ? () => setBlurContent((value) => !value) : undefined}
                sx={(theme) => ({
                  position: 'absolute',
                  top: theme.spacing.xs,
                  left: 0,
                  userSelect: 'none',
                  cursor: shouldBlur ? 'pointer' : 'auto',
                })}
              >
                {blurContent ? 'Show' : 'Hide'}
              </Badge>
            ) : null}
          </Box>
        ) : null}
        <ContentClamp maxHeight={100}>
          <Text>{review.text}</Text>
        </ContentClamp>
      </Stack>
    </Paper>
  );
}

type ItemProps = {
  data: Props['items'][number];
};
