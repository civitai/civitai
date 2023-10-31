import {
  ProfileSection,
  ProfileSectionPreview,
  ProfileSectionProps,
} from '~/components/Profile/ProfileSection';
import { useInView } from 'react-intersection-observer';
import { IconBrush, IconMessageChatbot, IconPhoto, IconStar, IconX } from '@tabler/icons-react';
import React from 'react';
import {
  Avatar,
  Badge,
  Button,
  Grid,
  Group,
  Paper,
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

export const TopReviewsSection = ({ user }: ProfileSectionProps) => {
  const theme = useMantineTheme();
  const { ref, inView } = useInView();
  const { resourceReviews, isLoading } = useQueryResourceReview(
    {
      username: user.username,
      sort: ReviewSort.Rating,
      include: ['model'],
      limit: 5,
    },
    {
      enabled: inView,
    }
  );

  console.log(resourceReviews);

  if (!inView && !isLoading && !resourceReviews.length) {
    // No reviews, this section makes no sense here.
    return null;
  }

  return (
    <div ref={ref}>
      {isLoading ? (
        <ProfileSectionPreview />
      ) : (
        <ProfileSection title="Top Reviews" icon={<IconStar />}>
          <Grid>
            <Grid.Col sm={12} md={7}>
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
                            {review.modelVersion?.model && (
                              <Button
                                px={4}
                                py={2}
                                component="a"
                                href={`/models/${review.modelVersion.model.id}?modelVersionId=${review.modelVersion.id}`}
                                color="blue"
                                size="xs"
                                style={{ height: '26px' }}
                              >
                                <Group spacing={2}>
                                  <IconBrush size={15} />
                                  <span>{review.modelVersion?.model.name}</span>
                                </Group>
                              </Button>
                            )}
                            {review.helper.imageCount > 0 && (
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
            <Grid.Col xs={12} md={5}></Grid.Col>
          </Grid>
        </ProfileSection>
      )}
    </div>
  );
};
