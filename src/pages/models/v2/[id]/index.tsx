import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Container,
  createStyles,
  Divider,
  Group,
  Menu,
  Paper,
  Rating,
  ScrollArea,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import { ModelStatus } from '@prisma/client';
import {
  IconClock,
  IconExclamationMark,
  IconHeart,
  IconMessage,
  IconPlus,
  IconStar,
  IconDotsVertical,
  IconBan,
  IconRecycle,
  IconTrash,
  IconEdit,
  IconFlag,
  IconTagOff,
  IconAlertTriangle,
  IconDownload,
} from '@tabler/icons';
import truncate from 'lodash/truncate';
import { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useRef, useState } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { Announcements } from '~/components/Announcements/Announcements';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { NotFound } from '~/components/AppLayout/NotFound';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { JoinPopover } from '~/components/JoinPopover/JoinPopover';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { ModelDiscussion } from '~/components/Model/ModelDiscussion/ModelDiscussion';
import { ModelVersionDetails } from '~/components/Model/ModelVersions/ModelVersionDetails';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { openRoutedContext } from '~/providers/RoutedContextProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { scrollToTop } from '~/utils/scroll-utils';
import { removeTags, splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';
import { Collection } from '~/components/Collection/Collection';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  prefetch: 'always',
  resolver: async ({ ssg, ctx }) => {
    const params = (ctx.params ?? {}) as { id: string; slug: string[] };
    const id = Number(params.id);
    if (!isNumber(id)) return { notFound: true };

    await ssg?.model.getById.prefetch({ id });

    return {
      props: {
        id,
      },
    };
  },
});

export default function ModelDetailsV2({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { classes, theme } = useStyles();
  const queryUtils = trpc.useContext();

  const discussionSectionRef = useRef<HTMLDivElement | null>(null);
  const [selectedTab, setSelectedTab] = useState<string | null>(null);

  const { data: model, isLoading: loadingModel } = trpc.model.getById.useQuery({ id });
  const { data: { Favorite: favoriteModels = [] } = { Favorite: [] } } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });

  const deleteMutation = trpc.model.delete.useMutation({
    async onSuccess(_, { permanently }) {
      await queryUtils.model.getAll.invalidate();
      if (!permanently) await queryUtils.model.getById.invalidate({ id });
      if (!isModerator || permanently) await router.replace('/');

      showSuccessNotification({
        title: 'Successfully deleted the model',
        message: 'Your model has been deleted',
      });
      closeAllModals();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not delete model',
        reason: 'An unexpected error occurred, please try again',
      });
    },
  });
  const handleDeleteModel = (options?: { permanently: boolean }) => {
    const { permanently = false } = options || {};

    openConfirmModal({
      title: 'Delete Model',
      children: permanently
        ? 'Are you sure you want to permanently delete this model? This action is destructive and cannot be reverted.'
        : 'Are you sure you want to delete this model? This action is destructive and you will have to contact support to restore your data.',
      centered: true,
      labels: { confirm: 'Delete Model', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', disabled: deleteMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => {
        if (model) {
          deleteMutation.mutate({ id: model.id, permanently });
        }
      },
    });
  };

  const unpublishModelMutation = trpc.model.unpublish.useMutation({
    async onSuccess() {
      await queryUtils.model.getById.invalidate({ id });
    },
    onError(error) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });
  const restoreModelMutation = trpc.model.restore.useMutation({
    async onSuccess() {
      await queryUtils.model.getById.invalidate({ id });
      await queryUtils.model.getAll.invalidate();
    },
    onError(error) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });
  const toggleFavoriteModelMutation = trpc.user.toggleFavoriteModel.useMutation({
    async onMutate({ modelId }) {
      await queryUtils.user.getEngagedModels.cancel();

      const previousEngaged = queryUtils.user.getEngagedModels.getData() ?? {
        Favorite: [],
        Hide: [],
      };
      const previousModel = queryUtils.model.getById.getData({ id: modelId });
      const shouldRemove = previousEngaged.Favorite?.find((id) => id === modelId);
      // Update the favorite count
      queryUtils.model.getById.setData({ id: modelId }, (model) => {
        if (model?.rank) model.rank.favoriteCountAllTime += shouldRemove ? -1 : 1;
        return model;
      });
      // Remove from favorites list
      queryUtils.user.getEngagedModels.setData(
        undefined,
        ({ Favorite = [], ...old } = { Favorite: [], Hide: [] }) => {
          if (shouldRemove) return { Favorite: Favorite.filter((id) => id !== modelId), ...old };
          return { Favorite: [...Favorite, modelId], ...old };
        }
      );

      return { previousEngaged, previousModel };
    },
    async onSuccess() {
      await queryUtils.model.getAll.invalidate({ favorites: true });
    },
    onError(_error, _variables, context) {
      queryUtils.user.getEngagedModels.setData(undefined, context?.previousEngaged);
      if (context?.previousModel?.id)
        queryUtils.model.getById.setData(
          { id: context?.previousModel?.id },
          context?.previousModel
        );
    },
  });

  const deleteVersionMutation = trpc.modelVersion.delete.useMutation({
    async onSuccess() {
      if (latestVersion) setSelectedTab(latestVersion.id.toString());
      await queryUtils.model.getById.invalidate({ id });
      closeAllModals();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Unable to delete version',
        reason: 'An unexpected error occurred, please try again',
      });
    },
  });
  const handleDeleteVersion = (versionId: number) => {
    openConfirmModal({
      title: 'Delete Version',
      children:
        'Are you sure you want to delete this version? This action is destructive and cannot be reverted.',
      centered: true,
      labels: { confirm: 'Delete Version', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', disabled: deleteVersionMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => deleteVersionMutation.mutate({ id: versionId }),
    });
  };

  if (loadingModel) return <PageLoader />;
  if (!model) return <NotFound />;

  const isModerator = currentUser?.isModerator ?? false;
  const isOwner = model.user.id === currentUser?.id || isModerator;
  const userNotBlurringNsfw = currentUser?.blurNsfw !== false;
  const nsfw = userNotBlurringNsfw && model.nsfw === true;
  const latestVersion = model.modelVersions[0];

  const meta = (
    <Meta
      title={`${model.name} | Stable Diffusion ${model.type} | Civitai`}
      description={truncate(removeTags(model.description ?? ''), { length: 150 })}
      image={
        nsfw || latestVersion?.images[0]?.url == null
          ? undefined
          : getEdgeUrl(latestVersion.images[0].url, { width: 1200 })
      }
    />
  );

  if (model.nsfw && !currentUser)
    return (
      <>
        {meta}
        <SensitiveShield />
      </>
    );

  const isFavorite = favoriteModels.find((modelId) => modelId === id);
  const deleted = !!model.deletedAt && model.status === 'Deleted';
  const published = model.status === ModelStatus.Published;
  const inaccurate = model.modelVersions.some((version) => version.inaccurate);
  const isMuted = currentUser?.muted ?? false;
  const onlyEarlyAccess = model.modelVersions.every((version) => version.earlyAccessDeadline);
  const canDiscuss =
    !isMuted && (!onlyEarlyAccess || currentUser?.isMember || currentUser?.isModerator);
  const versionCount = model.modelVersions.length;

  return (
    <>
      {meta}
      <Container size="xl">
        <Stack spacing="xl">
          <Announcements sx={{ marginBottom: 5 }} />
          <Stack spacing="xs">
            <Stack spacing={4}>
              <Group align="center" sx={{ justifyContent: 'space-between' }} noWrap>
                <Group className={classes.titleWrapper} align="center">
                  <Title className={classes.title} order={1}>
                    {model?.name}
                  </Title>
                  <LoginRedirect reason="favorite-model">
                    <IconBadge
                      radius="sm"
                      color={isFavorite ? 'red' : 'gray'}
                      size="lg"
                      icon={
                        <IconHeart
                          size={18}
                          color={isFavorite ? theme.colors.red[6] : undefined}
                          style={{ fill: isFavorite ? theme.colors.red[6] : undefined }}
                        />
                      }
                      sx={{ cursor: 'pointer' }}
                      onClick={() => toggleFavoriteModelMutation.mutate({ modelId: id })}
                    >
                      <Text className={classes.modelBadgeText}>
                        {abbreviateNumber(model.rank?.favoriteCountAllTime ?? 0)}
                      </Text>
                    </IconBadge>
                  </LoginRedirect>
                  <IconBadge radius="sm" size="lg" icon={<IconDownload size={18} />}>
                    <Text className={classes.modelBadgeText}>
                      {abbreviateNumber(model.rank?.downloadCountAllTime ?? 0)}
                    </Text>
                  </IconBadge>
                  {!model.locked && (
                    <IconBadge
                      radius="sm"
                      color="gray"
                      size="lg"
                      icon={
                        <Rating value={model.rank?.ratingAllTime ?? 0} fractions={4} readOnly />
                      }
                      sx={{ cursor: 'pointer' }}
                      onClick={() => {
                        if (!discussionSectionRef.current) return;
                        scrollToTop(discussionSectionRef.current);
                      }}
                    >
                      <Text className={classes.modelBadgeText}>
                        {abbreviateNumber(model.rank?.ratingCountAllTime ?? 0)}
                      </Text>
                    </IconBadge>
                  )}
                  {latestVersion?.earlyAccessDeadline && (
                    <IconBadge radius="sm" color="green" size="lg" icon={<IconClock size={18} />}>
                      Early Access
                    </IconBadge>
                  )}
                </Group>
                <Menu position="bottom-end" transition="pop-top-right">
                  <Menu.Target>
                    <ActionIcon variant="outline">
                      <IconDotsVertical size={16} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {currentUser && isOwner && published && (
                      <Menu.Item
                        icon={<IconBan size={14} stroke={1.5} />}
                        color="yellow"
                        onClick={() => unpublishModelMutation.mutate({ id })}
                        disabled={unpublishModelMutation.isLoading}
                      >
                        Unpublish
                      </Menu.Item>
                    )}
                    {currentUser && isModerator && deleted && (
                      <Menu.Item
                        icon={<IconRecycle size={14} stroke={1.5} />}
                        color="green"
                        onClick={() => restoreModelMutation.mutate({ id })}
                        disabled={restoreModelMutation.isLoading}
                      >
                        Restore
                      </Menu.Item>
                    )}
                    {currentUser && isModerator && (
                      <Menu.Item
                        color={theme.colors.red[6]}
                        icon={<IconTrash size={14} stroke={1.5} />}
                        onClick={() => handleDeleteModel({ permanently: true })}
                      >
                        Permanently Delete Model
                      </Menu.Item>
                    )}
                    {currentUser && isOwner && !deleted && (
                      <>
                        <Menu.Item
                          color={theme.colors.red[6]}
                          icon={<IconTrash size={14} stroke={1.5} />}
                          onClick={() => handleDeleteModel()}
                        >
                          Delete Model
                        </Menu.Item>
                        <Menu.Item
                          component={NextLink}
                          href={`/models/v2/${id}/edit`}
                          icon={<IconEdit size={14} stroke={1.5} />}
                          shallow
                        >
                          Edit Model
                        </Menu.Item>
                      </>
                    )}
                    {(!currentUser || !isOwner || isModerator) && (
                      <LoginRedirect reason="report-model">
                        <Menu.Item
                          icon={<IconFlag size={14} stroke={1.5} />}
                          onClick={() =>
                            openContext('report', {
                              entityType: ReportEntity.Model,
                              entityId: model.id,
                            })
                          }
                        >
                          Report
                        </Menu.Item>
                      </LoginRedirect>
                    )}
                    {currentUser && (
                      <>
                        <HideUserButton as="menu-item" userId={model.user.id} />
                        <HideModelButton as="menu-item" modelId={model.id} />
                        <Menu.Item
                          icon={<IconTagOff size={14} stroke={1.5} />}
                          onClick={() => openContext('blockModelTags', { modelId: model.id })}
                        >
                          Hide content with these tags
                        </Menu.Item>
                      </>
                    )}
                  </Menu.Dropdown>
                </Menu>
              </Group>
              <Group spacing={4}>
                <Text size="xs" color="dimmed">
                  Last updated: {formatDate(model.updatedAt)}
                </Text>
                {model.tagsOnModels.length > 0 && <Divider orientation="vertical" />}
                <Collection
                  items={model.tagsOnModels}
                  renderItem={({ tag }) => (
                    <Link href={`/tag/${encodeURIComponent(tag.name.toLowerCase())}`} passHref>
                      <Badge component="a" size="sm" sx={{ cursor: 'pointer' }}>
                        {tag.name}
                      </Badge>
                    </Link>
                  )}
                />
              </Group>
            </Stack>
            {(model.status === ModelStatus.Unpublished || deleted) && (
              <Alert color="red">
                <Group spacing="xs" noWrap align="flex-start">
                  <ThemeIcon color="red">
                    <IconExclamationMark />
                  </ThemeIcon>
                  <Text size="md">
                    This model has been {deleted ? 'deleted' : 'unpublished'} and is not visible to
                    the community.
                  </Text>
                </Group>
              </Alert>
            )}
            {inaccurate && (
              <Alert color="yellow">
                <Group spacing="xs" noWrap align="flex-start">
                  <ThemeIcon color="yellow">
                    <IconExclamationMark />
                  </ThemeIcon>
                  <Text size="md">
                    The images on this {splitUppercase(model.type).toLowerCase()} are inaccurate.
                    Please submit reviews with images so that we can improve this page.
                  </Text>
                </Group>
              </Alert>
            )}
          </Stack>
          <Tabs
            value={selectedTab ?? latestVersion?.id.toString()}
            onTabChange={setSelectedTab}
            keepMounted={false}
          >
            <ScrollArea type="never">
              <Tabs.List sx={{ flexWrap: 'nowrap' }}>
                {model.modelVersions.map((version) => (
                  <Tabs.Tab
                    key={version.id}
                    value={version.id.toString()}
                    icon={
                      !version.files.length ? (
                        <ThemeIcon
                          color="yellow"
                          variant="light"
                          radius="xl"
                          size="sm"
                          sx={{ backgroundColor: 'transparent' }}
                        >
                          <IconAlertTriangle size={14} />
                        </ThemeIcon>
                      ) : undefined
                    }
                    rightSection={
                      isOwner || isModerator ? (
                        <Menu withinPortal>
                          <Menu.Target>
                            <Box
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                              }}
                            >
                              <IconDotsVertical size={14} />
                            </Box>
                          </Menu.Target>
                          <Menu.Dropdown>
                            {versionCount > 1 && (
                              <Menu.Item
                                color="red"
                                icon={<IconTrash size={14} stroke={1.5} />}
                                onClick={() => handleDeleteVersion(version.id)}
                              >
                                Delete version
                              </Menu.Item>
                            )}
                            <Menu.Item
                              component={NextLink}
                              icon={<IconEdit size={14} stroke={1.5} />}
                              href={`/models/v2/${id}/model-versions/${version.id}/edit`}
                            >
                              Edit
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      ) : undefined
                    }
                  >
                    {version.name}
                  </Tabs.Tab>
                ))}
                {isOwner || isModerator ? (
                  <Tooltip label="Add new version" withinPortal>
                    <ActionIcon
                      aria-label="Add new version"
                      radius="xl"
                      sx={{ alignSelf: 'center' }}
                      onClick={() =>
                        router.push(`/models/v2/${model.id}/model-versions/new`, undefined, {
                          shallow: true,
                        })
                      }
                    >
                      <IconPlus stroke={1.5} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
              </Tabs.List>
            </ScrollArea>
            {model.modelVersions.map((version) => (
              <Tabs.Panel key={version.id} value={version.id.toString()}>
                <ModelVersionDetails model={model} version={version} user={currentUser} />
              </Tabs.Panel>
            ))}
          </Tabs>

          {model.description ? (
            <ContentClamp maxHeight={300}>
              <RenderHtml html={model.description} withMentions />
            </ContentClamp>
          ) : null}
          {!model.locked ? (
            <Stack spacing="xl">
              <Group ref={discussionSectionRef} sx={{ justifyContent: 'space-between' }}>
                <Group spacing="xs">
                  <Title order={2}>Discussion</Title>

                  {canDiscuss ? (
                    <>
                      <LoginRedirect reason="create-review">
                        <Button
                          className={classes.discussionActionButton}
                          leftIcon={<IconStar size={16} />}
                          variant="outline"
                          size="xs"
                          onClick={() => openRoutedContext('reviewEdit', {})}
                        >
                          Add Review
                        </Button>
                      </LoginRedirect>
                      <LoginRedirect reason="create-comment">
                        <Button
                          className={classes.discussionActionButton}
                          leftIcon={<IconMessage size={16} />}
                          variant="outline"
                          onClick={() => openRoutedContext('commentEdit', {})}
                          size="xs"
                        >
                          Add Comment
                        </Button>
                      </LoginRedirect>
                    </>
                  ) : (
                    !isMuted && (
                      <JoinPopover message="You must be a Supporter Tier member to join this discussion">
                        <Button
                          className={classes.discussionActionButton}
                          leftIcon={<IconClock size={16} />}
                          variant="outline"
                          size="xs"
                          color="green"
                        >
                          Early Access
                        </Button>
                      </JoinPopover>
                    )
                  )}
                </Group>
              </Group>
              <ModelDiscussion modelId={model.id} limit={4} />
            </Stack>
          ) : (
            <Paper p="lg">
              <Center>
                <Text size="sm">Discussions are turned off for this model.</Text>
              </Center>
            </Paper>
          )}
        </Stack>
      </Container>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  actions: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
    },
  },

  titleWrapper: {
    gap: theme.spacing.xs,

    [theme.fn.smallerThan('md')]: {
      gap: theme.spacing.xs * 0.4,
    },
  },

  title: {
    [theme.fn.smallerThan('md')]: {
      fontSize: theme.fontSizes.xs * 2.4, // 24px
      width: '100%',
      paddingBottom: 0,
    },
  },

  engagementBar: {
    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },

  mobileCarousel: {
    display: 'none',
    [theme.fn.smallerThan('md')]: {
      display: 'block',
    },
  },
  desktopCarousel: {
    display: 'block',
    [theme.fn.smallerThan('md')]: {
      display: 'none',
    },
  },

  modelBadgeText: {
    fontSize: theme.fontSizes.md,
    [theme.fn.smallerThan('md')]: {
      fontSize: theme.fontSizes.sm,
    },
  },

  discussionActionButton: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',
    },
  },

  // Increase carousel control arrow size
  control: {
    svg: {
      width: 24,
      height: 24,

      [theme.fn.smallerThan('sm')]: {
        minWidth: 16,
        minHeight: 16,
      },
    },

    [theme.fn.smallerThan('sm')]: {
      minWidth: 32,
      minHeight: 32,
    },
  },
}));
