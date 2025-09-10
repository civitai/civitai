import {
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
  ThemeIcon,
  Modal,
  ScrollArea,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import {
  IconDownload,
  IconEye,
  IconUser,
  IconCalendar,
  IconFilter,
  IconPhoto,
  IconWorkflow,
} from '@tabler/icons-react';
import { formatDate } from '~/utils/date-helpers';
import Link from 'next/link';
import { useMemo, useState, useEffect, useRef } from 'react';
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
import { fetchBlob } from '~/utils/file-utils';
import { getJSZip } from '~/utils/lazy';
import { unzipTrainingData } from '~/utils/training';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import classes from './training-models.module.scss';

export default function TrainingModerationFeedPage() {
  const currentUser = useCurrentUser();
  const [usernameFilter, setUsernameFilter] = useState('');
  const [debouncedUsernameFilter, setDebouncedUsernameFilter] = useState('');
  const [workflowIdFilter, setWorkflowIdFilter] = useState('');
  const [debouncedWorkflowIdFilter, setDebouncedWorkflowIdFilter] = useState('');
  const [dateFromFilter, setDateFromFilter] = useState<Date | null>(null);
  const [dateToFilter, setDateToFilter] = useState<Date | null>(null);
  const [cannotPublishFilter, setCannotPublishFilter] = useState<string>('all');

  // Image viewer state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerUrls, setViewerUrls] = useState<{ url: string; ext: string; name: string }[]>([]);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [currentVersionId, setCurrentVersionId] = useState<number | null>(null);
  const [currentModelInfo, setCurrentModelInfo] = useState<{
    modelName: string;
    versionName: string;
    status: string;
    baseModel?: string;
    type: string;
  } | null>(null);
  const requestedRef = useRef(false);

  // Debounce username filter
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedUsernameFilter(usernameFilter);
    }, 500);

    return () => clearTimeout(timer);
  }, [usernameFilter]);

  // Debounce workflowId filter
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedWorkflowIdFilter(workflowIdFilter);
    }, 500);

    return () => clearTimeout(timer);
  }, [workflowIdFilter]);

  const { data, isFetching, hasNextPage, fetchNextPage, isInitialLoading } =
    trpc.moderator.models.queryTraining.useInfiniteQuery(
      {
        limit: 20,
        username: debouncedUsernameFilter || undefined,
        workflowId: debouncedWorkflowIdFilter || undefined,
        dateFrom: dateFromFilter || undefined,
        dateTo: dateToFilter || undefined,
        cannotPublish:
          cannotPublishFilter === 'all' ? undefined : cannotPublishFilter === 'blocked',
      },
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
        {
          limit: 20,
          username: debouncedUsernameFilter || undefined,
          workflowId: debouncedWorkflowIdFilter || undefined,
          dateFrom: dateFromFilter || undefined,
          dateTo: dateToFilter || undefined,
          cannotPublish:
            cannotPublishFilter === 'all' ? undefined : cannotPublishFilter === 'blocked',
        },
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
          {
            limit: 20,
            username: debouncedUsernameFilter || undefined,
            workflowId: debouncedWorkflowIdFilter || undefined,
            dateFrom: dateFromFilter || undefined,
            dateTo: dateToFilter || undefined,
            cannotPublish:
              cannotPublishFilter === 'all' ? undefined : cannotPublishFilter === 'blocked',
          },
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

  const handleViewImages = async (
    versionId: number,
    modelInfo: {
      modelName: string;
      versionName: string;
      status: string;
      baseModel?: string;
      type: string;
    }
  ) => {
    if (currentVersionId === versionId && viewerUrls.length > 0) {
      setCurrentModelInfo(modelInfo);
      setViewerOpen(true);
      return;
    }

    setCurrentVersionId(versionId);
    setCurrentModelInfo(modelInfo);
    setViewerOpen(true);
    setViewerLoading(true);
    setViewerError(null);
    setViewerUrls([]);
    requestedRef.current = false;

    try {
      const zip = await fetchBlob(`/api/download/training-data/${versionId}`);
      if (zip) {
        const zipReader = await getJSZip();
        const zData = await zipReader.loadAsync(zip);
        const urls = await unzipTrainingData(zData, ({ imgBlob, fileExt, filename }) => {
          return {
            url: URL.createObjectURL(imgBlob),
            ext: fileExt,
            name: filename,
          };
        });
        setViewerUrls(urls);
      } else {
        setViewerError('Failed to download training data');
      }
    } catch (err) {
      console.error('Error loading training data:', err);
      setViewerError(err instanceof Error ? err.message : 'Failed to load training data');
    } finally {
      setViewerLoading(false);
    }
  };

  const handleCloseViewer = () => {
    setViewerOpen(false);
    // Clean up object URLs to prevent memory leaks
    viewerUrls.forEach(({ url }) => URL.revokeObjectURL(url));
    setViewerUrls([]);
    setViewerError(null);
    setCurrentModelInfo(null);
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

          {/* Filters */}
          <Card p="md" radius="md" withBorder>
            <Group gap="sm" align="center">
              <ThemeIcon size="sm" variant="light" color="blue" radius="md">
                <IconFilter size={16} />
              </ThemeIcon>
              <Stack gap="sm" style={{ flex: 1 }}>
                <Group gap="sm" wrap="wrap" align="flex-end">
                  {/* Username Filter */}
                  <TextInput
                    placeholder="Filter by username"
                    value={usernameFilter}
                    onChange={(event) => setUsernameFilter(event.currentTarget.value)}
                    leftSection={<IconUser size={16} />}
                    rightSection={
                      usernameFilter !== debouncedUsernameFilter ? <Loader size={16} /> : null
                    }
                    style={{ minWidth: 200, flex: 1 }}
                  />

                  {/* Workflow ID Filter */}
                  <TextInput
                    placeholder="Filter by workflow ID"
                    value={workflowIdFilter}
                    onChange={(event) => setWorkflowIdFilter(event.currentTarget.value)}
                    leftSection={<IconWorkflow size={16} />}
                    rightSection={
                      workflowIdFilter !== debouncedWorkflowIdFilter ? <Loader size={16} /> : null
                    }
                    style={{ minWidth: 200, flex: 1 }}
                  />

                  {/* Date Range Filter */}
                  <DateInput
                    placeholder="From date"
                    value={dateFromFilter}
                    onChange={setDateFromFilter}
                    leftSection={<IconCalendar size={16} />}
                    clearable
                    style={{ minWidth: 150 }}
                  />
                  <DateInput
                    placeholder="To date"
                    value={dateToFilter}
                    onChange={setDateToFilter}
                    leftSection={<IconCalendar size={16} />}
                    clearable
                    style={{ minWidth: 150 }}
                  />

                  {/* Cannot Publish Filter */}
                  <Select
                    placeholder="Publishing status"
                    data={[
                      { value: 'all', label: 'All models' },
                      { value: 'blocked', label: 'Blocked from publishing' },
                      { value: 'allowed', label: 'Allowed to publish' },
                    ]}
                    value={cannotPublishFilter}
                    onChange={(value) => setCannotPublishFilter(value || 'all')}
                    style={{ minWidth: 180 }}
                  />
                </Group>

                {/* Clear Filters Button */}
                {(usernameFilter ||
                  workflowIdFilter ||
                  dateFromFilter ||
                  dateToFilter ||
                  cannotPublishFilter !== 'all') && (
                  <Button
                    size="xs"
                    variant="light"
                    color="gray"
                    onClick={() => {
                      setUsernameFilter('');
                      setWorkflowIdFilter('');
                      setDateFromFilter(null);
                      setDateToFilter(null);
                      setCannotPublishFilter('all');
                    }}
                  >
                    Clear All Filters
                  </Button>
                )}
              </Stack>
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
                          {modelMeta?.cannotPublish && (
                            <Badge color="red" variant="filled" size="xs">
                              Blocked
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
                                  variant="light"
                                  color="green"
                                  leftSection={<IconPhoto size={14} />}
                                  onClick={() =>
                                    handleViewImages(version.id, {
                                      modelName: model.name,
                                      versionName: version.name,
                                      status: version.status,
                                      baseModel: version.baseModel || undefined,
                                      type: model.type,
                                    })
                                  }
                                >
                                  Images
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

        {/* Image Viewer Modal */}
        <Modal
          opened={viewerOpen}
          onClose={handleCloseViewer}
          size="90%"
          title={
            <Stack gap={8}>
              {currentModelInfo ? (
                <>
                  <Text fw={600} size="lg">
                    {currentModelInfo.modelName}
                  </Text>
                  <Group gap="xs" wrap="wrap">
                    <Badge variant="light" color="blue" size="sm">
                      {currentModelInfo.versionName}
                    </Badge>
                    <Badge
                      color={currentModelInfo.status === 'Published' ? 'green' : 'orange'}
                      variant="light"
                      size="sm"
                    >
                      {currentModelInfo.status}
                    </Badge>
                    <Badge variant="outline" size="sm">
                      {currentModelInfo.type}
                    </Badge>
                    {currentModelInfo.baseModel && (
                      <Badge color="gray" variant="outline" size="sm">
                        {currentModelInfo.baseModel}
                      </Badge>
                    )}
                  </Group>
                </>
              ) : (
                <Text fw={600}>Training Images</Text>
              )}
            </Stack>
          }
          centered
        >
          {viewerLoading ? (
            <Center py="xl">
              <Stack align="center" gap="sm">
                <Loader type="bars" size="lg" />
                <Text size="sm" c="dimmed">
                  Loading training images...
                </Text>
              </Stack>
            </Center>
          ) : viewerError ? (
            <Center py="xl">
              <Stack align="center" gap="sm">
                <Text size="sm" c="red">
                  {viewerError}
                </Text>
                <Button size="sm" variant="light" onClick={handleCloseViewer}>
                  Close
                </Button>
              </Stack>
            </Center>
          ) : viewerUrls.length === 0 ? (
            <Center py="xl">
              <Text size="sm" c="dimmed">
                No images found in training data
              </Text>
            </Center>
          ) : (
            <ScrollArea h={600}>
              <SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }} spacing="md" p="md">
                {viewerUrls.map(({ url, ext, name }, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-center overflow-hidden rounded-lg border bg-gray-50"
                  >
                    {IMAGE_MIME_TYPE.includes(`image/${ext}` as any) && (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={url}
                          alt={name}
                          className="h-auto max-h-64 w-full object-contain"
                          loading="lazy"
                          title={name}
                        />
                      </>
                    )}
                    {VIDEO_MIME_TYPE.includes(`video/${ext}` as any) && (
                      <video
                        disablePictureInPicture
                        playsInline
                        controls
                        muted
                        loop
                        preload="metadata"
                        className="h-auto max-h-64 w-full"
                        title={name}
                      >
                        <source src={url} type={`video/${ext}`} />
                      </video>
                    )}
                  </div>
                ))}
              </SimpleGrid>
            </ScrollArea>
          )}
        </Modal>
      </div>
    </>
  );
}
