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
  TextInput,
  Title,
  ThemeIcon,
} from '@mantine/core';
import { IconDownload, IconEye, IconUser } from '@tabler/icons-react';
import { formatDate } from '~/utils/date-helpers';
import Link from 'next/link';
import { useMemo, useState, useEffect } from 'react';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { formatBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { showNotification } from '@mantine/notifications';
import type { ModelMeta } from '~/server/schema/model.schema';
import type { ModelFileMetadata } from '~/server/schema/model-file.schema';
import classes from './training-models.module.scss';

export default function TrainingModerationFeedPage() {
  const currentUser = useCurrentUser();
  const [usernameFilter, setUsernameFilter] = useState('');
  const [debouncedUsernameFilter, setDebouncedUsernameFilter] = useState('');

  // Debounce username filter
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedUsernameFilter(usernameFilter);
    }, 500);

    return () => clearTimeout(timer);
  }, [usernameFilter]);

  const { data, isFetching, hasNextPage, fetchNextPage, isInitialLoading } =
    trpc.moderator.models.queryTraining.useInfiniteQuery(
      { limit: 20, username: debouncedUsernameFilter || undefined },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        enabled: !!currentUser?.isModerator,
      }
    );

  const flatData = useMemo(() => data?.pages.flatMap((x) => x.items), [data]);

  const utils = trpc.useUtils();

  const toggleCannotPublishMutation = trpc.model.toggleCannotPublish.useMutation({
    onMutate: async (variables) => {
      // Cancel any outgoing refetches
      await utils.moderator.models.queryTraining.cancel();

      // Snapshot the previous value
      const previousData = utils.moderator.models.queryTraining.getInfiniteData();

      // Optimistically update the cache
      utils.moderator.models.queryTraining.setInfiniteData(
        { limit: 20, username: debouncedUsernameFilter || undefined },
        (old) => {
          if (!old) return old;

          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              items: page.items.map((model) => {
                if (model.id === variables.id) {
                  const modelMeta = model.meta as ModelMeta | null;
                  return {
                    ...model,
                    meta: {
                      ...(modelMeta || {}),
                      cannotPublish: !modelMeta?.cannotPublish,
                    },
                  };
                }
                return model;
              }),
            })),
          };
        }
      );

      // Return a context object with the snapshotted value
      return { previousData };
    },
    onError: (error, variables, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousData) {
        utils.moderator.models.queryTraining.setInfiniteData(
          { limit: 20, username: debouncedUsernameFilter || undefined },
          context.previousData
        );
      }

      showNotification({
        title: 'Error',
        message: error.message,
        color: 'red',
      });
    },
    onSuccess: () => {
      showNotification({
        title: 'Success',
        message: 'Model publish status updated',
        color: 'green',
      });
    },
    onSettled: () => {
      // Always refetch after error or success to sync with server
      utils.moderator.models.queryTraining.invalidate();
    },
  });

  const handleToggleCannotPublish = (modelId: number) => {
    toggleCannotPublishMutation.mutate({ id: modelId });
  };

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

          {/* Username Filter */}
          <Card p="md" radius="md" withBorder>
            <Group gap="sm" align="center">
              <ThemeIcon size="sm" variant="light" color="gray" radius="md">
                <IconUser size={16} />
              </ThemeIcon>
              <TextInput
                placeholder="Filter by username (leave empty to show all)"
                value={usernameFilter}
                onChange={(event) => setUsernameFilter(event.currentTarget.value)}
                style={{ flex: 1 }}
                rightSection={
                  usernameFilter !== debouncedUsernameFilter ? <Loader size={16} /> : null
                }
              />
              {usernameFilter && (
                <Button size="xs" variant="light" onClick={() => setUsernameFilter('')}>
                  Clear
                </Button>
              )}
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
              {flatData?.map((model) => {
                const modelMeta = model.meta as ModelMeta | null;
                return (
                  <Card key={model.id} p="md" radius="md" withBorder className={classes.modelCard}>
                    <Stack gap="sm" h="100%">
                      {/* Compact Header with User */}
                      <div>
                        <Group gap="xs" mb="xs" align="flex-start">
                          <div style={{ flex: 1 }}>
                            <Text fw={700} size="lg" className={classes.modelTitle} lineClamp={2}>
                              {model.name}
                            </Text>
                          </div>
                          <Group gap="xs" align="center">
                            <UserAvatar user={model.user} size="xs" />
                            <Text size="xs" fw={500}>
                              {model.user.username}
                            </Text>
                          </Group>
                        </Group>

                        {/* Status and Type Badges */}
                        <Group gap="xs" wrap="wrap">
                          <Badge
                            color={model.status === 'Published' ? 'green' : 'orange'}
                            variant="light"
                            size="sm"
                          >
                            {model.status}
                          </Badge>
                          <Badge variant="outline" size="xs">
                            {model.type}
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
                          <Stack gap="xs">
                            {/* Version Header */}
                            <Group justify="space-between" align="flex-start">
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <Text fw={600} size="sm" lineClamp={1}>
                                  {version.name}
                                </Text>
                                <Text size="xs" c="dimmed">
                                  Created {formatDate(version.createdAt)}
                                </Text>
                              </div>
                              <Group gap="xs" style={{ flexShrink: 0 }}>
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
                            </Group>

                            {/* Moderation Actions */}
                            <Group gap="xs" justify="space-between">
                              <Text size="xs" c="dimmed" fw={500}>
                                Moderation Actions
                              </Text>
                              <Button
                                size="xs"
                                variant={modelMeta?.cannotPublish ? 'filled' : 'light'}
                                color={modelMeta?.cannotPublish ? 'red' : 'gray'}
                                onClick={() => handleToggleCannotPublish(model.id)}
                                loading={toggleCannotPublishMutation.isLoading}
                              >
                                {modelMeta?.cannotPublish ? 'Allow Publish' : 'Block Publish'}
                              </Button>
                            </Group>

                            {/* Version Badges */}
                            <Group gap="xs">
                              <Badge color="blue" variant="light" size="xs">
                                {version.status}
                              </Badge>
                              {version.baseModel && (
                                <Badge color="gray" variant="outline" size="xs">
                                  {version.baseModel}
                                </Badge>
                              )}
                              {version.trainingStatus && (
                                <Badge color="purple" variant="light" size="xs">
                                  {version.trainingStatus}
                                </Badge>
                              )}
                            </Group>

                            {/* Compact Training Files */}
                            <Stack gap="xs" w="100%" mt="sm">
                              {version.files.map((file) => {
                                const fileMetadata = file.metadata as ModelFileMetadata | null;
                                return (
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
                                          href={`/api/download/models/${version.id}?type=Training%20Data`}
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
                                      {fileMetadata && (
                                        <Group gap="xs">
                                          {fileMetadata.numImages && (
                                            <Badge variant="light" color="green" size="xs">
                                              {fileMetadata.numImages} img
                                            </Badge>
                                          )}
                                          {fileMetadata.numCaptions && (
                                            <Badge variant="light" color="blue" size="xs">
                                              {fileMetadata.numCaptions} cap
                                            </Badge>
                                          )}
                                        </Group>
                                      )}
                                    </Stack>
                                  </div>
                                );
                              })}
                            </Stack>
                          </Stack>
                        </div>
                      ))}
                    </Stack>
                  </Card>
                );
              })}
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
