import {
  ProfileSection,
  ProfileSectionPreview,
  ProfileSectionProps,
} from '~/components/Profile/ProfileSection';
import { useInView } from 'react-intersection-observer';
import { IconBrush, IconMessageChatbot, IconPhoto, IconStar, IconX } from '@tabler/icons-react';
import React, { Fragment, useMemo } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Center,
  Grid,
  Group,
  Loader,
  Paper,
  Progress,
  Rating,
  Stack,
  Text,
  useMantineTheme,
} from '@mantine/core';
import { useQueryResourceReview } from '~/components/ResourceReview/resourceReview.utils';
import { ReviewSort } from '~/server/common/enums';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getInitials } from '~/utils/string-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { daysFromNow } from '~/utils/date-helpers';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { ResourceReviewSummary } from '~/components/ResourceReview/Summary/ResourceReviewSummary';

export const RecentReviewsSection = ({ user }: ProfileSectionProps) => {
  const theme = useMantineTheme();
  const { ref, inView } = useInView();
  const { data: userRatingsTotal, isLoading: isLoadingTotals } =
    trpc.resourceReview.getUserRatingsTotal.useQuery(
      { username: user.username },
      { enabled: inView }
    );
  const { resourceReviews, isLoading } = useQueryResourceReview(
    {
      username: user.username,
      include: ['model'],
      limit: 5,
    },
    {
      enabled: inView,
    }
  );

  const userRatingsTotalCount = useMemo(() => {
    if (!userRatingsTotal) {
      return {
        count: 0,
        avgRating: 0,
      };
    }

    const count = Object.values(userRatingsTotal).reduce<number>((acc, value) => acc + value, 0);
    const avgRating =
      Object.keys(userRatingsTotal)
        .map((k) => Number(k) * userRatingsTotal[k as keyof typeof userRatingsTotal])
        .reduce<number>((acc, value) => acc + value, 0) / (count ?? 1);

    return {
      count,
      avgRating,
    };
  }, [userRatingsTotal]);

  if (inView && !isLoading && !resourceReviews.length) {
    // No reviews, this section makes no sense here.
    return null;
  }

  if (!userRatingsTotal && !isLoadingTotals) {
    // something is off, we should have totals by now
    return null;
  }

  return (
    <div ref={ref}>
      {isLoading ? (
        <ProfileSectionPreview />
      ) : (
        <ProfileSection title="Recent Reviews" icon={<IconStar />}>
          <Grid>
            <Grid.Col sm={12} md={8}>
              <Stack>
                {resourceReviews.map((review) => {
                  const reviewer = review.user;
                  return (
                    <Paper
                      key={review.id}
                      p="md"
                      radius="sm"
                      style={{
                        background:
                          theme.colorScheme === 'dark'
                            ? theme.colors.dark[6]
                            : theme.colors.gray[1],
                      }}
                    >
                      <Group align="flex-start" noWrap>
                        <UserAvatar user={reviewer} size="md" spacing="xs" linkToProfile />

                        <Stack w="100%">
                          <Group align="flex-start" position="apart">
                            <Stack spacing={0}>
                              <Text>{reviewer.username}</Text>
                              <Text color="dimmed" size="sm">
                                <DaysFromNow date={review.createdAt} />
                              </Text>
                            </Stack>
                            <Badge
                              radius="xl"
                              px={8}
                              py={4}
                              variant="light"
                              color="dark"
                              style={{ height: '24px' }}
                            >
                              <Rating value={review.rating} fractions={2} readOnly />
                            </Badge>
                          </Group>

                          {review.details && (
                            <ContentClamp maxHeight={300}>
                              <RenderHtml
                                html={review.details}
                                style={{ color: theme.colorScheme === 'dark' ? 'white' : 'black' }}
                              />
                            </ContentClamp>
                          )}
                          <Group spacing="xs">
                            {review.model && (
                              <Button
                                px={4}
                                py={2}
                                component="a"
                                href={`/models/${review.model.id}?modelVersionId=${review.modelVersion.id}`}
                                color="blue"
                                size="xs"
                                style={{ height: '26px' }}
                              >
                                <Group spacing={2}>
                                  <IconBrush size={15} />
                                  <span>{review.model.name}</span>
                                </Group>
                              </Button>
                            )}
                            {review.helper && (review.helper?.imageCount ?? 0) > 0 && (
                              <Badge px={4} py={2} radius="sm" style={{ height: '26px' }}>
                                <Group spacing={2}>
                                  <IconPhoto size={15} />{' '}
                                  <span>{abbreviateNumber(review.helper.imageCount)}</span>
                                </Group>
                              </Badge>
                            )}
                          </Group>
                        </Stack>
                      </Group>
                    </Paper>
                  );
                })}
              </Stack>
            </Grid.Col>
            <Grid.Col xs={12} md={4}>
              {isLoadingTotals ? (
                <Center>
                  <Loader />
                </Center>
              ) : (
                <Stack w="100%">
                  <Stack spacing={0}>
                    <Rating
                      value={userRatingsTotalCount.avgRating}
                      fractions={2}
                      readOnly
                      size="xl"
                    />
                    <Text
                      style={{
                        color: theme.colorScheme === 'dark' ? 'white' : 'black',
                        fontSize: 24,
                        fontWeight: 510,
                      }}
                    >
                      {userRatingsTotalCount.avgRating.toFixed(2)} out of 5
                    </Text>
                    <Text size="lg" color="dimmed">
                      {abbreviateNumber(userRatingsTotalCount.count)} Reviews
                    </Text>
                  </Stack>

                  <Stack spacing="xs" w="100%">
                    {Object.keys(userRatingsTotal)
                      .reverse()
                      .map((rating: string) => {
                        const key = rating as keyof typeof userRatingsTotal;
                        const progress =
                          (userRatingsTotal && userRatingsTotalCount.count
                            ? userRatingsTotal[key] / userRatingsTotalCount.count
                            : 0) * 100;
                        const rounded = Math.ceil(progress);
                        return (
                          <Group key={key}>
                            <Text>{rating} Star</Text>
                            <Progress
                              value={progress}
                              color="yellow"
                              size="lg"
                              style={{ flex: 1 }}
                            />
                            <Text align="left" color="dimmed" w={30}>
                              {rounded}%
                            </Text>
                          </Group>
                        );
                      })}
                  </Stack>
                </Stack>
              )}
            </Grid.Col>
          </Grid>
        </ProfileSection>
      )}
    </div>
  );
};
