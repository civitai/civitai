import {
  Alert,
  Badge,
  Card,
  Center,
  Container,
  Group,
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
import { IconLock, IconMessage, IconMessageCircleOff, IconPhoto } from '@tabler/icons-react';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { BackButton } from '~/components/BackButton/BackButton';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { Meta } from '~/components/Meta/Meta';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import {
  EditUserResourceReviewV2,
  UserResourceReviewComposite,
} from '~/components/ResourceReview/EditUserResourceReview';
import { ResourceReviewMenu } from '~/components/ResourceReview/ResourceReviewMenu';
import { ResourceReviewThumbActions } from '~/components/ResourceReview/ResourceReviewThumbActions';
import { getAverageRating, getRatingCount } from '~/components/ResourceReview/resourceReview.utils';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { env } from '~/env/client';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getResourceReviewPagedSchema } from '~/server/schema/resourceReview.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import type { ResourceReviewPagedModel } from '~/types/router';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import classes from './review.module.scss';

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
      ssg?.hiddenPreferences.getHidden.prefetch(),
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
    excludeUnpublished: true,
  });
  const {
    data: resourceReviews,
    isLoading: loadingResourceReviews,
    isRefetching: refetchingResourceReviews,
  } = trpc.resourceReview.getPaged.useQuery(queryParams, { keepPreviousData: true });
  const { data: ratingTotals } = trpc.resourceReview.getRatingTotals.useQuery({
    modelId,
    modelVersionId,
  });

  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === model?.user.id);

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

  if (!loadingModel && (!model || model?.status !== 'Published' || isBlocked)) return <NotFound />;

  const Model = loadingModel ? (
    <Skeleton height={44} />
  ) : model ? (
    <Group gap="xs" wrap="nowrap">
      <BackButton url={`/models/${model.id}?modelVersionId=${modelVersionId}`} />
      <Title lineClamp={1}>{model.name} Reviews</Title>
    </Group>
  ) : null;
  const Versions = loadingVersions ? (
    <Skeleton height={36} />
  ) : !!versions?.length ? (
    <Select
      placeholder="Showing all versions"
      // clearable={versions && versions.length > 1}
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

  const ratingCount = getRatingCount(ratingTotals);
  const ratingAverage = getAverageRating(ratingTotals, ratingCount);

  return (
    <>
      <Meta
        title={`${model?.name} Reviews | Rated ${ratingAverage} Stars by ${ratingCount} Users on Civitai`}
        description={`Explore user reviews of the ${model?.name} AI model on Civitai, rated ${ratingAverage} stars by ${ratingCount} users, and see how it has helped others bring their creative visions to life`}
        links={[
          {
            href: `${env.NEXT_PUBLIC_BASE_URL}/models/${modelId}/reviews?modelVersionId=${modelVersionId}`,
            rel: 'canonical',
          },
        ]}
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
            {loadingResourceReviews ? (
              <Center p="xl">
                <Loader />
              </Center>
            ) : (
              <Stack style={{ position: 'relative' }}>
                <LoadingOverlay visible={refetchingResourceReviews} />
                {resourceReviews?.items.map((review) => (
                  <ReviewCard key={review.id} creatorId={model?.user.id} {...review} />
                ))}
                {resourceReviews && resourceReviews.totalPages > 1 && (
                  <Center mt="md">
                    <Pagination
                      value={page}
                      onChange={handlePaginationChange}
                      total={resourceReviews.totalPages}
                    />
                  </Center>
                )}
              </Stack>
            )}
          </ContainerGrid2.Col>
        </ContainerGrid2>
      </Container>
    </>
  );
}

function ReviewCard({ creatorId, ...review }: ResourceReviewPagedModel & { creatorId?: number }) {
  const isCreator = creatorId === review.user.id;
  const isThumbsUp = review.recommended;

  return (
    <Card className={classes.card} shadow="sm" radius="md" w="100%" p="xl" withBorder>
      <Stack gap="sm">
        {(review.exclude || isCreator) && (
          <Group justify="start">
            <Badge color="red">Excluded from count</Badge>
          </Group>
        )}

        <Group justify="space-between" wrap="nowrap">
          <UserAvatar
            user={review.user}
            subText={
              <Group mt={4} gap={8} wrap="nowrap">
                <Text size="sm" lineClamp={1}>
                  <DaysFromNow date={review.createdAt} />
                </Text>

                <RoutedDialogLink
                  name="resourceReview"
                  state={{ reviewId: review.id }}
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
                    {review.imageCount ?? '0'}
                  </Badge>
                </RoutedDialogLink>

                <RoutedDialogLink
                  name="resourceReview"
                  state={{ reviewId: review.id }}
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
                    {review.commentCount ?? '0'}
                  </Badge>
                </RoutedDialogLink>
              </Group>
            }
            subTextForce
            avatarSize={40}
            size="lg"
            spacing="md"
            withUsername
            linkToProfile
          />
          <Group className={classes.actionsWrapper} wrap="nowrap">
            <RoutedDialogLink
              name="resourceReview"
              state={{ reviewId: review.id }}
              style={{ display: 'flex' }}
            >
              {isThumbsUp ? (
                <ThemeIcon color="success.5" size="lg" radius="md" variant="light">
                  <ThumbsUpIcon filled />
                </ThemeIcon>
              ) : (
                <ThemeIcon color="red" size="lg" radius="md" variant="light">
                  <ThumbsDownIcon filled />
                </ThemeIcon>
              )}
            </RoutedDialogLink>
            <ResourceReviewMenu
              reviewId={review.id}
              userId={review.user.id}
              review={{
                ...review,
                details: review.details ?? '',
                modelVersionId: review.modelVersionId,
              }}
            />
          </Group>
        </Group>
        {review.details && (
          <ContentClamp maxHeight={300} ml="56px">
            <RenderHtml html={review.details} withProfanityFilter />
          </ContentClamp>
        )}
      </Stack>
    </Card>
  );
}
