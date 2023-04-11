import {
  Container,
  Select,
  Skeleton,
  Stack,
  Title,
  Text,
  Grid,
  Rating,
  Divider,
  Group,
  Badge,
  Center,
  Pagination,
  LoadingOverlay,
  Card,
  Alert,
  Loader,
} from '@mantine/core';
import { useRouter } from 'next/router';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ResourceReviewSummary } from '~/components/ResourceReview/Summary/ResourceReviewSummary';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { getResourceReviewPagedSchema } from '~/server/schema/resourceReview.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { IconPhoto, IconMessage } from '@tabler/icons';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ResourceReviewPagedModel } from '~/types/router';
import { EditUserResourceReview } from '~/components/ResourceReview/EditUserResourceReview';
import { ResourceReviewMenu } from '~/components/ResourceReview/ResourceReviewMenu';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';

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
    { enabled: !!currentUser && !!modelVersionId }
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

  const Model = loadingModel ? <Skeleton height={44} /> : <Title>{model?.name}</Title>;
  const Versions = loadingVersions ? (
    <Skeleton height={36} />
  ) : !!versions?.length ? (
    <Select
      placeholder="Showing all versions"
      clearable={versions && versions.length > 1}
      data={versions.map((version) => ({ label: version.name, value: version.id.toString() }))}
      value={(router.query.modelVersionId as string) ?? null}
      onChange={handleModelVersionChange}
      // variant="unstyled"
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
      <Grid gutter="xl">
        <Grid.Col sm={12} md={4}>
          <Stack>
            {Versions}
            {Summary}
            {UserReview}
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
                <ReviewCard key={review.id} {...review} />
              ))}
              {resourceReviews && (
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
    </Container>
  );
}

function ReviewCard(review: ResourceReviewPagedModel) {
  // TODO - add version name next to days ago
  const currentUser = useCurrentUser();
  const isOwnerOrModerator =
    (currentUser?.id === review.user.id || currentUser?.isModerator) ?? false;
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
          {review.exclude && <Badge color="red">Excluded from average</Badge>}
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
