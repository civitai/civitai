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
  CloseButton,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
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

export function ResourceReviewDetail({ reviewId }: { reviewId: number }) {
  const router = useRouter();
  const { data, isLoading } = trpc.resourceReview.get.useQuery({ id: reviewId });

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
                component={NextLink}
                href={getModelWithVersionUrl(data)}
                variant="link"
                lineClamp={1}
                sx={{ cursor: 'pointer' }}
                shallow
              >
                {data.model.name} - {data.modelVersion.name}
              </Text>
            </Title>

            <Group spacing={4} noWrap>
              <ResourceReviewMenu reviewId={reviewId} userId={data.user.id} />
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
              icon={<Rating size="md" value={data.rating} fractions={2} readOnly />}
            ></IconBadge>
          </Group>
        </Stack>
      </Container>
      {data.user.username && (
        <Box
          mb="md"
          sx={(theme) => ({
            background: theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[2],
          })}
        >
          <Container py="md">
            <ResourceReviewCarousel
              username={data.user.username}
              modelVersionId={data.modelVersion.id}
              reviewId={reviewId}
            />
          </Container>
        </Box>
      )}
      <Container>
        <Stack>
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
