import {
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconCategory, IconPhoto, IconStar } from '@tabler/icons-react';
import React from 'react';

import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import {
  ProfileSection,
  ProfileSectionPreview,
  ProfileSectionProps,
} from '~/components/Profile/ProfileSection';
import classes from '~/components/Profile/ProfileSection.module.scss';

import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { useQueryResourceReview } from '~/components/ResourceReview/resourceReview.utils';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import sectionClasses from './RecentReviewsSection.module.scss';

export const RecentReviewsSection = ({ user }: ProfileSectionProps) => {
  const [ref, inView] = useInViewDynamic({ id: 'profile-reviews-section' });
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const { resourceReviews, isLoading } = useQueryResourceReview(
    {
      username: user.username,
      include: ['model'],
      limit: 5,
      hasDetails: true,
    },
    {
      enabled: inView,
    }
  );

  const isNullState = !isLoading && !resourceReviews.length;

  if (isNullState) {
    return null;
  }

  return (
    <div ref={ref} className={isNullState ? undefined : classes.profileSection}>
      {inView &&
        (isLoading ? (
          <ProfileSectionPreview />
        ) : (
          <ProfileSection title="Recent Reviews" icon={<IconStar />}>
            <ContainerGrid2 className={sectionClasses.ContainerGrid}>
              <ContainerGrid2.Col span={{ base: 12, md: 8 }}>
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
                            colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
                        }}
                      >
                        <Stack>
                          <Group align="flex-start" justify="space-between" wrap="nowrap">
                            <UserAvatar
                              user={reviewer}
                              withUsername
                              size="lg"
                              avatarSize={40}
                              spacing="md"
                              linkToProfile
                              subText={
                                <Text c="dimmed" size="sm">
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
                          </Group>
                          <Stack w="100%">
                            {review.details && (
                              <ContentClamp maxHeight={300}>
                                <RenderHtml
                                  html={review.details}
                                  style={{
                                    color: colorScheme === 'dark' ? 'white' : 'black',
                                  }}
                                />
                              </ContentClamp>
                            )}
                            <Group gap="xs">
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
                                  <Group gap={2}>
                                    <IconCategory size={15} />
                                    <span>{review.model.name}</span>
                                  </Group>
                                </Button>
                              )}
                              {/* {review.helper && (review.helper?.imageCount ?? 0) > 0 && (
                              <Badge px={4} py={2} radius="sm" style={{ height: '26px' }}>
                                <Group gap={2}>
                                  <IconPhoto size={15} />{' '}
                                  <span>{abbreviateNumber(review.helper.imageCount)}</span>
                                </Group>
                              </Badge>
                            )} */}
                            </Group>
                          </Stack>
                        </Stack>
                      </Paper>
                    );
                  })}
                </Stack>
              </ContainerGrid2.Col>
            </ContainerGrid2>
          </ProfileSection>
        ))}
    </div>
  );
};
