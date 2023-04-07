import {
  Container,
  Group,
  Stack,
  Center,
  Loader,
  Text,
  Title,
  Badge,
  Rating,
  Box,
  Divider,
  CloseButton,
  Button,
} from '@mantine/core';
import { NavigateBack } from '~/components/BackButton/BackButton';
import { NoContent } from '~/components/NoContent/NoContent';
import { trpc } from '~/utils/trpc';
import { slugit } from '~/utils/string-helpers';
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

export function ResourceReviewDetail({ reviewId }: { reviewId: number }) {
  const router = useRouter();
  const inModal = !!router.query.modal;

  const { data, isLoading } = trpc.resourceReview.get.useQuery({ id: reviewId });
  const { data: relatedPosts, isLoading: loadingRelatedPosts } = trpc.post.getInfinite.useQuery(
    { username: data?.user.username, modelVersionId: data?.modelVersion.id, sort: PostSort.Newest },
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

  return (
    <>
      <Container mb="md">
        <Stack>
          <Group position="apart" noWrap align="center">
            <Title order={3} sx={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ whiteSpace: 'nowrap' }}>Review:</span>{' '}
              <Text
                component={Link}
                href={getModelWithVersionUrl(data)}
                variant="link"
                lineClamp={1}
                sx={{ cursor: 'pointer' }}
                shallow={inModal}
              >
                {data.model.name} - {data.modelVersion.name}
              </Text>
            </Title>

            <Group spacing={4} noWrap>
              <ResourceReviewMenu
                reviewId={reviewId}
                userId={data.user.id}
                review={{
                  ...data,
                  details: data.details ?? undefined,
                  modelVersionId: data.modelVersion.id,
                }}
              />
              {inModal && (
                <NavigateBack url={getModelWithVersionUrl(data)}>
                  {({ onClick }) => <CloseButton onClick={onClick} size="lg" />}
                </NavigateBack>
              )}
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
              icon={<Rating size="md" value={data.rating} fractions={2} readOnly />}
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
      <Container>
        <Stack>
          <Group spacing={4}>
            <Text size="md" mr="xs" weight={500} lh="1.1">
              Related posts
            </Text>
            {loadingRelatedPosts && !relatedPosts ? (
              <Loader variant="dots" />
            ) : (
              relatedPosts?.items.map((post) => (
                <Link
                  key={post.id}
                  href={`/posts/${post.id}/${post.title ? slugit(post.title) : ''}`}
                  passHref
                  legacyBehavior
                >
                  <Button component="a" size="xs" variant="light" compact>
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

function EditableRating({ id, rating }: { id: number; rating: number }) {
  const { mutate, isLoading } = trpc.resourceReview.update.useMutation();
  return (
    <Rating
      value={rating}
      onChange={(value) => mutate({ id, rating: value })}
      readOnly={isLoading}
    />
  );
}

function EditableDetails({ id, details }: { id: number; details?: string }) {
  return <></>;
}
