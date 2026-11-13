import { keepPreviousData } from '@tanstack/react-query';
import {
  Alert,
  Card,
  Center,
  Chip,
  Container,
  Loader,
  LoadingOverlay,
  Pagination,
  Paper,
  Select,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconLock,
  IconMessageCircleOff,
  IconStack2,
  IconThumbDown,
  IconThumbUp,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BackButton } from '~/components/BackButton/BackButton';
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
import { nullIfNotFound } from '~/server/utils/ssr-not-found';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { getRatingSummary } from '~/utils/rating-label';
import { getModelUrl } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

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
      // The page lists text reviews only; thumbs-only ones still count in the summary.
      writtenOnly: true,
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

    // The list is always one version's; a missing or foreign version goes to the model page's default.
    const decision = await resolveReviewsVersion({
      modelVersionId,
      requested: modelVersionId
        ? await getDefaultModelVersion({ modelId, modelVersionId }).catch(nullIfNotFound(ctx.res))
        : null,
      loadFallback: () => getDefaultModelVersion({ modelId }).catch(nullIfNotFound(ctx.res)),
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
    writtenOnly: true,
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
    <Skeleton height={56} />
  ) : model ? (
    <div className="flex min-w-0 items-center gap-2.5 sm:gap-3.5">
      <BackButton
        url={getModelUrl({
          modelId: model.id,
          modelName: model.name,
          modelVersionId,
        })}
      />
      <div className="min-w-0">
        <Text className="text-xs font-semibold tracking-[0.5px] sm:text-[13px]" c="dimmed" lh={1.4}>
          Reviews
        </Text>
        <Title order={1} className="text-xl font-extrabold sm:text-[30px]" lineClamp={1}>
          {model.name}
        </Title>
      </div>
    </div>
  ) : null;
  const Versions = loadingVersions ? (
    <Skeleton height={36} />
  ) : !!versions?.length ? (
    <Select
      aria-label="Version"
      allowDeselect={false}
      leftSection={<IconStack2 size={16} />}
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
        <Card p={20} withBorder>
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
      <Container size={1120} className="pb-12 pt-7">
        <div className="grid grid-cols-1 gap-x-10 gap-y-6 max-lg:gap-y-3.5 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[auto_auto_auto_1fr]">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between lg:col-span-2">
            {Model}
            <div className="md:w-[280px] md:shrink-0">{Versions}</div>
          </div>

          {/* Desktop: the right column follows the list while it scrolls. The outer box spans the
              list's rows so the sticky column has room to move; on phones both boxes are
              display:contents and the children keep their own order around the list. */}
          <div className="contents lg:col-start-2 lg:row-span-3 lg:row-start-2 lg:block">
            <div className="contents lg:sticky lg:top-4 lg:flex lg:flex-col lg:gap-6">
              {summary && (
                <Card
                  p={{ base: 14, sm: 20 }}
                  withBorder
                  className="order-1 flex flex-col gap-2 sm:gap-3.5"
                  data-testid="reviews-summary"
                >
                  <div className="flex flex-col gap-0.5 sm:gap-1">
                    <Text
                      fw={800}
                      c={summary.color}
                      tt="capitalize"
                      className="text-[17px] leading-[17px] sm:text-[22px] sm:leading-[26px]"
                    >
                      {summary.label}
                    </Text>
                    <Text c="dimmed" className="text-[13px]">
                      {summary.percent}%
                      <span className="hidden md:inline">
                        {' '}
                        of {summary.total.toLocaleString()}{' '}
                        {summary.total === 1 ? 'review' : 'reviews'} recommend it
                      </span>
                      <span className="md:hidden">
                        {' '}
                        · {summary.total.toLocaleString()}{' '}
                        {summary.total === 1 ? 'review' : 'reviews'}
                      </span>
                    </Text>
                  </div>
                  <div
                    className="flex h-1.5 overflow-hidden rounded-full bg-red-6 sm:h-2"
                    role="img"
                    aria-label={`${thumbsUp.toLocaleString()} thumbs up, ${thumbsDown.toLocaleString()} thumbs down`}
                  >
                    <div
                      className="bg-green-6"
                      style={{ width: `${(thumbsUp / summary.total) * 100}%` }}
                    />
                  </div>
                  <div className="hidden items-center justify-between text-[13px] md:flex">
                    <span className="flex items-center gap-1.5 text-green-6">
                      <IconThumbUp size={14} />
                      <Text component="span" className="text-[13px]" c="var(--mantine-color-text)">
                        {thumbsUp.toLocaleString()}
                      </Text>
                    </span>
                    <span className="flex items-center gap-1.5 text-red-6">
                      <Text component="span" className="text-[13px]" c="var(--mantine-color-text)">
                        {thumbsDown.toLocaleString()}
                      </Text>
                      <IconThumbDown size={14} />
                    </span>
                  </div>
                </Card>
              )}

              <div className="order-3">
                {isMuted ? (
                  <Alert color="yellow" icon={<IconLock />}>
                    You cannot add reviews because you have been muted
                  </Alert>
                ) : model?.locked ? (
                  <Paper p="lg" withBorder bg={`rgba(0,0,0,0.1)`}>
                    <Center>
                      <div className="flex items-center gap-2">
                        <ThemeIcon color="gray" size="xl" radius="xl">
                          <IconMessageCircleOff />
                        </ThemeIcon>
                        <Text size="lg" c="dimmed">
                          Reviews are turned off for this model.
                        </Text>
                      </div>
                    </Center>
                  </Paper>
                ) : (
                  UserReview
                )}
              </div>
            </div>
          </div>

          <div className="order-2 min-w-0 lg:col-start-1 lg:row-span-3 lg:row-start-2">
            <div className="mb-4 flex items-center gap-2">
              <Chip.Group multiple={false} value={filter ?? 'all'} onChange={handleFilterChange}>
                <div className="flex items-center gap-2" role="group" aria-label="Filter reviews">
                  <FilterChip value="all">All</FilterChip>
                  <FilterChip value="images">With images</FilterChip>
                  <FilterChip value="up" icon={<IconThumbUp size={14} />}>
                    Recommends
                  </FilterChip>
                  <FilterChip value="down" icon={<IconThumbDown size={14} />}>
                    Doesn’t
                  </FilterChip>
                </div>
              </Chip.Group>
            </div>
            {loadingResourceReviews ? (
              <Center p="xl">
                <Loader />
              </Center>
            ) : (
              <Stack style={{ position: 'relative' }} gap="md">
                <LoadingOverlay visible={refetchingResourceReviews} />
                {resourceReviews?.items.map((review) => (
                  <ReviewCardWithImages
                    key={review.id}
                    review={review}
                    creatorId={model?.user.id}
                    versionName={version?.name}
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
          </div>
        </div>
      </Container>
    </>
  );
}

function FilterChip({
  value,
  icon,
  children,
}: {
  value: string;
  icon?: React.ReactNode;
  children: string;
}) {
  return (
    <Chip
      value={value}
      variant="light"
      size="sm"
      radius="xl"
      styles={{
        iconWrapper: { display: 'none' },
        label: { paddingInline: 12, fontSize: 12, fontWeight: 500 },
      }}
    >
      <span className="inline-flex items-center gap-1.5">
        {icon}
        {/* Phone chips with an icon show the icon alone; the text stays as the accessible name. */}
        <span className={icon ? 'sr-only sm:not-sr-only' : undefined}>{children}</span>
      </span>
    </Chip>
  );
}
