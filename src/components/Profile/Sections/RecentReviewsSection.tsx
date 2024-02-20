import { Badge, Button, Group, Paper, Stack, Text, ThemeIcon, createStyles } from '@mantine/core';
import { IconCategory, IconPhoto, IconStar } from '@tabler/icons-react';
import React from 'react';

import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import {
  ProfileSection,
  ProfileSectionPreview,
  ProfileSectionProps,
  useProfileSectionStyles,
} from '~/components/Profile/ProfileSection';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { useQueryResourceReview } from '~/components/ResourceReview/resourceReview.utils';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useInView } from '~/hooks/useInView';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles(() => ({
  title: {
    [containerQuery.smallerThan('sm')]: {
      fontSize: '24px',
    },
  },
  ContainerGrid: {
    [containerQuery.smallerThan('sm')]: {
      flexDirection: 'column-reverse',
    },
  },
}));

export const RecentReviewsSection = ({ user }: ProfileSectionProps) => {
  const { classes: sectionClasses } = useStyles();
  const { ref, inView } = useInView({
    delay: 100,
    triggerOnce: true,
  });
  const { data: userRatingsTotal, isLoading: isLoadingTotals } =
    trpc.resourceReview.getUserRatingsTotal.useQuery(
      { username: user.username },
      { enabled: inView }
    );
  const { classes, theme } = useProfileSectionStyles({});

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

  // const userRatingsTotalCount = useMemo(() => {
  //   if (!userRatingsTotal) {
  //     return {
  //       count: 0,
  //       avgRating: 0,
  //     };
  //   }

  //   const count = Object.values(userRatingsTotal).reduce<number>((acc, value) => acc + value, 0);
  //   const avgRating =
  //     Object.keys(userRatingsTotal)
  //       .map((k) => Number(k) * userRatingsTotal[k as keyof typeof userRatingsTotal])
  //       .reduce<number>((acc, value) => acc + value, 0) / (count ?? 1);

  //   return {
  //     count,
  //     avgRating,
  //   };
  // }, [userRatingsTotal]);

  const isNullState =
    (!isLoading && !resourceReviews.length) || (!userRatingsTotal && !isLoadingTotals);

  if (isNullState && inView) {
    return null;
  }

  return (
    <div ref={ref} className={isNullState ? undefined : classes.profileSection}>
      {isLoading || !inView ? (
        <ProfileSectionPreview />
      ) : (
        <ProfileSection title="Recent Reviews" icon={<IconStar />}>
          <ContainerGrid className={sectionClasses.ContainerGrid}>
            <ContainerGrid.Col sm={12} md={8}>
              <Stack>
                {resourceReviews.map((review) => {
                  const reviewer = review.user;
                  const isThumbsUp = review.recommended;

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
                      <Stack>
                        <Group align="flex-start" position="apart" noWrap>
                          <UserAvatar
                            user={reviewer}
                            withUsername
                            size="lg"
                            avatarSize={40}
                            spacing="md"
                            linkToProfile
                            subText={
                              <Text color="dimmed" size="sm">
                                <DaysFromNow date={review.createdAt} />
                              </Text>
                            }
                          />
                          <ThemeIcon
                            size="lg"
                            radius="md"
                            variant="light"
                            color={isThumbsUp ? 'success.5' : 'red'}
                          >
                            {isThumbsUp ? <ThumbsUpIcon filled /> : <ThumbsDownIcon filled />}
                          </ThemeIcon>
                          {/* <Badge
                            radius="xl"
                            px={8}
                            py={4}
                            variant="light"
                            color={theme.colorScheme === 'dark' ? 'dark' : 'gray'}
                            style={{ height: '24px' }}
                            ml="auto"
                          >
                            <Rating value={review.rating} fractions={2} readOnly />
                          </Badge> */}
                        </Group>
                        <Stack w="100%">
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
                                  <IconCategory size={15} />
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
                      </Stack>
                    </Paper>
                  );
                })}
              </Stack>
            </ContainerGrid.Col>
            {/* <ContainerGrid.Col xs={12} md={4}>
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
                      {isNumber(userRatingsTotalCount.avgRating)
                        ? userRatingsTotalCount.avgRating.toFixed(2)
                        : 0}{' '}
                      out of 5
                    </Text>
                    <Text size="lg" color="dimmed">
                      {abbreviateNumber(userRatingsTotalCount.count)} Reviews
                    </Text>
                  </Stack>

                  {userRatingsTotal && (
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
                  )}
                </Stack>
              )}
            </ContainerGrid.Col> */}
          </ContainerGrid>
        </ProfileSection>
      )}
    </div>
  );
};
