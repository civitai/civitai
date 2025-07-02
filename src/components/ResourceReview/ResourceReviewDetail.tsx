import {
  Anchor,
  Badge,
  Button,
  Center,
  CloseButton,
  Container,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { truncate } from 'lodash-es';
import { useRouter } from 'next/router';
import { NavigateBack } from '~/components/BackButton/BackButton';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ResourceReviewCarousel } from '~/components/ResourceReview/ResourceReviewCarousel';
import { ResourceReviewComments } from '~/components/ResourceReview/ResourceReviewComments';
import { ResourceReviewMenu } from '~/components/ResourceReview/ResourceReviewMenu';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { env } from '~/env/client';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { PostSort } from '~/server/common/enums';
import type { ResourceReviewDetailModel } from '~/server/services/resourceReview.service';
import { formatDate } from '~/utils/date-helpers';
import { removeTags, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function ResourceReviewDetail({ reviewId }: { reviewId: number }) {
  const router = useRouter();
  const isModelPage = !!router.query.id && !router.pathname.includes('/reviews');

  const { data, isLoading } = trpc.resourceReview.get.useQuery({ id: reviewId });
  const browsingLevel = useBrowsingLevelDebounced();
  const { data: relatedPosts, isLoading: loadingRelatedPosts } = trpc.post.getInfinite.useQuery(
    {
      username: data?.user.username,
      modelVersionId: data?.modelVersion.id,
      sort: PostSort.Newest,
      browsingLevel,
    },
    { enabled: !!data }
  );

  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === data?.user.id);

  const getModelUrl = (data: ResourceReviewDetailModel) =>
    `/models/${data.model.id}/${slugit(data.model.name)}`;
  const getModelWithVersionUrl = (data: ResourceReviewDetailModel) =>
    `${getModelUrl(data)}?modelVersionId=${data.modelVersion.id}`;

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!data || isBlocked) return <NoContent />;

  const commentCount = data.thread?._count.comments ?? 0;

  const isThumbsUp = data.recommended === true;
  const isThumbsDown = data.recommended === false;
  const metaSchema = {
    '@context': 'https://schema.org',
    '@type': 'Review',
    name: `Review for ${data.model.name} - ${data.modelVersion.name}`,
    reviewBody: data.details ? ':' + truncate(removeTags(data.details), { length: 120 }) : '',
    author: !data.user.deletedAt
      ? {
          '@type': 'Person',
          name: data.user.username,
          url: `${env.NEXT_PUBLIC_BASE_URL}/user/${data.user.username}`,
        }
      : undefined,
    datePublished: data.createdAt,
    reviewRating: {
      '@type': 'Rating',
      bestRating: 5,
      worstRating: 1,
      ratingValue: isThumbsUp ? 5 : 1,
    },
    itemReviewed: {
      '@type': 'SoftwareApplication',
      name: data.model.name,
      applicationCategory: 'Multimedia',
      applicationSubCategory: `${data.modelVersion.baseModel} AI Model`,
      operatingSystem: 'Windows, OSX, Linux',
    },
  };

  return (
    <>
      <Meta
        title={`${data.model.name} - ${data.modelVersion.name} - Reviewed by ${data.user.username}`}
        description={`${data.user.username} ${
          data.recommended ? 'recommends' : "doesn't recommend"
        } this resource. ${
          data.details ? ':' + truncate(removeTags(data.details), { length: 120 }) : ''
        }`}
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/reviews/${reviewId}`, rel: 'canonical' }]}
        schema={metaSchema}
      />
      <Container my="md" w="100%">
        <Stack>
          <Group justify="space-between" wrap="nowrap" align="center">
            <Title order={3} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ whiteSpace: 'nowrap' }}>Review:</span>{' '}
              <Anchor
                component={Link}
                href={getModelWithVersionUrl(data)}
                lineClamp={1}
                shallow={isModelPage}
                inherit
              >
                {data.model.name} - {data.modelVersion.name}
              </Anchor>
            </Title>

            <Group gap={4} wrap="nowrap">
              <ResourceReviewMenu
                size="lg"
                reviewId={reviewId}
                userId={data.user.id}
                review={{
                  ...data,
                  details: data.details ?? '',
                  modelVersionId: data.modelVersion.id,
                }}
              />
              <NavigateBack url={getModelWithVersionUrl(data)}>
                {({ onClick }) => <CloseButton onClick={onClick} size="lg" />}
              </NavigateBack>
            </Group>
          </Group>
          <Group gap="xs" align="center" justify="space-between">
            <UserAvatar
              user={data.user}
              subText={<DaysFromNow date={data.createdAt} />}
              subTextForce
              badge={
                data.user.id === data.model.userId ? (
                  <Badge size="xs" color="violet">
                    OP
                  </Badge>
                ) : null
              }
              size="lg"
              spacing="xs"
              withUsername
              linkToProfile
            />

            {isThumbsUp ? (
              <ThemeIcon color="success.5" size="xl" radius="md" variant="light">
                <ThumbsUpIcon size={32} filled />
              </ThemeIcon>
            ) : isThumbsDown ? (
              <ThemeIcon color="red" size="xl" radius="md" variant="light">
                <ThumbsDownIcon size={32} />
              </ThemeIcon>
            ) : null}
          </Group>
        </Stack>
      </Container>
      {data.user.username && (
        <ResourceReviewCarousel
          userId={data.user.id}
          modelVersionId={data.modelVersion.id}
          reviewId={reviewId}
        />
      )}
      <Container pb="md" w="100%">
        <Stack>
          <Group gap={4}>
            {!!relatedPosts?.items.length && (
              <Text size="md" mr="xs" fw={500} lh="1.1">
                Related posts
              </Text>
            )}
            {loadingRelatedPosts && !relatedPosts ? (
              <Loader type="dots" />
            ) : (
              relatedPosts?.items.map((post) => (
                <Link
                  key={post.id}
                  href={`/posts/${post.id}/${post.title ? slugit(post.title) : ''}`}
                  passHref
                  legacyBehavior
                >
                  <Button
                    component="a"
                    variant="light"
                    styles={{ root: { height: 'auto' }, label: { whiteSpace: 'normal' } }}
                    size="compact-xs"
                  >
                    {post.title ? post.title : `From: ${formatDate(post.publishedAt as Date)}`}
                  </Button>
                </Link>
              ))
            )}
          </Group>
          <Divider />
          {data.details && <RenderHtml html={data.details} />}

          <Stack gap="xs">
            <Title order={3}>
              {commentCount.toLocaleString()} {commentCount === 1 ? 'Comment' : 'Comments'}
            </Title>
            <ResourceReviewComments reviewId={reviewId} userId={data.user.id} />
          </Stack>
        </Stack>
      </Container>
    </>
  );
}
