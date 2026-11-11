import { keepPreviousData } from '@tanstack/react-query';
import {
  Alert,
  Card,
  Center,
  Container,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Paper,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconLock, IconMessageCircleOff } from '@tabler/icons-react';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BackButton } from '~/components/BackButton/BackButton';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { Meta } from '~/components/Meta/Meta';
import {
  EditUserResourceReviewV2,
  UserResourceReviewComposite,
} from '~/components/ResourceReview/EditUserResourceReview';
import {
  getModelReviewsCanonical,
  getModelReviewsRedirect,
  getModelReviewsVersionRedirect,
  getReviewsFilterInput,
  parseReviewsFilter,
  resolveReviewsVersion,
} from '~/components/ResourceReview/model-reviews-url';
import { ResourceReviewThumbActions } from '~/components/ResourceReview/ResourceReviewThumbActions';
import { getAverageRating, getRatingCount } from '~/components/ResourceReview/resourceReview.utils';
import { ReviewCardWithImages } from '~/components/ResourceReview/ReviewCard/ReviewCardWithImages';
import { ReviewsPager } from '~/components/ResourceReview/ReviewCard/ReviewsPager';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getResourceReviewPagedSchema } from '~/server/schema/resourceReview.schema';
import { getDefaultModelVersion } from '~/server/services/model-version.service';
import { getServerBrowsingLevel } from '~/server/utils/browsing-level';
import { TRPCError } from '@trpc/server';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { getRatingSummary } from '~/utils/rating-label';
import { getModelUrl } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

// Only a missing model or version reads as "no version"; any other lookup error must surface,
// not redirect away from a valid version or cache a 404.
const nullIfNotFound = (error: unknown) => {
  if (error instanceof TRPCError && error.code === 'NOT_FOUND') return null;
  throw error;
};

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg, session, features }) => {
    const params = (ctx.params ?? {}) as { id: string };

    // Redirect near-duplicate review URLs (review dialogs, stray reviewId, escaped-`&` loops, a
    // malformed version param) to the clean reviews page. Runs before the query is validated so a
    // malformed version param is redirected rather than 404'd.
    if (/^\d+$/.test(params.id ?? '')) {
      const destination = getModelReviewsRedirect(Number(params.id), ctx.query);
      if (destination) return { redirect: { destination, permanent: true } };
    }

    const result = getResourceReviewPagedSchema.safeParse({
      modelId: params.id,
      ...ctx.query,
      // Must equal the client's useBrowsingLevelDebounced() or the prefetch key misses.
      browsingLevel: getServerBrowsingLevel({
        canViewNsfw: features?.canViewNsfw ?? false,
        user: session?.user,
      }),
      // `filter` is the only source of the list filters, so a raw param cannot filter the list
      // while the control shows "All".
      hasImages: undefined,
      recommended: undefined,
      ...getReviewsFilterInput(parseReviewsFilter(ctx.query.filter)),
    });
    if (!result.success) return { notFound: true };

    const { modelId, modelVersionId } = result.data;

    // The list is always one version's: send a request without a usable version to the model
    // page's default (first published) one.
    const decision = await resolveReviewsVersion({
      modelVersionId,
      requested: modelVersionId
        ? await getDefaultModelVersion({ modelId, modelVersionId }).catch(nullIfNotFound)
        : null,
      loadFallback: () => getDefaultModelVersion({ modelId }).catch(nullIfNotFound),
    });
    if (decision.type === 'notFound') return { notFound: true };
    if (decision.type === 'redirect') {
      return {
        redirect: {
          destination: getModelReviewsVersionRedirect(modelId, ctx.query, decision.versionId),
          permanent: false,
        },
      };
    }

    await Promise.all([
      ssg?.resourceReview.getPaged.prefetch(result.data),
      ssg?.model.getSimple.prefetch({ id: modelId }),
      ssg?.model.getVersions.prefetch({ id: modelId, excludeUnpublished: true }),
      ssg?.resourceReview.getRatingTotals.prefetch({ modelId, modelVersionId }),
      ssg?.hiddenPreferences.getHidden.prefetch(),
    ]);
  },
});

export default function ModelReviews() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const filter = parseReviewsFilter(router.query.filter);
  const browsingLevel = useBrowsingLevelDebounced();
  const queryParams = getResourceReviewPagedSchema.parse({
    modelId: router.query.id,
    ...router.query,
    hasImages: undefined,
    recommended: undefined,
    ...getReviewsFilterInput(filter),
    browsingLevel,
  });
  const { modelId, modelVersionId, page } = queryParams;
  const isMuted = currentUser?.muted ?? false;

  const { data: model, isLoading: loadingModel } = trpc.model.getSimple.useQuery({
    id: modelId,
  });
  const { data: versions, isLoading: loadingVersions } = trpc.model.getVersions.useQuery({
    id: modelId,
    excludeUnpublished: true,
  });
  const {
    data: resourceReviews,
    isLoading: loadingResourceReviews,
    isRefetching: refetchingResourceReviews,
  } = trpc.resourceReview.getPaged.useQuery(queryParams, { placeholderData: keepPreviousData });
  const { data: ratingTotals } = trpc.resourceReview.getRatingTotals.useQuery({
    modelId,
    modelVersionId,
  });

  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === model?.user.id);

  const handleModelVersionChange = (value: string | null) => {
    router.replace(
      {
        pathname: router.pathname,
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

  const handleFilterChange = (value: string) => {
    router.replace(
      {
        // With the route pattern as pathname, `id` fills [id] instead of trailing as ?id=.
        pathname: router.pathname,
        query: removeEmpty({ ...router.query, filter: parseReviewsFilter(value), page: 1 }),
      },
      undefined,
      { shallow: true }
    );
  };

  const handlePaginationChange = (page: number) => {
    router.replace({ pathname: router.pathname, query: { ...router.query, page } }, undefined, {
      shallow: true,
    });
  };

  if (!loadingModel && (!model || model?.status !== 'Published' || isBlocked)) return <NotFound />;

  const Model = loadingModel ? (
    <Skeleton height={44} />
  ) : model ? (
    <Group gap="xs" wrap="nowrap">
      <BackButton
        url={getModelUrl({
          modelId: model.id,
          modelName: model.name,
          modelVersionId,
        })}
      />
      <Title lineClamp={1}>{model.name} Reviews</Title>
    </Group>
  ) : null;
  const Versions = loadingVersions ? (
    <Skeleton height={36} />
  ) : !!versions?.length ? (
    <Select
      allowDeselect={false}
      data={versions.map((version) => ({ label: version.name, value: version.id.toString() }))}
      value={(router.query.modelVersionId as string) ?? null}
      onChange={handleModelVersionChange}
    />
  ) : null;

  const version = versions?.find((v) => v.id === modelVersionId);
  const UserReview = !currentUser ? (
    <Alert>You must be logged in to leave a review</Alert>
  ) : !modelVersionId || !model ? (
    <Alert>Select a model version to leave a review</Alert>
  ) : version?.isEarlyAccess && !currentUser.isMember ? (
    <Alert>{`Only Supporters can review this while it's in early access.`}</Alert>
  ) : (
    <UserResourceReviewComposite modelId={model.id} modelVersionId={modelVersionId}>
      {({ modelId, modelVersionId, modelName, userReview }) => (
        <Card p="sm" style={{ position: 'sticky', top: 24 }} withBorder>
          <Stack gap={8}>
            <Text size="md" fw={510}>
              Did you like this resource?
            </Text>
            {userReview && (
              <Text c="dimmed" size="xs">
                Reviewed <DaysFromNow date={userReview.createdAt} />
              </Text>
            )}
            <ResourceReviewThumbActions
              modelId={modelId}
              modelVersionId={modelVersionId}
              userReview={userReview}
              withCount
            />
          </Stack>
          {userReview && (
            <Card.Section py="sm" mt="sm" inheritPadding withBorder>
              <EditUserResourceReviewV2
                modelVersionId={modelVersionId}
                modelName={modelName}
                userReview={userReview}
                showReviewedAt={false}
              />
            </Card.Section>
          )}
        </Card>
      )}
    </UserResourceReviewComposite>
  );

  const thumbsUp = version?.rank.thumbsUpCountAllTime ?? 0;
  const thumbsDown = version?.rank.thumbsDownCountAllTime ?? 0;
  const summary = getRatingSummary({ thumbsUp, thumbsDown });

  const ratingCount = getRatingCount(ratingTotals);
  const ratingAverage = getAverageRating(ratingTotals, ratingCount);

  return (
    <>
      <Meta
        title={`${model?.name} Reviews | Rated ${ratingAverage} Stars by ${ratingCount} Users on Civitai`}
        description={`Explore user reviews of the ${model?.name} AI model on Civitai, rated ${ratingAverage} stars by ${ratingCount} users, and see how it has helped others bring their creative visions to life`}
        canonical={getModelReviewsCanonical(modelId, modelVersionId)}
      />
      <Container size="xl">
        <ContainerGrid2 gutter={48}>
          <ContainerGrid2.Col span={{ base: 12, md: 7 }} offset={{ md: 2 }} order={{ md: 1 }}>
            <Group gap={8} justify="space-between">
              {Model}
              {Versions}
            </Group>
          </ContainerGrid2.Col>
          <ContainerGrid2.Col span={{ base: 12, md: 3 }} order={{ md: 3 }}>
            {isMuted ? (
              <Alert color="yellow" icon={<IconLock />}>
                You cannot add reviews because you have been muted
              </Alert>
            ) : model?.locked ? (
              <Paper p="lg" withBorder bg={`rgba(0,0,0,0.1)`}>
                <Center>
                  <Group gap="xs">
                    <ThemeIcon color="gray" size="xl" radius="xl">
                      <IconMessageCircleOff />
                    </ThemeIcon>
                    <Text size="lg" c="dimmed">
                      Reviews are turned off for this model.
                    </Text>
                  </Group>
                </Center>
              </Paper>
            ) : (
              UserReview
            )}
          </ContainerGrid2.Col>
          <ContainerGrid2.Col span={{ base: 12, md: 7 }} offset={{ md: 2 }} order={{ md: 2 }}>
            {summary && (
              <div className="mb-4 flex flex-col gap-2" data-testid="reviews-summary">
                <Text size="xl" fw={700} c={summary.color} tt="capitalize">
                  {summary.label}
                </Text>
                <Text size="sm" c="dimmed">
                  {summary.percent}% of {summary.total.toLocaleString()}{' '}
                  {summary.total === 1 ? 'review' : 'reviews'}
                </Text>
                <div
                  className="flex h-2 overflow-hidden rounded-full bg-red-6"
                  role="img"
                  aria-label={`${thumbsUp.toLocaleString()} thumbs up, ${thumbsDown.toLocaleString()} thumbs down`}
                >
                  <div
                    className="bg-green-6"
                    style={{ width: `${(thumbsUp / summary.total) * 100}%` }}
                  />
                </div>
              </div>
            )}
            <SegmentedControl
              mb="md"
              fullWidth
              aria-label="Filter reviews"
              value={filter ?? 'all'}
              onChange={handleFilterChange}
              data={[
                { label: 'All', value: 'all' },
                { label: 'With images', value: 'images' },
                { label: '👍', value: 'up' },
                { label: '👎', value: 'down' },
              ]}
            />
            {loadingResourceReviews ? (
              <Center p="xl">
                <Loader />
              </Center>
            ) : (
              <Stack style={{ position: 'relative' }}>
                <LoadingOverlay visible={refetchingResourceReviews} />
                {resourceReviews?.items.map((review) => (
                  <ReviewCardWithImages
                    key={review.id}
                    review={review}
                    creatorId={model?.user.id}
                  />
                ))}
                {resourceReviews && !resourceReviews.items.length && (
                  <Text c="dimmed" ta="center" py="xl">
                    No reviews match this filter.
                  </Text>
                )}
                {resourceReviews &&
                'hasMore' in resourceReviews &&
                resourceReviews.hasMore !== undefined ? (
                  <ReviewsPager
                    page={page}
                    hasMore={resourceReviews.hasMore}
                    onChange={handlePaginationChange}
                  />
                ) : (
                  resourceReviews &&
                  resourceReviews.totalPages > 1 && (
                    <Center mt="md">
                      <Pagination
                        value={page}
                        onChange={handlePaginationChange}
                        total={resourceReviews.totalPages}
                      />
                    </Center>
                  )
                )}
              </Stack>
            )}
          </ContainerGrid2.Col>
        </ContainerGrid2>
      </Container>
    </>
  );
}
