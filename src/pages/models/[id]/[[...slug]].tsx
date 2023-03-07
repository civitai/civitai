import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Container,
  createStyles,
  Grid,
  Group,
  Menu,
  Stack,
  Text,
  Title,
  Alert,
  ThemeIcon,
  Tooltip,
  Rating,
  AspectRatio,
  Paper,
} from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { ModelStatus } from '@prisma/client';
import {
  IconBan,
  IconClock,
  IconDotsVertical,
  IconDownload,
  IconEdit,
  IconExclamationMark,
  IconFlag,
  IconHeart,
  IconLicense,
  IconMessage,
  IconMessageCircle2,
  IconRecycle,
  IconStar,
  IconTagOff,
  IconTrash,
} from '@tabler/icons';
import startCase from 'lodash/startCase';
import { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import Router, { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';

import { NotFound } from '~/components/AppLayout/NotFound';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { useInfiniteModelsFilters } from '~/components/InfiniteModels/InfiniteModelsFilters';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { ModelDiscussion } from '~/components/Model/ModelDiscussion/ModelDiscussion';
import { ModelVersions } from '~/components/Model/ModelVersions/ModelVersions';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber, formatKBytes } from '~/utils/number-helpers';
import { QS } from '~/utils/qs';
import { splitUppercase, removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';
import { VerifiedText } from '~/components/VerifiedText/VerifiedText';
import { scrollToTop } from '~/utils/scroll-utils';
import { RunButton } from '~/components/RunStrategy/RunButton';
import { MultiActionButton } from '~/components/MultiActionButton/MultiActionButton';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { ReportEntity } from '~/server/schema/report.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { PermissionIndicator } from '~/components/PermissionIndicator/PermissionIndicator';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { ModelFileAlert } from '~/components/Model/ModelFileAlert/ModelFileAlert';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { EarlyAccessAlert } from '~/components/Model/EarlyAccessAlert/EarlyAccessAlert';
import { HowToUseModel } from '~/components/Model/HowToUseModel/HowToUseModel';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { openRoutedContext } from '~/providers/RoutedContextProvider';
import { openContext } from '~/providers/CustomModalsProvider';
import { Announcements } from '~/components/Announcements/Announcements';
import { CreatorCard } from '~/components/CreatorCard/CreatorCard';
import { ModelById } from '~/types/router';
import { JoinPopover } from '~/components/JoinPopover/JoinPopover';
import { AnchorNoTravel } from '~/components/AnchorNoTravel/AnchorNoTravel';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { CivitiaLinkManageButton } from '~/components/CivitaiLink/CivitiaLinkManageButton';
import truncate from 'lodash/truncate';

//TODO - Break model query into multiple queries
/*
  - model details
  - model rank
  - model reviews
  - model-version (only fetch latest model version)
  - model-version rank
  - model-version reviews (for users who only want to see reviews for specific versions)
*/

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const params = (ctx.params ?? {}) as { id: string; slug: string[] };
    const id = Number(params.id);
    if (!isNumber(id)) return { notFound: true };

    await ssg?.model.getById.prefetch({ id });

    return {
      props: {
        id,
        slug: params.slug?.[0] ?? '',
      },
    };
  },
});

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
    paddingBottom: theme.spacing.xs * 0.8,

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
    minWidth: 56,
    minHeight: 56,
    borderRadius: '50%',

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

export default function ModelDetail({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const { classes, theme } = useStyles();
  const queryUtils = trpc.useContext();
  const filters = useInfiniteModelsFilters();
  const { connected: civitaiLinked } = useCivitaiLink();

  const discussionSectionRef = useRef<HTMLDivElement | null>(null);

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
      if (!isModerator || permanently) await Router.replace('/');

      showSuccessNotification({
        title: 'Your model has been deleted',
        message: 'Successfully deleted the model',
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
      queryUtils.model.getAll.setInfiniteData({ ...filters, favorites: true }, () => {
        return { pageParams: [], pages: [] };
      });
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

  // when a user navigates back in their browser, set the previous url with the query string model={id}
  useEffect(() => {
    Router.beforePopState(({ as, url }) => {
      if (as === '/' || as.startsWith('/?') || as.startsWith('/user/') || as.startsWith('/tag/')) {
        const [route, queryString] = as.split('?');
        const [, otherQueryString] = url.split('?');
        const queryParams = QS.parse(queryString);
        const otherParams = QS.parse(otherQueryString);
        Router.replace(
          { pathname: route, query: { ...queryParams, ...otherParams, model: id } },
          as,
          {
            shallow: true,
          }
        );

        return false;
      }

      return true;
    });

    return () => Router.beforePopState(() => true);
  }, [id]); // Add any state variables to dependencies array if needed.

  if (loadingModel) return <PageLoader />;
  if (!model) return <NotFound />;

  const isModerator = currentUser?.isModerator ?? false;
  const isOwner = model.user.id === currentUser?.id || isModerator;
  // const showNsfwRequested = router.query.showNsfw !== 'true';
  const userNotBlurringNsfw = currentUser?.blurNsfw !== false;
  const nsfw = userNotBlurringNsfw && model.nsfw === true;
  const isFavorite = favoriteModels.find((modelId) => modelId === id);
  const deleted = !!model.deletedAt && model.status === 'Deleted';

  const published = model.status === ModelStatus.Published;
  const isMuted = currentUser?.muted ?? false;

  // Latest version is the first one based on sorting (createdAt - desc)
  const latestVersion = model.modelVersions[0];
  const primaryFile = getPrimaryFile(latestVersion?.files, {
    format: currentUser?.preferredModelFormat,
    type: currentUser?.preferredPrunedModel ? 'Pruned Model' : undefined,
  });
  const inaccurate = model.modelVersions.some((version) => version.inaccurate);
  const hasPendingClaimReport = model.reportStats && model.reportStats.ownershipProcessing > 0;
  const onlyEarlyAccess = model.modelVersions.every((version) => version.earlyAccessDeadline);
  const canDiscuss =
    !isMuted && (!onlyEarlyAccess || currentUser?.isMember || currentUser?.isModerator);

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

  const handleDeleteModel = (options?: { permanently: boolean }) => {
    const { permanently = false } = options || {};

    openConfirmModal({
      title: 'Delete Model',
      children: permanently
        ? 'Are you sure you want to permanently delete this model? This action is destructive and cannot be reverted.'
        : 'Are you sure you want to delete this model? This action is destructive and you will have to contact support to restore your data.',
      centered: true,
      labels: { confirm: 'Delete Model', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', loading: deleteMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: () => {
        if (model) {
          deleteMutation.mutate({ id: model.id, permanently });
        }
      },
    });
  };

  const handleUnpublishModel = () => {
    unpublishModelMutation.mutate({ id });
  };

  const handleRestoreModel = () => {
    restoreModelMutation.mutate({ id });
  };

  const handleToggleFavorite = () => {
    toggleFavoriteModelMutation.mutate({ modelId: id });
  };

  const modelDetails: DescriptionTableProps['items'] = [
    {
      label: 'Type',
      value: (
        <Group spacing={0} noWrap position="apart">
          <Badge radius="sm" px={5}>
            {splitUppercase(model.type)} {model.checkpointType}
          </Badge>
          {model?.status !== ModelStatus.Published ? (
            <Badge color="yellow" radius="sm">
              {model.status}
            </Badge>
          ) : (
            <HowToUseModel type={model.type} />
          )}
        </Group>
      ),
    },
    {
      label: 'Downloads',
      value: <Text>{(model.rank?.downloadCountAllTime ?? 0).toLocaleString()}</Text>,
    },
    {
      label: 'Last Update',
      value: <Text>{formatDate(model.updatedAt)}</Text>,
    },
    {
      label: 'Versions',
      value: <Text>{model.modelVersions.length}</Text>,
    },
    {
      label: 'Base Model',
      value: <Text>{latestVersion?.baseModel}</Text>,
    },
    {
      label: 'Tags',
      value: (
        <Group spacing={4}>
          {model.tagsOnModels.map(({ tag }) => (
            <Link key={tag.id} href={`/tag/${encodeURIComponent(tag.name.toLowerCase())}`} passHref>
              <Badge key={tag.id} component="a" size="sm" radius="sm" sx={{ cursor: 'pointer' }}>
                {tag.name}
              </Badge>
            </Link>
          ))}
        </Group>
      ),
    },
    {
      label: 'Trigger Words',
      visible: !!latestVersion?.trainedWords?.length,
      value: (
        <TrainedWords trainedWords={latestVersion?.trainedWords} files={latestVersion?.files} />
      ),
    },
  ];

  const primaryFileDetails = primaryFile && (
    <Group position="apart" noWrap spacing={0}>
      <VerifiedText file={primaryFile} />
      <Text size="xs" color="dimmed">
        {primaryFile.type === 'Pruned Model' ? 'Pruned ' : ''}
        {primaryFile.format}
      </Text>
    </Group>
  );

  const downloadMenuItems = latestVersion?.files.map((file, index) => (
    <Menu.Item
      key={index}
      component="a"
      py={4}
      icon={<VerifiedText file={file} iconOnly />}
      href={createModelFileDownloadUrl({
        versionId: latestVersion.id,
        type: file.type,
        format: file.format,
      })}
      download
    >
      {`${startCase(file.type)}${
        ['Model', 'Pruned Model'].includes(file.type) ? ' ' + file.format : ''
      } (${formatKBytes(file.sizeKB)})`}
    </Menu.Item>
  ));
  const displayCivitaiLink = civitaiLinked && latestVersion?.hashes.length > 0;

  return (
    <>
      {meta}
      <Container size="xl" pb="xl">
        <Stack spacing={0}>
          <Announcements sx={{ marginBottom: 5 }} />
          <Stack spacing="xs" mb="xl">
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
                    onClick={() => handleToggleFavorite()}
                  >
                    <Text className={classes.modelBadgeText}>
                      {abbreviateNumber(model.rank?.favoriteCountAllTime ?? 0)}
                    </Text>
                  </IconBadge>
                </LoginRedirect>
                {!model.locked && (
                  <IconBadge
                    radius="sm"
                    color="gray"
                    size="lg"
                    icon={<Rating value={model.rank?.ratingAllTime ?? 0} fractions={4} readOnly />}
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
                      onClick={handleUnpublishModel}
                      disabled={unpublishModelMutation.isLoading}
                    >
                      Unpublish
                    </Menu.Item>
                  )}
                  {currentUser && isModerator && deleted && (
                    <Menu.Item
                      icon={<IconRecycle size={14} stroke={1.5} />}
                      color="green"
                      onClick={handleRestoreModel}
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
                        // component={NextLink}
                        // href={`/models/${id}/${slug}?edit=true`}
                        icon={<IconEdit size={14} stroke={1.5} />}
                        onClick={() => openRoutedContext('modelEdit', { modelId: model.id })}
                        // shallow
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
          <Grid gutter="xl">
            <Grid.Col xs={12} md={4} orderMd={2}>
              <Stack>
                <Box className={classes.mobileCarousel}>
                  <ModelCarousel model={model} latestVersion={latestVersion} mobile />
                </Box>
                <Group spacing="xs" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  {latestVersion.canDownload ? (
                    displayCivitaiLink ? (
                      <Stack sx={{ flex: 1 }} spacing={4}>
                        <CivitiaLinkManageButton
                          modelId={model.id}
                          modelVersionId={latestVersion.id}
                          modelName={model.name}
                          modelType={model.type}
                          hashes={latestVersion.hashes}
                          noTooltip
                        >
                          {({ color, onClick, ref, icon, label }) => (
                            <Button
                              ref={ref}
                              color={color}
                              onClick={onClick}
                              leftIcon={icon}
                              disabled={!primaryFile}
                            >
                              {label}
                            </Button>
                          )}
                        </CivitiaLinkManageButton>
                        {primaryFileDetails}
                      </Stack>
                    ) : (
                      <Stack sx={{ flex: 1 }} spacing={4}>
                        <MultiActionButton
                          component="a"
                          href={createModelFileDownloadUrl({
                            versionId: latestVersion.id,
                            primary: true,
                          })}
                          leftIcon={<IconDownload size={16} />}
                          disabled={!primaryFile}
                          menuItems={downloadMenuItems.length > 1 ? downloadMenuItems : []}
                          menuTooltip="Other Downloads"
                          download
                        >
                          <Text align="center">
                            {`Download Latest (${formatKBytes(primaryFile?.sizeKB ?? 0)})`}
                          </Text>
                        </MultiActionButton>
                        {primaryFileDetails}
                      </Stack>
                    )
                  ) : (
                    <Stack sx={{ flex: 1 }} spacing={4}>
                      <JoinPopover>
                        <Button leftIcon={<IconDownload size={16} />}>
                          <Text align="center">
                            {`Download Latest (${formatKBytes(primaryFile?.sizeKB ?? 0)})`}
                          </Text>
                        </Button>
                      </JoinPopover>
                      {primaryFileDetails}
                    </Stack>
                  )}
                  {displayCivitaiLink ? (
                    latestVersion.canDownload ? (
                      <Menu position="bottom-end">
                        <Menu.Target>
                          <Tooltip label="Download options" withArrow>
                            <Button px={0} w={36} variant="light">
                              <IconDownload />
                            </Button>
                          </Tooltip>
                        </Menu.Target>
                        <Menu.Dropdown>{downloadMenuItems}</Menu.Dropdown>
                      </Menu>
                    ) : (
                      <JoinPopover>
                        <Tooltip label="Download options" withArrow>
                          <Button px={0} w={36} variant="light">
                            <IconDownload />
                          </Button>
                        </Tooltip>
                      </JoinPopover>
                    )
                  ) : (
                    <RunButton modelVersionId={latestVersion.id} />
                  )}
                  <Tooltip label={isFavorite ? 'Unlike' : 'Like'} position="top" withArrow>
                    <div>
                      <LoginRedirect reason="favorite-model">
                        <Button
                          onClick={() => handleToggleFavorite()}
                          color={isFavorite ? 'red' : 'gray'}
                          sx={{ cursor: 'pointer', paddingLeft: 0, paddingRight: 0, width: '36px' }}
                        >
                          <IconHeart color="#fff" />
                        </Button>
                      </LoginRedirect>
                    </div>
                  </Tooltip>
                </Group>
                <EarlyAccessAlert
                  versionId={latestVersion.id}
                  modelType={model.type}
                  deadline={latestVersion.earlyAccessDeadline}
                />
                <ModelFileAlert
                  versionId={latestVersion.id}
                  modelType={model.type}
                  files={latestVersion.files}
                />
                <DescriptionTable items={modelDetails} labelWidth="30%" />
                <CreatorCard user={model.user} />

                <Group position="apart" align="flex-start" style={{ flexWrap: 'nowrap' }}>
                  {model?.type === 'Checkpoint' && (
                    <Group
                      spacing={4}
                      noWrap
                      style={{ flex: 1, overflow: 'hidden' }}
                      align="flex-start"
                    >
                      <IconLicense size={16} />
                      <Text
                        size="xs"
                        color="dimmed"
                        sx={{
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          lineHeight: 1.1,
                        }}
                      >
                        License{model?.licenses.length > 0 ? 's' : ''}:
                      </Text>
                      <Stack spacing={0}>
                        <Text
                          component="a"
                          href="https://huggingface.co/spaces/CompVis/stable-diffusion-license"
                          rel="nofollow"
                          td="underline"
                          target="_blank"
                          size="xs"
                          color="dimmed"
                          sx={{ lineHeight: 1.1 }}
                        >
                          creativeml-openrail-m
                        </Text>
                        {model?.licenses.map(({ url, name }) => (
                          <Text
                            key={name}
                            component="a"
                            rel="nofollow"
                            href={url}
                            td="underline"
                            size="xs"
                            color="dimmed"
                            target="_blank"
                            sx={{ lineHeight: 1.1 }}
                          >
                            {name}
                          </Text>
                        ))}
                      </Stack>
                    </Group>
                  )}
                  <PermissionIndicator spacing={5} size={28} permissions={model} ml="auto" />
                </Group>
                {hasPendingClaimReport && (
                  <AlertWithIcon icon={<IconMessageCircle2 />}>
                    {`A verified artist believes this model was fine-tuned on their art. We're discussing this with the model creator and artist`}
                  </AlertWithIcon>
                )}
              </Stack>
            </Grid.Col>
            <Grid.Col
              xs={12}
              md={8}
              orderMd={1}
              sx={(theme) => ({
                [theme.fn.largerThan('xs')]: {
                  padding: `0 ${theme.spacing.sm}px`,
                  margin: `${theme.spacing.sm}px 0`,
                },
              })}
            >
              <Stack>
                <Box className={classes.desktopCarousel}>
                  <ModelCarousel model={model} latestVersion={latestVersion} />
                </Box>
                {model.description ? (
                  <ContentClamp maxHeight={300}>
                    <RenderHtml html={model.description} withMentions />
                  </ContentClamp>
                ) : null}
              </Stack>
            </Grid.Col>
            <Grid.Col span={12} orderMd={3} my="xl">
              <Stack spacing="xl">
                <Title className={classes.title} order={2}>
                  Versions
                </Title>
                <ModelVersions
                  type={model.type}
                  items={model.modelVersions}
                  modelId={model.id}
                  modelName={model.name}
                  initialTab={latestVersion?.id.toString()}
                  nsfw={model.nsfw}
                  locked={model.locked}
                />
              </Stack>
            </Grid.Col>
            <Grid.Col span={12} orderMd={4} my="xl">
              {!model.locked ? (
                <Stack spacing="xl">
                  <Group ref={discussionSectionRef} sx={{ justifyContent: 'space-between' }}>
                    <Group spacing="xs">
                      <Title order={3}>Discussion</Title>

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
                  <ModelDiscussion modelId={model.id} />
                </Stack>
              ) : (
                <Paper p="lg">
                  <Center>
                    <Text size="sm">Discussions are turned off for this model.</Text>
                  </Center>
                </Paper>
              )}
            </Grid.Col>
          </Grid>
        </Stack>
      </Container>
    </>
  );
}

function ModelCarousel({
  model,
  latestVersion,
  mobile = false,
}: {
  model: ModelById;
  latestVersion: ModelById['modelVersions'][number];
  mobile?: boolean;
}) {
  const router = useRouter();
  const { classes } = useStyles();
  if (!latestVersion.images.length) return null;

  return (
    <Carousel
      key={model.id}
      slideSize="50%"
      breakpoints={[{ maxWidth: 'sm', slideSize: '100%', slideGap: 2 }]}
      slideGap="xl"
      classNames={{ control: classes.control }}
      align={latestVersion && latestVersion.images.length > 2 ? 'start' : 'center'}
      slidesToScroll={mobile ? 1 : 2}
      withControls={latestVersion && latestVersion.images.length > 2 ? true : false}
      loop
    >
      <ImageGuard
        images={latestVersion.images}
        nsfw={model.nsfw}
        connect={{ entityId: model.id, entityType: 'model' }}
        render={(image) => (
          <Carousel.Slide>
            <Center style={{ height: '100%', width: '100%' }}>
              <div style={{ width: '100%', position: 'relative' }}>
                <ImageGuard.ToggleConnect />
                <ImageGuard.ReportNSFW />
                <ImageGuard.Unsafe>
                  <AspectRatio
                    ratio={(image.width ?? 1) / (image.height ?? 1)}
                    sx={(theme) => ({
                      width: '100%',
                      borderRadius: theme.radius.md,
                      overflow: 'hidden',
                    })}
                  >
                    <MediaHash {...image} />
                  </AspectRatio>
                </ImageGuard.Unsafe>
                <ImageGuard.Safe>
                  <AnchorNoTravel
                    href={`/gallery/${image.id}?modelId=${model.id}&modelVersionId=${
                      latestVersion.id
                    }&infinite=false&returnUrl=${encodeURIComponent(router.asPath)}`}
                  >
                    <ImagePreview
                      image={image}
                      edgeImageProps={{ width: 400 }}
                      radius="md"
                      onClick={() =>
                        openRoutedContext('galleryDetailModal', {
                          galleryImageId: image.id,
                          modelId: model.id,
                          modelVersionId: latestVersion.id,
                          infinite: false,
                          returnUrl: Router.asPath,
                        })
                      }
                      style={{ width: '100%' }}
                      withMeta
                    />
                  </AnchorNoTravel>
                </ImageGuard.Safe>
              </div>
            </Center>
          </Carousel.Slide>
        )}
      />
    </Carousel>
  );
}
