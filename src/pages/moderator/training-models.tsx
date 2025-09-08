import {
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Text,
  Title,
  ThemeIcon,
} from '@mantine/core';
import { IconDownload, IconEye, IconUser, IconCalendar } from '@tabler/icons-react';
import { formatDate } from '~/utils/date-helpers';
import Link from 'next/link';
import { useMemo } from 'react';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { formatBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import classes from './training-models.module.scss';

export default function TrainingModerationFeedPage() {
  const currentUser = useCurrentUser();

  const { data, isFetching, hasNextPage, fetchNextPage, isInitialLoading } =
    trpc.moderator.models.queryTraining.useInfiniteQuery(
      { limit: 20 },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        enabled: !!currentUser?.isModerator,
      }
    );

  const flatData = useMemo(() => data?.pages.flatMap((x) => x.items), [data]);

  if (!currentUser?.isModerator) {
    return (
      <>
        <Meta title="Access Denied" deIndex />
        <Center py="xl">
          <Text>Access denied. Moderator access required.</Text>
        </Center>
      </>
    );
  }

  return (
    <>
      <Meta title="Training Models Moderation Feed" deIndex />
      <div className={classes.container}>
        <Stack gap="lg">
          {/* Header */}
          <Card p="md" radius="md" withBorder className={classes.headerCard}>
            <Group gap="sm" align="center">
              <ThemeIcon size="lg" variant="light" color="blue" radius="md">
                <IconEye size={24} />
              </ThemeIcon>
              <div>
                <Title order={1} size="lg" mb={0}>
                  Training Models Moderation Feed
                </Title>
                <Text c="dimmed" size="sm">
                  Models uploaded with training data for moderation review
                </Text>
              </div>
            </Group>
          </Card>

          {isInitialLoading ? (
            <Center py="xl">
              <Stack align="center" gap="sm">
                <Loader type="bars" size="lg" />
                <Text size="sm" c="dimmed">
                  Loading training models...
                </Text>
              </Stack>
            </Center>
          ) : !flatData || flatData.length === 0 ? (
            <Center py="xl">
              <NoContent message="No training models to review" />
            </Center>
          ) : (
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
              {flatData?.map((model) => (
                <Card key={model.id} p="md" radius="md" withBorder className={classes.modelCard}>
                  <Stack gap="sm">
                    {/* Compact Header */}
                    <div>
                      <Text fw={700} size="lg" className={classes.modelTitle} lineClamp={2}>
                        {model.name}
                      </Text>
                      <Group gap="xs" mt="xs" wrap="wrap">
                        <Badge
                          color={model.status === 'Published' ? 'green' : 'orange'}
                          variant="light"
                          size="sm"
                        >
                          {model.status}
                        </Badge>
                        {model.nsfw && (
                          <Badge color="red" variant="light" size="xs">
                            NSFW
                          </Badge>
                        )}
                        {model.poi && (
                          <Badge color="red" variant="filled" size="xs">
                            POI
                          </Badge>
                        )}
                        {model.minor && (
                          <Badge color="red" variant="filled" size="xs">
                            Minor
                          </Badge>
                        )}
                        {model.tosViolation && (
                          <Badge color="red" variant="filled" size="xs">
                            ToS
                          </Badge>
                        )}
                      </Group>
                    </div>

                    {/* Compact Meta */}
                    <div className={classes.metaSection}>
                      <Group gap="xs" mb="xs">
                        <UserAvatar user={model.user} size="xs" />
                        <Text size="xs" fw={500}>
                          {model.user.username}
                        </Text>
                        <Text size="xs" c="dimmed">
                          •
                        </Text>
                        <Text size="xs" c="dimmed">
                          {model.type}
                        </Text>
                      </Group>
                      <Text size="xs" c="dimmed">
                        Created {formatDate(model.createdAt)}
                      </Text>
                      {model.publishedAt && (
                        <Text size="xs" c="dimmed">
                          Published {formatDate(model.publishedAt)}
                        </Text>
                      )}
                    </div>

                    {/* Compact Versions */}
                    {model.modelVersions.map((version) => (
                      <div key={version.id} className={classes.versionSection}>
                        <Group gap="xs" justify="space-between" align="flex-start" noWrap>
                          {/* Version Info */}
                          <div>
                            <Group gap="xs" align="flex-start" wrap="wrap">
                              <Text fw={600} size="sm" lineClamp={1}>
                                {version.name}
                              </Text>
                              <Badge color="blue" variant="light" size="xs">
                                {version.status}
                              </Badge>
                              {version.trainingStatus && (
                                <Badge color="purple" variant="light" size="xs">
                                  {version.trainingStatus}
                                </Badge>
                              )}
                            </Group>
                            <Text size="xs" c="dimmed">
                              Created {formatDate(version.createdAt)}
                            </Text>
                          </div>

                          {/* Action Buttons */}
                          <Group gap="xs">
                            <Button
                              size="xs"
                              variant="light"
                              color="blue"
                              leftSection={<IconEye size={14} />}
                              component={Link}
                              href={`/models/${model.id}?modelVersionId=${version.id}`}
                            >
                              View
                            </Button>
                            <Button
                              size="xs"
                              variant="filled"
                              color="yellow"
                              leftSection={<IconEye size={14} />}
                              component={Link}
                              href={`/moderator/review/training-data/${version.id}`}
                            >
                              Review
                            </Button>
                          </Group>

                          {/* Compact Training Files */}
                          <Stack gap="xs" w="100%" mt="sm">
                            {version.files.map((file) => (
                              <div key={file.id} className={classes.fileItem}>
                                <Stack gap={4}>
                                  <Group justify="space-between" align="center">
                                    <Text size="xs" fw={500} lineClamp={1}>
                                      {file.name}
                                    </Text>
                                    <Button
                                      size="xs"
                                      variant="light"
                                      color="yellow"
                                      leftSection={<IconDownload size={12} />}
                                      component="a"
                                      href={file.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ flexShrink: 0 }}
                                    >
                                      Download
                                    </Button>
                                  </Group>
                                  <Text size="xs" c="dimmed">
                                    {formatBytes(file.sizeKB * 1024)} •{' '}
                                    {formatDate(file.createdAt, 'MMM d')}
                                  </Text>
                                  {file.metadata &&
                                    typeof file.metadata === 'object' &&
                                    !Array.isArray(file.metadata) && (
                                      <Group gap="xs">
                                        {'numImages' in file.metadata &&
                                          file.metadata.numImages && (
                                            <Badge variant="light" color="green" size="xs">
                                              {file.metadata.numImages} img
                                            </Badge>
                                          )}
                                        {'numCaptions' in file.metadata &&
                                          file.metadata.numCaptions && (
                                            <Badge variant="light" color="blue" size="xs">
                                              {file.metadata.numCaptions} cap
                                            </Badge>
                                          )}
                                      </Group>
                                    )}
                                </Stack>
                              </div>
                            ))}
                          </Stack>
                        </Group>
                      </div>
                    ))}
                  </Stack>
                </Card>
              ))}
            </SimpleGrid>
          )}

          {hasNextPage && (
            <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetching}>
              <Center py="md">
                <Stack align="center" gap="xs">
                  <Loader type="bars" size="sm" />
                  <Text size="xs" c="dimmed">
                    Loading more...
                  </Text>
                </Stack>
              </Center>
            </InViewLoader>
          )}
        </Stack>
      </div>
    </>
  );
}
