import {
  Container,
  Group,
  Stack,
  Center,
  Loader,
  Text,
  Title,
  Badge,
  Divider,
  CloseButton,
  Button,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { NavigateBack } from '~/components/BackButton/BackButton';
import { NoContent } from '~/components/NoContent/NoContent';
import { trpc } from '~/utils/trpc';
import { removeTags, slugit } from '~/utils/string-helpers';
import { useRouter } from 'next/router';
import { ResourceReviewDetailModel } from '~/server/services/resourceReview.service';
import { ResourceReviewCarousel } from '~/components/ResourceReview/ResourceReviewCarousel';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ResourceReviewComments } from '~/components/ResourceReview/ResourceReviewComments';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ResourceReviewMenu } from '~/components/ResourceReview/ResourceReviewMenu';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import Link from 'next/link';
import { formatDate } from '~/utils/date-helpers';
import { PostSort } from '~/server/common/enums';
import { Meta } from '~/components/Meta/Meta';
import { truncate } from 'lodash-es';
import { StarRating } from '../StartRating/StarRating';
import { env } from '~/env/client.mjs';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';

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
  if (!data) return <NoContent />;

  const commentCount = data.thread?._count.comments ?? 0;

  const metaSchema = {
    '@context': 'https://schema.org',
    '@type': 'Review',
    name: `Review for ${data.model.name} - ${data.modelVersion.name}`,
    reviewBody: data.details ? ':' + truncate(removeTags(data.details), { length: 120 }) : '',
    author: data.user.username,
    datePublished: data.createdAt,
    reviewRating: {
      '@type': 'Rating',
      bestRating: 5,
      worstRating: 1,
      ratingValue: data.rating,
    },
    itemReviewed: {
      '@type': 'SoftwareApplication',
      name: data.model.name,
      applicationCategory: 'Multimedia',
      applicationSubCategory: 'Stable Diffusion Model',
      operatingSystem: 'Windows, OSX, Linux',
    },
  };

  return (
    <>
      <Meta
        title={`${data.model.name} - ${data.modelVersion.name} - Review by ${data.user.username}`}
        description={`${data.rating} star review${
          data.details ? ':' + truncate(removeTags(data.details), { length: 120 }) : ''
        }`}
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/reviews/${reviewId}`, rel: 'canonical' }]}
        schema={metaSchema}
      />
      <Container my="md" w="100%">
        <Stack>
          <Group position="apart" noWrap align="center">
            <Title order={3} sx={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ whiteSpace: 'nowrap' }}>Review:</span>{' '}
              <Text
                component={NextLink}
                href={getModelWithVersionUrl(data)}
                variant="link"
                lineClamp={1}
                sx={{ cursor: 'pointer' }}
                shallow={isModelPage}
              >
                {data.model.name} - {data.modelVersion.name}
              </Text>
            </Title>

            <Group spacing={4} noWrap>
              <ResourceReviewMenu
                size="lg"
                reviewId={reviewId}
                userId={data.user.id}
                review={{
                  ...data,
                  details: data.details ?? undefined,
                  modelVersionId: data.modelVersion.id,
                }}
              />
              <NavigateBack url={getModelWithVersionUrl(data)}>
                {({ onClick }) => <CloseButton onClick={onClick} size="lg" />}
              </NavigateBack>
            </Group>
          </Group>
          <Group spacing="xs" align="center">
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
            <IconBadge
              ml="auto"
              sx={{
                userSelect: 'none',
                paddingTop: 4,
                paddingBottom: 4,
                paddingRight: 0,
                height: 'auto',
              }}
              icon={<StarRating value={data.rating} />}
            ></IconBadge>
          </Group>
        </Stack>
      </Container>
      {data.user.username && (
        <ResourceReviewCarousel
          username={data.user.username}
          modelVersionId={data.modelVersion.id}
          reviewId={reviewId}
        />
      )}
      <Container pb="md" w="100%">
        <Stack>
          <Group spacing={4}>
            {!!relatedPosts?.items.length && (
              <Text size="md" mr="xs" weight={500} lh="1.1">
                Related posts
              </Text>
            )}
            {loadingRelatedPosts && !relatedPosts ? (
              <Loader variant="dots" />
            ) : (
              relatedPosts?.items.map((post) => (
                <Link
                  key={post.id}
                  href={`/posts/${post.id}/${post.title ? slugit(post.title) : ''}`}
                  passHref
                >
                  <Button
                    component="a"
                    size="xs"
                    variant="light"
                    styles={{ root: { height: 'auto' }, label: { whiteSpace: 'normal' } }}
                    compact
                  >
                    {post.title ? post.title : `From: ${formatDate(post.publishedAt as Date)}`}
                  </Button>
                </Link>
              ))
            )}
          </Group>
          <Divider />
          {data.details && <RenderHtml html={data.details} />}

          <Stack spacing="xs">
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

// function EditableRating({ id, rating }: { id: number; rating: number }) {
//   const { mutate, isLoading } = trpc.resourceReview.update.useMutation();
//   return (
//     <Rating
//       value={rating}
//       onChange={(value) => mutate({ id, rating: value })}
//       readOnly={isLoading}
//     />
//   );
// }

// function EditableDetails({ id, details }: { id: number; details?: string }) {
//   return <></>;
// }
