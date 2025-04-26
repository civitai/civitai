import { Badge, Button, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCategory, IconPhoto, IconStar } from '@tabler/icons-react';
import React from 'react';

import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
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
import styles from './RecentReviewsSection.module.scss';

export const RecentReviewsSection = ({ user }: ProfileSectionProps) => {
  const [ref, inView] = useInViewDynamic({ id: 'profile-reviews-section' });
  const { classes, theme } = useProfileSectionStyles({});

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
            <ContainerGrid className={styles.containerGrid}>
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
                          </Group>
                          <Stack w="100%">
                            {review.details && (
                              <ContentClamp maxHeight={300}>
                                <RenderHtml
                                  html={review.details}
                                  style={{
                                    color: theme.colorScheme === 'dark' ? 'white' : 'black',
                                  }}
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
                              {/* {review.helper && (review.helper?.imageCount ?? 0) > 0 && (
                              <Badge px={4} py={2} radius="sm" style={{ height: '26px' }}>
                                <Group spacing={2}>
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
              </ContainerGrid.Col>
            </ContainerGrid>
          </ProfileSection>
        ))}
    </div>
  );
};
