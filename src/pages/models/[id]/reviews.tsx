import {
  Alert,
  Badge,
  Card,
  Center,
  Container,
  Divider,
  Grid,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Paper,
  Rating,
  Select,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useRouter } from 'next/router';
import { IconLock, IconMessage, IconMessageCircleOff, IconPhoto } from '@tabler/icons';

import { BackButton } from '~/components/BackButton/BackButton';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { EditUserResourceReview } from '~/components/ResourceReview/EditUserResourceReview';
import { ResourceReviewMenu } from '~/components/ResourceReview/ResourceReviewMenu';
import { ResourceReviewSummary } from '~/components/ResourceReview/Summary/ResourceReviewSummary';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { getResourceReviewPagedSchema } from '~/server/schema/resourceReview.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ResourceReviewPagedModel } from '~/types/router';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const params = (ctx.params ?? {}) as { id: string };
    const result = getResourceReviewPagedSchema.safeParse({ modelId: params.id, ...ctx.query });
    if (!result.success) return { notFound: true };

    const { modelId, modelVersionId } = result.data;

    await Promise.all([
      ssg?.resourceReview.getPaged.prefetch(result.data),
      ssg?.model.getSimple.prefetch({ id: modelId }),
      ssg?.model.getVersions.prefetch({ id: modelId }),
      ssg?.resourceReview.getRatingTotals.prefetch({ modelId, modelVersionId }),
    ]);
  },
});

export default function ModelReviews() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const queryParams = getResourceReviewPagedSchema.parse({
    modelId: router.query.id,
    ...router.query,
  });
  const { modelId, modelVersionId, page } = queryParams;
  const isMuted = currentUser?.muted ?? false;

  const { data: model, isLoading: loadingModel } = trpc.model.getSimple.useQuery({
    id: modelId,
  });
  const { data: versions, isLoading: loadingVersions } = trpc.model.getVersions.useQuery({
    id: modelId,
  });
  const {
    data: resourceReviews,
    isLoading: loadingResourceReviews,
    isRefetching: refetchingResourceReviews,
  } = trpc.resourceReview.getPaged.useQuery(queryParams, { keepPreviousData: true });

  const {
    data: currentUserReview,
    isLoading: loadingCurrentUserReview,
    isRefetching: refetchingCurrentUserReview,
  } = trpc.resourceReview.getUserResourceReview.useQuery(
    { modelVersionId: modelVersionId ?? 0 },
    { enabled: !!currentUser && !isMuted && !!modelVersionId }
  );

  const handleModelVersionChange = (value: string | null) => {
    router.replace(
      {
        query: removeEmpty({
          ...router.query,
          modelVersionId: value ? Number(value) : undefined,
          page: 1,
        }),
      },
      undefined,
      { shallow: true }
    );
  };

  const handlePaginationChange = (page: number) => {
    router.replace({ query: { ...router.query, page } }, undefined, { shallow: true });
  };

  const Model = loadingModel ? (
    <Skeleton height={44} />
  ) : (
    <Group spacing="xs">
      <BackButton url={`/models/${modelId}?modelVersionId=${modelVersionId}`} />
      <Title>{model?.name}</Title>
    </Group>
  );
  const Versions = loadingVersions ? (
    <Skeleton height={36} />
  ) : !!versions?.length ? (
    <Select
      placeholder="Showing all versions"
      clearable={versions && versions.length > 1}
      data={versions.map((version) => ({ label: version.name, value: version.id.toString() }))}
      value={(router.query.modelVersionId as string) ?? null}
      onChange={handleModelVersionChange}
    />
  ) : null;

  const UserReview = !currentUser ? (
    <Alert>You must be logged in to leave a review</Alert>
  ) : !modelVersionId ? (
    <Alert>Select a model version to leave a review</Alert>
  ) : loadingCurrentUserReview || refetchingCurrentUserReview ? (
    <Center p="xl">
      <Loader />
    </Center>
  ) : (
    <Stack spacing={4}>
      <Text weight={500}>Leave a review</Text>
      <EditUserResourceReview
        modelId={modelId}
        modelName={model?.name}
        modelVersionId={modelVersionId}
        resourceReview={currentUserReview}
      />
    </Stack>
  );

  const Summary = (
    <ResourceReviewSummary modelVersionId={modelVersionId} modelId={modelId}>
      <ResourceReviewSummary.Header />
      <ResourceReviewSummary.Totals />
    </ResourceReviewSummary>
  );

  return (
    <Container size="md">
      {Model}
      <Divider my="md" />
      {model?.locked ? (
        <Paper p="lg" withBorder bg={`rgba(0,0,0,0.1)`}>
          <Center>
            <Group spacing="xs">
              <ThemeIcon color="gray" size="xl" radius="xl">
                <IconMessageCircleOff />
              </ThemeIcon>
              <Text size="lg" color="dimmed">
                Reviews are turned off for this model.
              </Text>
            </Group>
          </Center>
        </Paper>
      ) : (
        <Grid gutter="xl">
          <Grid.Col sm={12} md={4}>
            <Stack>
              {Versions}
              {Summary}
              {!isMuted ? (
                UserReview
              ) : (
                <Alert color="yellow" icon={<IconLock />}>
                  You cannot add reviews because you have been muted
                </Alert>
              )}
            </Stack>
          </Grid.Col>
          <Grid.Col sm={12} md={8}>
            {loadingResourceReviews ? (
              <Center p="xl">
                <Loader />
              </Center>
            ) : (
              <Stack spacing="xl" style={{ position: 'relative' }}>
                <LoadingOverlay visible={refetchingResourceReviews} />
                {resourceReviews?.items.map((review) => (
                  <ReviewCard key={review.id} creatorId={model?.user.id} {...review} />
                ))}
                {resourceReviews && resourceReviews.totalPages > 1 && (
                  <Pagination
                    page={page}
                    onChange={handlePaginationChange}
                    total={resourceReviews.totalPages}
                  />
                )}
              </Stack>
            )}
          </Grid.Col>
        </Grid>
      )}
    </Container>
  );
}

function ReviewCard({ creatorId, ...review }: ResourceReviewPagedModel & { creatorId?: number }) {
  const isCreator = creatorId === review.user.id;

  return (
    <Card withBorder shadow="sm">
      <Stack key={review.id} spacing={4}>
        <Group position="apart" noWrap>
          <UserAvatar
            user={review.user}
            subText={
              <>
                <DaysFromNow date={review.createdAt} /> - {review.modelVersion.name}
              </>
            }
            subTextForce
            size="md"
            spacing="xs"
            withUsername
            linkToProfile
          />
          <ResourceReviewMenu
            reviewId={review.id}
            userId={review.user.id}
            review={{
              ...review,
              details: review.details ?? undefined,
              modelVersionId: review.modelVersion.id,
            }}
          />
        </Group>
        <Group spacing="xs">
          <Rating value={review.rating} readOnly />

          <RoutedContextLink
            modal="resourceReviewModal"
            reviewId={review.id}
            style={{ display: 'flex' }}
          >
            <Badge
              px={4}
              leftSection={
                <Center>
                  <IconPhoto size={14} />
                </Center>
              }
            >
              {review.helper?.imageCount ?? '0'}
            </Badge>
          </RoutedContextLink>

          <RoutedContextLink
            modal="resourceReviewModal"
            reviewId={review.id}
            style={{ display: 'flex' }}
          >
            <Badge
              px={4}
              leftSection={
                <Center>
                  <IconMessage size={14} />
                </Center>
              }
            >
              {review.thread?._count.comments ?? '0'}
            </Badge>
          </RoutedContextLink>
          {(review.exclude || isCreator) && <Badge color="red">Excluded from average</Badge>}
        </Group>
        {review.details && (
          <ContentClamp maxHeight={300}>
            <RenderHtml html={review.details} />
          </ContentClamp>
        )}
      </Stack>
    </Card>
  );
}
