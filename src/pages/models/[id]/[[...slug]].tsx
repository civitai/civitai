import {
  Alert,
  Anchor,
  Badge,
  Box,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  useComputedColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import {
  IconArchive,
  IconArrowsLeftRight,
  IconBan,
  IconBolt,
  IconBookmark,
  IconBrush,
  IconCircleMinus,
  IconClock,
  IconDotsVertical,
  IconDownload,
  IconEdit,
  IconExclamationMark,
  IconFlag,
  IconInfoCircle,
  IconLock,
  IconLockOff,
  IconPlus,
  IconRadar2,
  IconRecycle,
  IconReload,
  IconRepeat,
  IconTagOff,
  IconTrash,
} from '@tabler/icons-react';
import { truncate } from 'lodash-es';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState, useMemo } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { RenderAdUnitOutstream } from '~/components/Ads/AdUnitOutstream';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AssociatedModels } from '~/components/AssociatedModels/AssociatedModels';
import {
  BidModelButton,
  getEntityDataForBidModelButton,
} from '~/components/Auction/BidModelButton';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { Collection } from '~/components/Collection/Collection';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { openBlockModelTagsModal } from '~/components/Dialog/triggers/block-model-tags';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { openUnpublishModal } from '~/components/Dialog/triggers/unpublish';
import { HelpButton } from '~/components/HelpButton/HelpButton';
import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';

const MigrateModelToCollection = dynamic(
  () => import('~/components/Model/Actions/MigrateModelToCollection'),
  { ssr: false }
);
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { StatHoverCard } from '~/components/Stats/StatHoverCard';
import { useQueryImages } from '~/components/Image/image.utils';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
// import { ImageFiltersDropdown } from '~/components/Image/Infinite/ImageFiltersDropdown';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { AddToCollectionMenuItem } from '~/components/MenuItems/AddToCollectionMenuItem';
import { ToggleSearchableMenuItem } from '~/components/MenuItems/ToggleSearchableMenuItem';
import { Meta } from '~/components/Meta/Meta';
import { ReorderVersionsModal } from '~/components/Modals/ReorderVersionsModal';
import { ToggleLockModel } from '~/components/Model/Actions/ToggleLockModel';
import { ToggleLockModelComments } from '~/components/Model/Actions/ToggleLockModelComments';
import { ToggleModelNotification } from '~/components/Model/Actions/ToggleModelNotification';
import { HowToButton } from '~/components/Model/HowToUseModel/HowToUseModel';
import { ModelVersionList } from '~/components/Model/ModelVersionList/ModelVersionList';
import { useModelVersionPermission } from '~/components/Model/ModelVersions/model-version.utils';
import { ModelVersionDetails } from '~/components/Model/ModelVersions/ModelVersionDetails';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { AddToShowcaseMenuItem } from '~/components/Profile/AddToShowcaseMenuItem';
import { useToggleFavoriteMutation } from '~/components/ResourceReview/resourceReview.utils';
import { GenerateButton } from '~/components/RunStrategy/GenerateButton';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { TrackView } from '~/components/TrackView/TrackView';
import { env } from '~/env/client';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import useIsClient from '~/hooks/useIsClient';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { CAROUSEL_LIMIT } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { unpublishReasons } from '~/server/common/moderation-helpers';
import type { ModelMeta } from '~/server/schema/model.schema';
import { ReportEntity } from '~/server/schema/report.schema';
import { hasEntityAccess } from '~/server/services/common.service';
import { getDefaultModelVersion } from '~/server/services/model-version.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { ModelModifier } from '~/shared/utils/prisma/enums';
import { Availability, CollectionType, ModelStatus, ModelType } from '~/shared/utils/prisma/enums';
import type { ModelById } from '~/types/router';
import { formatDate, isFutureDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName, removeTags, slugit, splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

import classes from './[[...slug]].module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ModelDiscussion } from '~/components/Model/Discussion/ModelDiscussion';
import { ModelGallery } from '~/components/Model/Gallery/ModelGallery';
import { getBaseModelSeoName } from '~/shared/constants/base-model.constants';
import { AdUnitTop } from '~/components/Ads/AdUnit';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, ctx, session }) => {
    const params = (ctx.params ?? {}) as {
      id: string;
      slug: string[];
    };
    const query = ctx.query as {
      modelVersionId: string;
    };
    const id = Number(params.id);
    const modelVersionId = query.modelVersionId ? Number(query.modelVersionId) : undefined;
    if (!isNumber(id)) return { notFound: true };
    const version = await getDefaultModelVersion({ modelId: id, modelVersionId }).catch(() => null);
    const modelVersionIdParsed = modelVersionId ?? version?.id;

    if (!modelVersionIdParsed && !session?.user?.isModerator) {
      return { notFound: true };
    }

    if (version?.model?.availability === Availability.Private) {
      // We'll do a explicit check if we know it's a private model
      if (!session?.user) {
        return {
          notFound: true,
        };
      }

      const [access] = await hasEntityAccess({
        entityIds: [version?.model.id],
        entityType: 'Model',
        userId: session.user.id,
        isModerator: session.user.isModerator,
      });

      if (!access.hasAccess) {
        return {
          notFound: true,
        };
      }
    }

    if (version?.availability === Availability.Private) {
      // We'll do a explicit check if we know it's a private model
      if (!session?.user) {
        return {
          notFound: true,
        };
      }

      const [access] = await hasEntityAccess({
        entityIds: [version.id],
        entityType: 'ModelVersion',
        userId: session.user.id,
        isModerator: session.user.isModerator,
      });

      if (!access.hasAccess) {
        return {
          notFound: true,
        };
      }
    }

    const isTraining = !!version?.trainingStatus;
    const draft = version?.status === 'Draft';
    const isOwner = version?.model.userId === session?.user?.id;
    // TODO: Commenting cause @ally found it's ideal to be able to enter a models' page even if it's unpublished.
    // if (isTraining && isOwner) {
    //   // Start checking whether to redirect:
    //   if (draft) {
    //     return {
    //       redirect: {
    //         destination: `/models/${version.model.id}/model-versions/${version.id}/wizard?step=1`,
    //         permanent: false,
    //       },
    //     };
    //   }
    // }

    if (ssg) {
      // if (version)
      //   await ssg.image.getInfinite.prefetchInfinite({
      //     modelVersionId: version.id,
      //     prioritizedUserIds: [version.model.userId],
      //     period: 'AllTime',
      //     sort: ImageSort.MostReactions,
      //     limit: CAROUSEL_LIMIT,
      //     pending: true,
      //   });
      await ssg.hiddenPreferences.getHidden.prefetch();

      if (modelVersionIdParsed) {
        await ssg.common.getEntityAccess.prefetch({
          entityId: modelVersionIdParsed as number,
          entityType: 'ModelVersion',
        });

        // await ssg.common.getEntityClubRequirement.prefetch({
        //   entityId: modelVersionIdParsed as number,
        //   entityType: 'ModelVersion',
        // });
        // await ssg.generation.checkResourcesCoverage.prefetch({ id: modelVersionIdParsed });
      }
      await ssg.model.getById.prefetch({ id, excludeTrainingData: true });
      await ssg.model.getCollectionShowcase.prefetch({ id });
      if (session) {
        await ssg.user.getEngagedModelVersions.prefetch({ id });
        await ssg.resourceReview.getUserResourceReview.prefetch({ modelId: id });
      }
    }

    return {
      props: { id },
    };
  },
});

type ModelVersionDetail = ModelById['modelVersions'][number];

export default function ModelDetailsV2({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();

  const router = useRouter();
  const colorScheme = useComputedColorScheme('dark');
  const queryUtils = trpc.useUtils();
  const isClient = useIsClient();
  const features = useFeatureFlags();
  const { activeTour, running, runTour } = useTourContext();

  const [opened, { toggle }] = useDisclosure();
  const discussionSectionRef = useRef<HTMLDivElement | null>(null);
  const gallerySectionRef = useRef<HTMLDivElement | null>(null);

  const { blockedUsers } = useHiddenPreferencesData();

  const { data: model, isLoading: loadingModel } = trpc.model.getById.useQuery(
    { id, excludeTrainingData: true },
    {
      onSuccess(result) {
        const latestVersion = result.modelVersions[0];
        if (latestVersion) setSelectedVersion(latestVersion);
      },
    }
  );
  const browsingSettingsAddons = useBrowsingSettingsAddons();

  const rawVersionId = router.query.modelVersionId;
  const modelVersionId = Number(
    (Array.isArray(rawVersionId) ? rawVersionId[0] : rawVersionId) ?? model?.modelVersions[0]?.id
  );

  const { data: { Recommended: reviewedModels = [] } = { Recommended: [] } } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });
  const isFavorite = model && reviewedModels.includes(model.id);

  const isModerator = currentUser?.isModerator ?? false;
  const isCreator = model?.user.id === currentUser?.id;
  const isOwner = isCreator || isModerator;
  const publishedVersions = useMemo(() => {
    return !isOwner
      ? model?.modelVersions.filter((v) => v.status === ModelStatus.Published) ?? []
      : model?.modelVersions ?? [];
  }, [isOwner, model?.modelVersions]);
  const latestVersion =
    publishedVersions.find((version) => version.id === modelVersionId) ??
    publishedVersions[0] ??
    null;
  const [selectedVersion, setSelectedVersion] = useState<ModelVersionDetail | null>(latestVersion);
  const selectedEcosystemName = getBaseModelSeoName(selectedVersion?.baseModel);
  const tippedAmount = useBuzzTippingStore({ entityType: 'Model', entityId: model?.id ?? -1 });
  const buzzEarned =
    tippedAmount +
    (model?.rank?.tippedAmountCountAllTime ?? 0) +
    (model?.modelVersions?.reduce(
      (acc, version) => acc + (version.rank?.earnedAmountAllTime ?? 0),
      0
    ) ?? 0);

  const { canDownload: hasDownloadPermissions, canGenerate: hasGeneratePermissions } =
    useModelVersionPermission({ modelVersionId: selectedVersion?.id });

  const latestGenerationVersion = publishedVersions.find((version) => version.canGenerate);

  // TODO change this to just grab one image, since that's all it's used for
  const { images: versionImages, isLoading: loadingImages } = useQueryImages(
    {
      modelVersionId: latestVersion?.id,
      prioritizedUserIds: model ? [model.user.id] : undefined,
      period: 'AllTime',
      sort: ImageSort.MostReactions,
      limit: CAROUSEL_LIMIT,
      pending: true,
      include: [],
      withMeta: false,
    },
    { enabled: !!latestVersion }
  );

  const deleteMutation = trpc.model.delete.useMutation({
    async onSuccess(_, { permanently }) {
      await queryUtils.model.getAll.invalidate();
      if (!permanently) await queryUtils.model.getById.invalidate({ id });
      if (!isModerator || permanently) await router.replace('/models');

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
        reason: error.message ?? 'An unexpected error occurred, please try again',
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
  const publishModelMutation = trpc.model.publish.useMutation({
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

  const handleCollect = () => {
    openAddToCollectionModal({
      props: {
        modelId: id,
        type: CollectionType.Model,
      },
    });
  };

  const changeModeMutation = trpc.model.changeMode.useMutation();
  const handleChangeMode = async (mode: ModelModifier | null) => {
    const prevModel = queryUtils.model.getById.getData({ id });
    await queryUtils.model.getById.cancel({ id });

    if (prevModel)
      queryUtils.model.getById.setData(
        { id },
        { ...prevModel, mode, meta: (prevModel.meta as ModelMeta) ?? null }
      );

    changeModeMutation.mutate(
      { id, mode },
      {
        async onSuccess() {
          await queryUtils.model.getById.invalidate({ id });
        },
        onError(error) {
          showErrorNotification({
            title: 'Unable to change mode',
            error: new Error(error.message),
          });
          queryUtils.model.getById.setData({ id }, prevModel);
        },
      }
    );
  };

  const rescanModelMutation = trpc.model.rescan.useMutation();
  const handleRescanModel = async () => {
    rescanModelMutation.mutate({ id });
  };

  const favoriteMutation = useToggleFavoriteMutation();
  const handleToggleFavorite = ({ versionId, setTo }: { versionId?: number; setTo: boolean }) => {
    if (!model) return;
    favoriteMutation.mutate({
      modelId: model.id,
      modelVersionId: versionId,
      setTo,
    });
  };

  const handlePublishModel = () => {
    if (!model) return;

    const isUnpublished = model.status === ModelStatus.Unpublished;
    const isUnpublishedViolation = model.status === ModelStatus.UnpublishedViolation;
    const canRepublish =
      (isUnpublished && (isCreator || isModerator)) || (isUnpublishedViolation && isModerator);

    if (!canRepublish) return;

    const isPrivate = model.availability === Availability.Private;
    const message = isPrivate
      ? 'This model and all of its versions will be restored to their previous state while remaining private. Are you sure you want to republish this model?'
      : 'This model and all of its versions will be publicly available. Are you sure you want to republish this model?';

    openConfirmModal({
      centered: true,
      closeOnConfirm: false,
      title: 'Republish model',
      children: message,
      labels: { confirm: 'Yes, republish', cancel: 'No, go back' },
      onConfirm: () => {
        publishModelMutation.mutate(
          {
            id: model.id,
            versionIds: model?.modelVersions.map((v) => v.id),
          },
          { onSuccess: () => closeAllModals() }
        );
      },
    });
  };

  const toggleCannotPromoteMutation = trpc.model.toggleCannotPromote.useMutation({
    async onSuccess({ id, meta }) {
      const prevModel = queryUtils.model.getById.getData({ id });
      await queryUtils.model.getById.cancel({ id });

      if (prevModel) {
        queryUtils.model.getById.setData({ id }, { ...prevModel, meta });
      }

      // invalidate all auction results in case we deleted bids
      await queryUtils.auction.getBySlug.invalidate();

      showSuccessNotification({ message: 'Successfully toggled cannot promote' });
    },
    onError(error) {
      showErrorNotification({ title: 'Failed to toggle', error: new Error(error.message) });
    },
  });
  const handleToggleCannotPromote = () => {
    toggleCannotPromoteMutation.mutate({ id });
  };

  const view = router.query.view;
  const basicView = view === 'basic' && isModerator;
  const canLoadBelowTheFold = isClient && !loadingModel && !loadingImages && !basicView;

  useEffect(() => {
    // Change the selected modelVersion based on querystring param
    if (loadingModel) return;
    const queryVersion = publishedVersions.find((v) => v.id === modelVersionId);
    const hasSelected = publishedVersions.some((v) => v.id === selectedVersion?.id);
    if (!hasSelected) setSelectedVersion(queryVersion ?? publishedVersions[0] ?? null);
    if (selectedVersion && queryVersion !== selectedVersion) {
      router.replace(`/models/${id}?modelVersionId=${selectedVersion.id}`, undefined, {
        shallow: true,
      });
    }
  }, [id, publishedVersions, selectedVersion, modelVersionId, loadingModel, router]);

  useEffect(() => {
    if (!canLoadBelowTheFold) return;
    if ((activeTour === 'model-page' || activeTour === 'welcome') && !running)
      runTour({ key: activeTour });
    // only run when the model is loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoadBelowTheFold]);

  if (loadingModel) return <PageLoader />;

  // Handle missing and deleted models
  const modelDoesntExist = !model;
  const modelDeleted = !!model && !!model.deletedAt && model.status === ModelStatus.Deleted;
  const modelNotVisible =
    model &&
    !isOwner &&
    !isModerator &&
    // Check if published or has any model versions
    (model.status !== ModelStatus.Published || !model.modelVersions.length);

  const isBlocked = blockedUsers.find((u) => u.id === model?.user.id);

  if (modelDeleted && !isOwner && !isModerator)
    return (
      <Center p="xl">
        <Alert>
          <Text size="lg">This resource has been removed by its owner</Text>
        </Alert>
      </Center>
    );

  if (modelDoesntExist || ((modelDeleted || modelNotVisible || isBlocked) && !isModerator)) {
    return <NotFound />;
  }

  if (
    model.poi &&
    browsingSettingsAddons.settings.disablePoi &&
    model.user.id !== currentUser?.id
  ) {
    return <NotFound />;
  }

  if (model.minor && browsingSettingsAddons.settings.disableMinor) {
    return (
      <NotFound
        title="Model not available with current settings"
        message="This model is hidden when adult content filters are on. Disable X/XXX to view it."
      />
    );
  }

  const image = versionImages.find((image) => getIsSafeBrowsingLevel(image.nsfwLevel));
  const imageUrl = image ? getEdgeUrl(image.url, { width: 1200 }) : undefined;
  const totalRatingCount =
    (model.rank?.thumbsUpCountAllTime ?? 0) + (model.rank?.thumbsDownCountAllTime ?? 0);
  const metaSchema = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    applicationCategory: 'Multimedia',
    applicationSubCategory: `${selectedEcosystemName} Model`,
    description: model.description,
    name: model.name,
    image: imageUrl,
    author:
      !model.user.deletedAt && model.user.username
        ? {
            '@type': 'Person',
            name: model.user.username,
            url: env.NEXT_PUBLIC_BASE_URL
              ? `${env.NEXT_PUBLIC_BASE_URL}/user/${model.user.username}`
              : undefined,
          }
        : undefined,
    datePublished: model.publishedAt,
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: Math.min(
        Math.ceil((model.rank?.thumbsUpCountAllTime ?? 0 / totalRatingCount) * 5),
        5
      ),
      reviewCount: totalRatingCount,
      bestRating: 5,
      worstRating: 0,
    },
  };

  const published = model.status === ModelStatus.Published;
  const inaccurate = model.modelVersions.some((version) => version.inaccurate);
  const isMuted = currentUser?.muted ?? false;
  const onlyEarlyAccess = model.modelVersions.every((version) => version.earlyAccessDeadline);
  const canDiscuss =
    features.canWrite &&
    !isMuted &&
    (!onlyEarlyAccess ||
      hasDownloadPermissions ||
      hasGeneratePermissions ||
      currentUser?.isModerator);
  const versionCount = model.modelVersions.length;
  const inEarlyAccess = model.earlyAccessDeadline && isFutureDate(model.earlyAccessDeadline);
  const versionIsEarlyAccess =
    selectedVersion &&
    !!selectedVersion.earlyAccessDeadline &&
    isFutureDate(selectedVersion.earlyAccessDeadline);
  const category = model.tagsOnModels.find(({ tag }) => !!tag.isCategory)?.tag;
  const tags = model.tagsOnModels.filter(({ tag }) => !tag.isCategory).map((tag) => tag.tag);
  const unpublishedReason = model.meta?.unpublishedReason ?? 'other';
  const unpublishedMessage =
    unpublishedReason !== 'other'
      ? unpublishReasons[unpublishedReason]?.notificationMessage
      : `Removal reason: ${model.meta?.customMessage ?? 'Flagged by system'}.`;
  const isBannedFromPromotion = model.meta?.cannotPromote ?? false;

  return (
    <>
      <Meta
        title={`${model.name}${
          selectedVersion ? ' - ' + selectedVersion.name : ''
        } | ${selectedEcosystemName} ${getDisplayName(model.type)} | Civitai`}
        description={truncate(removeTags(model.description ?? ''), { length: 150 })}
        images={versionImages}
        links={
          env.NEXT_PUBLIC_BASE_URL
            ? [
                {
                  href: `${env.NEXT_PUBLIC_BASE_URL}/models/${model.id}/${slugit(model.name)}`,
                  rel: 'canonical',
                },
                {
                  href: `${env.NEXT_PUBLIC_BASE_URL}/models/${model.id}`,
                  rel: 'alternate',
                },
              ]
            : undefined
        }
        schema={metaSchema}
        deIndex={
          model.status !== ModelStatus.Published || model.availability === Availability.Unsearchable
        }
      />
      <SensitiveShield nsfw={model.nsfw} contentNsfwLevel={model.nsfwLevel}>
        <TrackView entityId={model.id} entityType="Model" type="ModelView" />
        {!model.nsfw && <RenderAdUnitOutstream minContainerWidth={2800} />}
        <Container size="xl" data-tour="model:start" className="pb-8">
          <Stack gap="xl">
            <Stack gap="xs">
              <Stack gap={4}>
                <Group align="flex-start" justify="space-between" wrap="nowrap">
                  <Group className={classes.titleWrapper} align="center">
                    <Title className={classes.title} order={1} lineClamp={2}>
                      {model?.name}
                    </Title>
                    <StatHoverCard label="Unique Reviews" value={model.rank?.thumbsUpCountAllTime ?? 0}>
                      <div>
                        <LoginRedirect reason="favorite-model">
                          <IconBadge
                            radius="sm"
                            color={isFavorite ? 'green' : 'gray'}
                            size="lg"
                            icon={
                              <ThumbsUpIcon
                                size={18}
                                color={isFavorite ? 'green' : undefined}
                                filled={isFavorite}
                              />
                            }
                            className="cursor-pointer"
                            onClick={() => handleToggleFavorite({ setTo: !isFavorite })}
                          >
                            <Text className={classes.modelBadgeText}>
                              {abbreviateNumber(model.rank?.thumbsUpCountAllTime ?? 0)}
                            </Text>
                          </IconBadge>
                        </LoginRedirect>
                      </div>
                    </StatHoverCard>
                    <StatHoverCard label="Unique Downloads" value={model.rank?.downloadCountAllTime ?? 0}>
                      <IconBadge radius="sm" size="lg" icon={<IconDownload size={18} />}>
                        <Text className={classes.modelBadgeText}>
                          {abbreviateNumber(model.rank?.downloadCountAllTime ?? 0)}
                        </Text>
                      </IconBadge>
                    </StatHoverCard>
                    {/* TODO this isn't quite right, we need to check the other couldGenerate options */}
                    {latestGenerationVersion && (
                      <GenerateButton
                        model={model}
                        version={latestGenerationVersion}
                        image={image}
                        versionId={latestGenerationVersion.id}
                        canGenerate={model.canGenerate}
                        data-activity="create:model-stat"
                      >
                        <IconBadge radius="sm" size="lg" icon={<IconBrush size={18} />}>
                          <Text className={classes.modelBadgeText}>
                            {abbreviateNumber(model.rank?.generationCountAllTime ?? 0)}
                          </Text>
                        </IconBadge>
                      </GenerateButton>
                    )}
                    {features.collections && (
                      <StatHoverCard label="Collections" value={model.rank?.collectedCountAllTime ?? 0}>
                        <div>
                          <LoginRedirect reason="add-to-collection">
                            <IconBadge
                              radius="sm"
                              size="lg"
                              icon={<IconBookmark size={18} />}
                              className="cursor-pointer"
                              onClick={handleCollect}
                            >
                              <Text className={classes.modelBadgeText}>
                                {abbreviateNumber(model.rank?.collectedCountAllTime ?? 0)}
                              </Text>
                            </IconBadge>
                          </LoginRedirect>
                        </div>
                      </StatHoverCard>
                    )}
                    {!model.poi && (
                      <StatHoverCard label="Buzz Earned" value={buzzEarned}>
                        <div>
                          <InteractiveTipBuzzButton
                            toUserId={model.user.id}
                            entityId={model.id}
                            entityType="Model"
                          >
                            <IconBadge
                              className="cursor-pointer"
                              radius="sm"
                              size="lg"
                              icon={
                                <IconBolt size={18} className="text-yellow-7" fill="currentColor" />
                              }
                            >
                              <Text className={classes.modelBadgeText}>
                                {abbreviateNumber(buzzEarned)}
                              </Text>
                            </IconBadge>
                          </InteractiveTipBuzzButton>
                        </div>
                      </StatHoverCard>
                    )}
                    {inEarlyAccess && (
                      <Tooltip
                        label={
                          <Text>
                            Early Access helps creators monetize,{' '}
                            <Anchor href="/articles/6341">learn more here</Anchor>
                          </Text>
                        }
                      >
                        <IconBadge
                          radius="sm"
                          color="green"
                          size="lg"
                          icon={<IconClock size={18} />}
                        >
                          Early Access
                        </IconBadge>
                      </Tooltip>
                    )}
                  </Group>

                  <Group gap={8} wrap="nowrap">
                    <HowToButton
                      size={30}
                      stroke={1.5}
                      href="https://education.civitai.com/civitais-guide-to-resource-types/#models"
                      tooltip="What is this?"
                    />
                    {features.appTour && (
                      <HelpButton
                        size="xl"
                        tooltip="Need help? Start the tour!"
                        iconProps={{ size: 30, stroke: 1.5 }}
                        onClick={() => runTour({ key: 'model-page', step: 0, forceRun: true })}
                      />
                    )}
                    {features.auctions && selectedVersion && (
                      <BidModelButton
                        actionIconProps={{
                          className: classes.headerButton,
                        }}
                        buttonProps={{ className: classes.headerButton }}
                        entityData={getEntityDataForBidModelButton({
                          version: selectedVersion,
                          model,
                          image,
                        })}
                      />
                    )}
                    <ToggleModelNotification
                      className={classes.headerButton}
                      modelId={model.id}
                      userId={model.user.id}
                    />
                    <Menu
                      position="bottom-end"
                      transitionProps={{ transition: 'pop-top-right' }}
                      withinPortal
                    >
                      <Menu.Target>
                        <LegacyActionIcon className={classes.headerButton} variant="light">
                          <IconDotsVertical size={20} />
                        </LegacyActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {currentUser && isCreator && published && (
                          <Menu.Item
                            leftSection={<IconBan size={14} stroke={1.5} />}
                            color="yellow"
                            onClick={() => unpublishModelMutation.mutate({ id })}
                            disabled={unpublishModelMutation.isLoading}
                          >
                            Unpublish
                          </Menu.Item>
                        )}
                        {currentUser &&
                          ((model.status === ModelStatus.Unpublished &&
                            (isCreator || isModerator)) ||
                            (model.status === ModelStatus.UnpublishedViolation && isModerator)) && (
                            <Menu.Item
                              leftSection={<IconRepeat size={14} stroke={1.5} />}
                              color="green"
                              onClick={handlePublishModel}
                              disabled={publishModelMutation.isLoading}
                            >
                              Republish
                            </Menu.Item>
                          )}
                        {currentUser && isModerator && modelDeleted && (
                          <Menu.Item
                            leftSection={<IconRecycle size={14} stroke={1.5} />}
                            color="green"
                            onClick={() => restoreModelMutation.mutate({ id })}
                            disabled={restoreModelMutation.isLoading}
                          >
                            Restore
                          </Menu.Item>
                        )}
                        {currentUser && isModerator && (
                          <>
                            {env.NEXT_PUBLIC_MODEL_LOOKUP_URL && (
                              <Menu.Item
                                component="a"
                                target="_blank"
                                leftSection={<IconInfoCircle size={14} stroke={1.5} />}
                                href={`${env.NEXT_PUBLIC_MODEL_LOOKUP_URL}${model.id}`}
                              >
                                Lookup Model
                              </Menu.Item>
                            )}
                            {published && (
                              <Menu.Item
                                color="yellow"
                                leftSection={<IconBan size={14} stroke={1.5} />}
                                onClick={() => openUnpublishModal({ props: { modelId: model.id } })}
                              >
                                Unpublish as Violation
                              </Menu.Item>
                            )}
                            <Menu.Item
                              color="orange"
                              leftSection={<IconBan size={14} stroke={1.5} />}
                              onClick={() => handleToggleCannotPromote()}
                            >
                              {isBannedFromPromotion ? 'Allow Promoting' : 'Ban Promoting'}
                            </Menu.Item>
                            <Menu.Item
                              color="red.6"
                              leftSection={<IconTrash size={14} stroke={1.5} />}
                              onClick={() => handleDeleteModel({ permanently: true })}
                            >
                              Permanently Delete Model
                            </Menu.Item>
                          </>
                        )}
                        {currentUser && isOwner && !modelDeleted && (
                          <>
                            <Menu.Item
                              color="red.6"
                              leftSection={<IconTrash size={14} stroke={1.5} />}
                              onClick={() => handleDeleteModel()}
                            >
                              Delete Model
                            </Menu.Item>
                            <Menu.Item
                              leftSection={<IconEdit size={14} stroke={1.5} />}
                              component={Link}
                              href={`/models/${model.id}/edit`}
                            >
                              Edit Model
                            </Menu.Item>
                          </>
                        )}
                        {features.collections && (
                          <AddToCollectionMenuItem
                            onClick={() =>
                              openAddToCollectionModal({
                                props: {
                                  modelId: model.id,
                                  type: CollectionType.Model,
                                },
                              })
                            }
                          />
                        )}
                        {isOwner && (
                          <AddToShowcaseMenuItem
                            key="add-to-showcase"
                            entityType="Model"
                            entityId={model.id}
                          />
                        )}
                        {(!currentUser || !isOwner || isModerator) && (
                          <LoginRedirect reason="report-model">
                            <Menu.Item
                              leftSection={<IconFlag size={14} stroke={1.5} />}
                              onClick={() =>
                                openReportModal({
                                  entityType: ReportEntity.Model,
                                  entityId: model.id,
                                })
                              }
                            >
                              Report
                            </Menu.Item>
                          </LoginRedirect>
                        )}
                        {isModerator && (
                          <Menu.Item
                            leftSection={
                              rescanModelMutation.isLoading ? (
                                <Loader size={14} />
                              ) : (
                                <IconRadar2 size={14} stroke={1.5} />
                              )
                            }
                            onClick={() => handleRescanModel()}
                          >
                            Rescan Files
                          </Menu.Item>
                        )}
                        {currentUser && (
                          <>
                            <Menu.Label>Moderation</Menu.Label>
                            <HideUserButton as="menu-item" userId={model.user.id} />
                            <HideModelButton as="menu-item" modelId={model.id} />
                            <Menu.Item
                              leftSection={<IconTagOff size={14} stroke={1.5} />}
                              onClick={() =>
                                openBlockModelTagsModal({ props: { modelId: model.id } })
                              }
                            >
                              Hide content with these tags
                            </Menu.Item>
                            {isModerator && (
                              <>
                                <ToggleLockModel modelId={model.id} locked={model.locked}>
                                  {({ onClick }) => (
                                    <Menu.Item
                                      leftSection={
                                        model.locked ? (
                                          <IconLockOff size={14} stroke={1.5} />
                                        ) : (
                                          <IconLock size={14} stroke={1.5} />
                                        )
                                      }
                                      onClick={onClick}
                                    >
                                      {model.locked ? 'Unlock' : 'Lock'} model discussion
                                    </Menu.Item>
                                  )}
                                </ToggleLockModel>
                                <ToggleLockModelComments
                                  modelId={model.id}
                                  locked={model.meta?.commentsLocked}
                                >
                                  {({ onClick }) => (
                                    <Menu.Item
                                      leftSection={
                                        model.meta?.commentsLocked ? (
                                          <IconLockOff size={14} stroke={1.5} />
                                        ) : (
                                          <IconLock size={14} stroke={1.5} />
                                        )
                                      }
                                      onClick={onClick}
                                    >
                                      {model.meta?.commentsLocked ? 'Unlock' : 'Lock'} model
                                      comments
                                    </Menu.Item>
                                  )}
                                </ToggleLockModelComments>
                                <ToggleSearchableMenuItem
                                  entityType="Model"
                                  entityId={model.id}
                                  key="toggle-searchable-menu-item"
                                />
                                {!model.mode ? (
                                  <>
                                    <Menu.Item
                                      leftSection={<IconArchive size={14} stroke={1.5} />}
                                      onClick={() => handleChangeMode(ModelModifier.Archived)}
                                    >
                                      Archive
                                    </Menu.Item>
                                    <Menu.Item
                                      leftSection={<IconCircleMinus size={14} stroke={1.5} />}
                                      onClick={() => handleChangeMode(ModelModifier.TakenDown)}
                                    >
                                      Take Down
                                    </Menu.Item>
                                  </>
                                ) : (
                                  <Menu.Item
                                    leftSection={<IconReload size={14} stroke={1.5} />}
                                    onClick={() => handleChangeMode(null)}
                                  >
                                    Bring Back
                                  </Menu.Item>
                                )}
                              </>
                            )}
                          </>
                        )}
                        {published && (isOwner || isModerator) && (
                          <>
                            <Menu.Label>Advanced</Menu.Label>
                            <Menu.Item
                              onClick={() =>
                                dialogStore.trigger({
                                  component: MigrateModelToCollection,
                                  props: { modelId: model.id },
                                })
                              }
                            >
                              Migrate to Collection
                            </Menu.Item>
                          </>
                        )}
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                </Group>
                <Group gap={4}>
                  <Text size="xs" c="dimmed">
                    Updated: {formatDate(model.updatedAt)}
                  </Text>
                  {category && (
                    <>
                      <Divider orientation="vertical" />
                      <Link
                        href={`/tag/${encodeURIComponent(category.name.toLowerCase())}`}
                        legacyBehavior
                        passHref
                      >
                        <Badge component="a" size="sm" color="blue" className="cursor-pointer">
                          {category.name}
                        </Badge>
                      </Link>
                    </>
                  )}

                  {tags.length > 0 && <Divider orientation="vertical" />}
                  <Collection
                    items={tags}
                    renderItem={(tag) => (
                      <Link
                        legacyBehavior
                        href={`/tag/${encodeURIComponent(tag.name.toLowerCase())}`}
                        passHref
                      >
                        <Badge
                          component="a"
                          size="sm"
                          color="gray"
                          variant={colorScheme === 'dark' ? 'filled' : undefined}
                          className="cursor-pointer"
                        >
                          {tag.name}
                        </Badge>
                      </Link>
                    )}
                  />
                </Group>
              </Stack>
              {(model.status === ModelStatus.Unpublished || modelDeleted) && (
                <Alert color="red">
                  <Group gap="xs" wrap="nowrap" align="flex-start">
                    <ThemeIcon color="red">
                      <IconExclamationMark />
                    </ThemeIcon>
                    <Text size="md">
                      This model has been {modelDeleted ? 'deleted' : 'unpublished'} and is not
                      visible to the community.
                    </Text>
                  </Group>
                </Alert>
              )}
              {model.status === ModelStatus.UnpublishedViolation && !model.meta?.needsReview && (
                <Alert color="red">
                  <Group gap="xs" wrap="nowrap" align="flex-start">
                    <ThemeIcon color="red">
                      <IconExclamationMark />
                    </ThemeIcon>
                    <Text size="sm" mt={-3}>
                      This model has been unpublished due to a violation of our{' '}
                      <Text component="a" c="blue.4" href="/content/tos" target="_blank">
                        guidelines
                      </Text>{' '}
                      and is not visible to the community.{' '}
                      {unpublishedReason && unpublishedMessage ? unpublishedMessage : null} If you
                      adjust your model to comply with our guidelines, you can request a review from
                      one of our moderators.
                    </Text>
                  </Group>
                </Alert>
              )}
              {model.status === ModelStatus.UnpublishedViolation && model.meta?.needsReview && (
                <Alert color="yellow">
                  <Group gap="xs" wrap="nowrap">
                    <ThemeIcon color="yellow">
                      <IconExclamationMark />
                    </ThemeIcon>
                    <Text size="md">
                      This model is currently being reviewed by our moderators. It will be visible
                      to the community once it has been approved.
                    </Text>
                  </Group>
                </Alert>
              )}
              {isOwner && model.meta?.cannotPublish && (
                <Alert color="red">
                  <Group gap="xs" wrap="nowrap" align="flex-start">
                    <ThemeIcon color="red">
                      <IconExclamationMark />
                    </ThemeIcon>
                    <Text size="sm" mt={-3}>
                      Due to the nature of the training data used to create this model, it cannot be
                      Published. If you believe this to be an error, please{' '}
                      <Text component="a" c="blue.4" href="/contact" target="_blank">
                        contact our support team
                      </Text>
                      .
                    </Text>
                  </Group>
                </Alert>
              )}
              {inaccurate && (
                <Alert color="yellow">
                  <Group gap="xs" wrap="nowrap" align="flex-start">
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
              {(model.mode === ModelModifier.TakenDown ||
                model.mode === ModelModifier.Archived) && (
                <AlertWithIcon color="blue" icon={<IconExclamationMark />} size="md">
                  {model.mode === ModelModifier.Archived
                    ? 'This model has been archived and is not available for download. You can still share your creations with the community.'
                    : 'The visual assets associated with this model have been taken down. You can still download the resource, but you will not be able to share your creations.'}
                </AlertWithIcon>
              )}
            </Stack>
            <Group gap={4} wrap="nowrap">
              {isOwner ? (
                <>
                  {model.availability !== Availability.Private && (
                    <ButtonTooltip label="Add Version">
                      <Link href={`/models/${model.id}/model-versions/create`}>
                        <LegacyActionIcon variant="light" color="blue">
                          <IconPlus size={14} />
                        </LegacyActionIcon>
                      </Link>
                    </ButtonTooltip>
                  )}

                  {versionCount > 1 && (
                    <ButtonTooltip label="Rearrange Versions">
                      <LegacyActionIcon onClick={toggle}>
                        <IconArrowsLeftRight size={14} />
                      </LegacyActionIcon>
                    </ButtonTooltip>
                  )}
                </>
              ) : null}
              <ModelVersionList
                versions={model.modelVersions}
                selected={selectedVersion?.id}
                onVersionClick={(version) => {
                  if (version.id !== selectedVersion?.id) {
                    setSelectedVersion(version);
                    // router.replace(`/models/${model.id}?modelVersionId=${version.id}`, undefined, {
                    //   shallow: true,
                    // });
                  }
                }}
                showExtraIcons={isOwner || isModerator}
                showToggleCoverage={model.type === ModelType.Checkpoint}
              />
            </Group>
            {!!selectedVersion && (
              <ModelVersionDetails
                model={model}
                version={selectedVersion}
                image={image}
                onFavoriteClick={handleToggleFavorite}
                onBrowseClick={() => {
                  gallerySectionRef.current?.scrollIntoView({ behavior: 'smooth' });
                }}
              />
            )}
          </Stack>
          {versionCount > 1 ? (
            <ReorderVersionsModal modelId={model.id} opened={opened} onClose={toggle} />
          ) : null}
        </Container>
        {canLoadBelowTheFold && (
          <>
            {(isOwner || model.hasSuggestedResources) && (
              <>
                {model.hasSuggestedResources && <AdUnitTopSection />}
                {selectedVersion && (
                  <AssociatedModels
                    fromId={model.id}
                    type="Suggested"
                    versionId={selectedVersion.id}
                    ownerId={model.user.id}
                    label={
                      <Group gap={8} wrap="nowrap">
                        Suggested Resources{' '}
                        <InfoPopover>
                          <Text size="sm" fw={400}>
                            These are resources suggested by the creator of this model. They may be
                            related to this model or created by the same user.
                          </Text>
                        </InfoPopover>
                      </Group>
                    }
                  />
                )}
              </>
            )}
            <AdUnitTopSection />
            <Container size="xl" my="xl">
              <ModelDiscussion
                canDiscuss={canDiscuss}
                onlyEarlyAccess={onlyEarlyAccess}
                modelId={model.id}
                locked={model.locked || model.meta?.commentsLocked}
              />
            </Container>
            {!model.locked && model.mode !== ModelModifier.TakenDown && (
              <Box ref={gallerySectionRef} id="gallery" mt="md">
                <ModelGallery
                  model={model}
                  selectedVersionId={selectedVersion?.id}
                  modelVersions={model.modelVersions}
                  showModerationOptions={isOwner}
                  showPOIWarning={model.poi}
                  canReview={
                    !versionIsEarlyAccess || currentUser?.isMember || currentUser?.isModerator
                  }
                />
              </Box>
            )}
          </>
        )}
      </SensitiveShield>
    </>
  );

  // return (
  //   <Box ref={gallerySectionRef} id="gallery" mt="md">
  //     <ImagesAsPostsInfinite
  //       model={model}
  //       selectedVersionId={selectedVersion?.id}
  //       modelVersions={model.modelVersions}
  //       showModerationOptions={isOwner}
  //       showPOIWarning={model.poi}
  //       generationOptions={{
  //         generationModelId: selectedVersion?.meta.picFinderModelId,
  //         includeEditingActions: isOwner,
  //       }}
  //       canReview={!versionIsEarlyAccess || currentUser?.isMember || currentUser?.isModerator}
  //     />
  //   </Box>
  // );
}

function AdUnitTopSection() {
  return <AdUnitTop className="bg-gray-1 py-3 dark:bg-dark-6" preserveLayout />;
}
