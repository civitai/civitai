import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  Badge,
  Box,
  Grid,
  Group,
  Image,
  LoadingOverlay,
  Menu,
  Paper,
  Rating,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { showNotification } from '@mantine/notifications';
import { IconDotsVertical, IconTrash, IconX } from '@tabler/icons';
import dayjs from 'dayjs';
import { useSession } from 'next-auth/react';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ReviewFilter } from '~/server/common/enums';
import { ReviewDetails } from '~/server/validators/reviews/getAllReviews';
import { ExtendedUser } from '~/types/next-auth';
import { trpc } from '~/utils/trpc';

export function ModelReviews({ items, loading = false }: Props) {
  const { data: session } = useSession();
  const queryUtils = trpc.useContext();

  const { mutate, isLoading } = trpc.review.delete.useMutation();
  const handleDeleteReview = (review: ReviewDetails) => {
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
      confirmProps: { color: 'red', loading: isLoading },
      closeOnConfirm: false,
      onConfirm: () => {
        mutate(
          { id: review.id },
          {
            onSuccess() {
              queryUtils.review.getAll.invalidate({ modelId: review.modelId });
              closeAllModals();
            },
            onError(error) {
              const message = error.message;

              showNotification({
                title: 'Could not delete review',
                message: `An error occurred while deleting the review: ${message}`,
                color: 'red',
                icon: <IconX size={18} />,
              });
            },
          }
        );
      },
    });
  };

  return (
    <Grid>
      <Grid.Col span={12} sx={{ position: 'relative' }}>
        <LoadingOverlay visible={loading} />
        {items.length > 0 ? (
          <SimpleGrid
            breakpoints={[
              { minWidth: 'sm', cols: 3 },
              { minWidth: 'md', cols: 4 },
            ]}
          >
            {items.map((review, index) => (
              <ReviewItem
                key={index}
                review={review}
                currentUser={session?.user}
                onDelete={handleDeleteReview}
              />
            ))}
          </SimpleGrid>
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

function ReviewItem({ review, currentUser, onDelete }: ItemProps) {
  const displayActions = currentUser?.id === review.user.id;

  return (
    <Paper radius="md" p="md" withBorder>
      <Stack spacing="xs">
        <Group align="flex-start" sx={{ justifyContent: 'space-between' }} noWrap>
          <Stack spacing={4}>
            <UserAvatar
              user={review.user}
              subText={`${dayjs(review.createdAt).fromNow()} - ${review.modelVersion?.name}`}
              withUsername
            />
            <Rating value={review.rating} fractions={2} readOnly />
          </Stack>
          {displayActions ? (
            <Menu position="bottom-end">
              <Menu.Target>
                <ActionIcon size="xs" variant="subtle">
                  <IconDotsVertical size={14} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  icon={<IconTrash size={14} stroke={1.5} />}
                  color="red"
                  onClick={() => onDelete(review)}
                >
                  Delete review
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          ) : null}
        </Group>
        {review.imagesOnReviews.length > 0 ? (
          <Box sx={{ position: 'relative' }}>
            <Carousel
              sx={(theme) => ({
                margin: `0 ${theme.spacing.md * -1}px`,
              })}
              loop
            >
              {review.imagesOnReviews.map(({ image }) => (
                <Carousel.Slide key={image.id}>
                  <Image
                    src={image.url}
                    alt={image.name ?? 'Visual representation of the user review'}
                  />
                </Carousel.Slide>
              ))}
            </Carousel>
            <Badge
              variant="filled"
              color="gray"
              size="sm"
              sx={(theme) => ({ position: 'absolute', top: theme.spacing.xs, right: 0 })}
            >
              {review.imagesOnReviews.length}
            </Badge>
            {review.nsfw ? (
              <Badge
                color="red"
                variant="filled"
                size="sm"
                sx={(theme) => ({ position: 'absolute', top: theme.spacing.xs, left: 0 })}
              >
                NSFW
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
  review: Props['items'][number];
  onDelete: (review: ReviewDetails) => void;
  currentUser?: ExtendedUser;
};
