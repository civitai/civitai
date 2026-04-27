import {
  Accordion,
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Loader,
  Menu,
  Modal,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import {
  IconBellCheck,
  IconBellPlus,
  IconBolt,
  IconBookmark,
  IconBrush,
  IconClock,
  IconCloudCheck,
  IconCloudLock,
  IconDownload,
  IconExclamationMark,
  IconFileSettings,
  IconFlag,
  IconGavel,
  IconHeart,
  IconLicense,
  IconLock,
  IconMessageCircle2,
  IconPhotoPlus,
  IconPuzzle,
  IconRepeat,
  IconShare3,
} from '@tabler/icons-react';
import type { TRPCClientErrorBase } from '@trpc/client';
import type { DefaultErrorShape } from '@trpc/server';
import clsx from 'clsx';
import { useRouter } from 'next/router';
import { useMemo, useRef } from 'react';
import { AdUnitSide_2 } from '~/components/Ads/AdUnit';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import {
  BidModelButton,
  getEntityDataForBidModelButton,
} from '~/components/Auction/BidModelButton';
import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { CollectionFollowAction } from '~/components/Collections/components/CollectionFollow';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { AnimatedCount, useLiveMetrics, MetricSubscriptionProvider } from '~/components/Metrics';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { openCollectionSelectModal } from '~/components/Dialog/triggers/collection-select';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { openResourceReviewEditModal } from '~/components/Dialog/triggers/resource-review-edit';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { CollectionShowcase } from '~/components/Model/CollectionShowcase/CollectionShowcase';
import { EarlyAccessAlert } from '~/components/Model/EarlyAccessAlert/EarlyAccessAlert';
import { HowToUseModel } from '~/components/Model/HowToUseModel/HowToUseModel';
import { useModelShowcaseCollection } from '~/components/Model/model.utils';
import { ModelAvailabilityUpdate } from '~/components/Model/ModelAvailabilityUpdate/ModelAvailabilityUpdate';
import { ModelCarousel } from '~/components/Model/ModelCarousel/ModelCarousel';
import { ModelFileAlert } from '~/components/Model/ModelFileAlert/ModelFileAlert';
import { ModelHash } from '~/components/Model/ModelHash/ModelHash';
import { ModelURN, URNExplanation } from '~/components/Model/ModelURN/ModelURN';
import { DownloadVariantDropdown } from '~/components/Model/ModelVersions/DownloadVariantDropdown';
import { ModelVersionPopularity } from '~/components/Model/ModelVersions/ModelVersionPopularity';
import { ModelVersionReview } from '~/components/Model/ModelVersions/ModelVersionReview';
import { RequiredComponentsSection } from '~/components/Model/ModelVersions/RequiredComponentsSection';
import { VerifiedText } from '~/components/VerifiedText/VerifiedText';
import {
  useModelVersionPermission,
  useQueryModelVersionsEngagement,
} from '~/components/Model/ModelVersions/model-version.utils';
import ModelVersionDonationGoals from '~/components/Model/ModelVersions/ModelVersionDonationGoals';
import { ModelVersionEarlyAccessPurchase } from '~/components/Model/ModelVersions/ModelVersionEarlyAccessPurchase';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PermissionIndicator } from '~/components/PermissionIndicator/PermissionIndicator';
import { PoiAlert } from '~/components/PoiAlert/PoiAlert';
import { SchedulePostModal } from '~/components/Post/EditV2/SchedulePostModal';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import {
  EditUserResourceReviewLight,
  UserResourceReviewComposite,
} from '~/components/ResourceReview/EditUserResourceReview';
import { useQueryUserResourceReview } from '~/components/ResourceReview/resourceReview.utils';
import { ResourceReviewThumbActions } from '~/components/ResourceReview/ResourceReviewThumbActions';
import { GenerateButton } from '~/components/RunStrategy/GenerateButton';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { IconCivitai } from '~/components/SVG/IconCivitai';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { TrackView } from '~/components/TrackView/TrackView';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { ToggleVaultButton } from '~/components/Vault/ToggleVaultButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { baseModelLicenses, CAROUSEL_LIMIT, constants } from '~/server/common/constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { unpublishReasons } from '~/server/common/moderation-helpers';
import { ReportEntity } from '~/shared/utils/report-helpers';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { getPrimaryFile, groupFilesByVariant } from '~/server/utils/model-helpers';
import {
  Availability,
  CollectionType,
  ModelEngagementType,
  ModelFileVisibility,
  ModelModifier,
  ModelStatus,
  ModelType,
  ModelUsageControl,
} from '~/shared/utils/prisma/enums';
import type { ModelById } from '~/types/router';
import { formatDate, formatDateMin } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { componentTypeConfig, getFileIconConfig } from '~/utils/file-display-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { getDisplayName, removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import classes from './ModelVersionDetails.module.scss';

export function ModelVersionDetails(props: Props) {
  return (
    <MetricSubscriptionProvider entityType="ModelVersion" entityId={props.version.id}>
      <ModelVersionDetailsContent {...props} />
    </MetricSubscriptionProvider>
  );
}

function ModelVersionDetailsContent({ model, version, image, onFavoriteClick }: Props) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const user = useCurrentUser();
  const { connected: civitaiLinked } = useCivitaiLink();
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const features = useFeatureFlags();
  // TODO.manuel: use control ref to display the show more button
  const controlRef = useRef<HTMLButtonElement | null>(null);
  const [detailAccordions, setDetailAccordions] = useLocalStorage({
    key: 'model-version-details-accordions',
    defaultValue: ['version-details', 'required-components'],
  });
  const adContainerRef = useRef<HTMLDivElement | null>(null);

  const {
    isLoadingAccess,
    isDownloadable,
    isSelectableInGenerator,
    canDownload: hasDownloadPermissions,
    canGenerate: hasGeneratePermissions,
  } = useModelVersionPermission({
    modelVersionId: version.id,
  });
  const mobile = useIsMobile();

  // Live metrics for model version stats
  const liveMetrics = useLiveMetrics('ModelVersion', version.id, {
    downloadCount: version.rank?.downloadCountAllTime ?? 0,
    generationCount: version.rank?.generationCountAllTime ?? 0,
    thumbsUpCount: version.rank?.thumbsUpCountAllTime ?? 0,
    thumbsDownCount: version.rank?.thumbsDownCountAllTime ?? 0,
    earnedAmount: version.rank?.earnedAmountAllTime ?? 0,
  });

  // We'll use this flag mainly to let the owner know of the status, but the `isDownloadable` flag determines whether this user can download or not.
  const downloadsDisabled =
    !!version?.usageControl && version?.usageControl !== ModelUsageControl.Download;
  const hideDownload = !isDownloadable || downloadsDisabled;

  const { collection, setShowcaseCollection, settingShowcase } = useModelShowcaseCollection({
    modelId: model.id,
  });

  const canDownload = version.canDownload || hasDownloadPermissions;

  const isOwner = model.user?.id === user?.id;
  const isOwnerOrMod = isOwner || user?.isModerator;

  const primaryFile = getPrimaryFile(version.files, {
    metadata: user?.filePreferences,
  });
  const hashes = primaryFile?.hashes ?? [];

  const filesCount = version.files?.length;
  const hasFiles = filesCount > 0;
  const filesVisible = useMemo(
    () => version.files?.filter((f) => f.visibility === ModelFileVisibility.Public || isOwnerOrMod),
    [version.files, isOwnerOrMod]
  );
  const filesVisibleCount = filesVisible.length;
  const hasVisibleFiles = filesVisibleCount > 0;

  // Group files by variant for the download dropdown
  const groupedFiles = useMemo(
    () => groupFilesByVariant(filesVisible, model.type),
    [filesVisible, model.type]
  );

  // Get model files (not component files) for the download dropdown
  const modelFilesVisible = useMemo(() => {
    return [
      ...groupedFiles.safeTensorVariants,
      ...groupedFiles.ggufVariants,
      ...groupedFiles.otherFormatVariants,
    ];
  }, [groupedFiles]);

  // Check if this is a component-only model (no model files, only components)
  const isComponentOnlyModel =
    modelFilesVisible.length === 0 && Object.keys(groupedFiles.requiredComponents).length > 0;

  // Split linked components into required and optional
  const requiredLinkedComponents = useMemo(
    () => (version.linkedComponents ?? []).filter((lc) => lc.isRequired),
    [version.linkedComponents]
  );
  const optionalLinkedComponents = useMemo(
    () => (version.linkedComponents ?? []).filter((lc) => !lc.isRequired),
    [version.linkedComponents]
  );

  const displayCivitaiLink =
    civitaiLinked && !!version.hashes && version.hashes?.length > 0 && hasDownloadPermissions;
  const hasPendingClaimReport = model.reportStats && model.reportStats.ownershipProcessing > 0;

  const isEarlyAccess = !!version?.earlyAccessEndsAt && version.earlyAccessEndsAt > new Date();
  const earlyAccessConfig = version?.earlyAccessConfig;
  const isDraft = version?.status === ModelStatus.Draft;

  // const shouldOmit = [1562709, 1672021, 1669468].includes(model.id) && !user?.isModerator;
  const couldGenerate =
    !isDraft && // We don't wanna show the action for drafts.
    isSelectableInGenerator &&
    features.imageGeneration &&
    // !shouldOmit &&
    (!isEarlyAccess ||
      !!earlyAccessConfig?.chargeForGeneration ||
      !!earlyAccessConfig?.freeGeneration ||
      hasGeneratePermissions);
  const canGenerate = couldGenerate && version.canGenerate;
  const publishVersionMutation = trpc.modelVersion.publish.useMutation();
  const publishModelMutation = trpc.model.publish.useMutation();
  const requestReviewMutation = trpc.model.requestReview.useMutation();
  const requestVersionReviewMutation = trpc.modelVersion.requestReview.useMutation();
  const isPrivateModel = model.availability === Availability.Private;

  const handlePublishPrivateModel = async () => {
    dialogStore.trigger({
      component: ModelAvailabilityUpdate,
      props: { modelId: model.id },
    });
  };

  // Handler for republishing a private model while keeping it private
  const handleRepublishPrivateModel = async () => {
    try {
      if (model.status !== ModelStatus.Published) {
        // Republish model, version and all of its posts (keeping it private)
        const versionIds =
          (model.status === ModelStatus.UnpublishedViolation ||
            model.status === ModelStatus.Unpublished) &&
          user?.isModerator
            ? model.modelVersions.map(({ id }) => id)
            : [version.id];
        await publishModelMutation.mutateAsync({
          id: model.id,
          versionIds,
        });
      } else {
        // Just republish the version and its posts
        await publishVersionMutation.mutateAsync({ id: version.id });
      }
      await queryUtils.model.getById.invalidate({ id: model.id });
    } catch (e) {
      const error = e as Error;
      showErrorNotification({ error, title: 'Failed to republish model' });
    }
  };

  const onPurchase = (reason?: 'generation' | 'download') => {
    if (!features.earlyAccessModel) {
      showErrorNotification({
        error: new Error('Unauthorized'),
        title: 'Unauthorized',
        reason:
          'This model will be available for download once early access is enabled to the public. Please check back later.',
      });
      return;
    }

    dialogStore.trigger({
      component: ModelVersionEarlyAccessPurchase,
      props: { modelVersionId: version.id, reason },
    });
  };
  const { currentUserReview } = useQueryUserResourceReview({
    modelId: model.id,
    modelVersionId: version.id,
  });
  const isFavorite = currentUserReview?.recommended;

  const { alreadyDownloaded } = useQueryModelVersionsEngagement({
    modelId: model.id,
    versionId: version.id,
  });

  // Notification toggle state
  const {
    data: { Notify: watchedModels = [], Mute: mutedModels = [] } = { Notify: [], Mute: [] },
  } = trpc.user.getEngagedModels.useQuery(undefined, { enabled: !!user });
  const { data: followingUsers = [] } = trpc.user.getFollowingUsers.useQuery(undefined, {
    enabled: !!user,
    staleTime: 60 * 1000, // 1 minute - avoid refetching on every model view
  });
  const toggleNotifyModelMutation = trpc.user.toggleNotifyModel.useMutation({
    async onSuccess() {
      await queryUtils.user.getEngagedModels.invalidate();
    },
    onError(error) {
      showErrorNotification({ title: 'Failed to update notification settings', error });
    },
  });
  const isNotificationOn =
    (followingUsers.includes(model.user.id) || watchedModels.includes(model.id)) &&
    !mutedModels.includes(model.id);

  const handlePublishClick = async (publishDate?: Date) => {
    try {
      if (model.status !== ModelStatus.Published) {
        // Publish model, version and all of its posts
        const versionIds =
          model.status === ModelStatus.UnpublishedViolation && user?.isModerator
            ? model.modelVersions.map(({ id }) => id)
            : [version.id];
        await publishModelMutation.mutateAsync({
          id: model.id,
          publishedAt: publishDate,
          versionIds,
        });
      } else {
        // Just publish the version and its posts
        await publishVersionMutation.mutateAsync({ id: version.id, publishedAt: publishDate });
      }

      await queryUtils.model.getById.invalidate({ id: model.id });
      await queryUtils.modelVersion.getById.invalidate({ id: version.id });
      await queryUtils.image.getInfinite.invalidate();
    } catch (e) {
      const error = e as TRPCClientErrorBase<DefaultErrorShape>;
      const reason = error?.message?.includes('Insufficient funds')
        ? 'You do not have enough funds to publish this model. You can remove early access or purchase more Buzz in order to publish.'
        : error.message ??
          'Something went wrong while publishing your model. Please try again later.';

      showErrorNotification({
        error: new Error(error.message),
        title: 'Error publishing model',
        reason,
      });
    }
  };

  const handleRequestReviewClick = async () => {
    try {
      if (model.status === ModelStatus.UnpublishedViolation) {
        await requestReviewMutation.mutateAsync({ id: model.id });
      } else {
        await requestVersionReviewMutation.mutateAsync({ id: version.id });
      }

      showSuccessNotification({
        title: 'Request sent',
        message:
          'Your request has been sent to the moderators. We will review it as soon as possible.',
      });

      await queryUtils.model.getById.invalidate({ id: model.id });
      await queryUtils.modelVersion.getById.invalidate({ id: version.id });
    } catch (e) {
      const error = e as TRPCClientErrorBase<DefaultErrorShape>;
      showErrorNotification({
        error: new Error(error.message),
        title: 'Error requesting review',
        reason: 'Something went wrong while requesting a review. Please try again later.',
      });
    }
  };

  const archived = model.mode === ModelModifier.Archived;

  const cleanDescription = version.description ? removeTags(version.description) : '';

  const hasPosts = !!version.posts?.length;
  const showPublishButton =
    isOwnerOrMod &&
    (version.status !== ModelStatus.Published || model.status !== ModelStatus.Published) &&
    hasFiles &&
    hasPosts &&
    !isPrivateModel;

  // Show republish button for private models that are unpublished
  const isModelUnpublished =
    model.status === ModelStatus.Unpublished || model.status === ModelStatus.UnpublishedViolation;
  const isVersionUnpublished =
    version.status === ModelStatus.Unpublished ||
    version.status === ModelStatus.UnpublishedViolation;
  const scheduledPublishDate =
    version.status === ModelStatus.Scheduled ? version.publishedAt : undefined;
  const publishing = publishModelMutation.isLoading || publishVersionMutation.isLoading;
  // Show republish button for private models that are unpublished
  const showRepublishPrivateButton =
    isPrivateModel &&
    (isModelUnpublished || isVersionUnpublished) &&
    hasFiles &&
    hasPosts &&
    // Only moderators can republish UnpublishedViolation, owners can republish Unpublished
    (model.status === ModelStatus.UnpublishedViolation ||
    version.status === ModelStatus.UnpublishedViolation
      ? user?.isModerator
      : isOwnerOrMod);
  // Show request review for owners (non-mods) when model/version is unpublished due to violation
  const showRequestReview =
    isOwner &&
    !user?.isModerator &&
    (model.status === ModelStatus.UnpublishedViolation ||
      version.status === ModelStatus.UnpublishedViolation);
  const deleted = !!model.deletedAt && model.status === ModelStatus.Deleted;
  const showEditButton = isOwnerOrMod && !deleted && !showRequestReview;
  const unpublishedReason = version.meta?.unpublishedReason ?? 'other';
  const unpublishedMessage =
    unpublishedReason !== 'other'
      ? unpublishReasons[unpublishedReason]?.notificationMessage
      : `Removal reason: ${version.meta?.customMessage || 'No reason provided.'}`;
  const license = baseModelLicenses[version.baseModel];
  const onSite = !!version.trainingStatus;
  const showAddendumLicense =
    constants.supportedBaseModelAddendums.includes(version.baseModel as 'SD 1.5' | 'SDXL 1.0') &&
    (!model.allowCommercialUse.length ||
      model.allowCommercialUse.some((permission) =>
        ['None', 'Image', 'RentCivit', 'Rent', 'Sell'].includes(permission)
      ) ||
      !model.allowNoCredit ||
      !model.allowDerivatives ||
      model.allowDifferentLicense);

  return (
    <ContainerGrid2 gutter={{ base: 'xl', sm: 'sm', md: 'xl' }}>
      <TrackView entityId={version.id} entityType="ModelVersion" type="ModelVersionView" />
      <ContainerGrid2.Col span={{ base: 12, sm: 5, md: 4 }} order={{ sm: 2 }} ref={adContainerRef}>
        <Stack>
          {model.mode !== ModelModifier.TakenDown && mobile && (
            <ModelCarousel
              modelId={model.id}
              modelVersionId={version.id}
              modelUserId={model.user.id}
              limit={CAROUSEL_LIMIT}
            />
          )}
          {showRequestReview ? (
            <Button
              color="yellow"
              onClick={handleRequestReviewClick}
              loading={requestReviewMutation.isLoading || requestVersionReviewMutation.isLoading}
              disabled={!!(model.meta?.needsReview || version.meta?.needsReview)}
              fullWidth
            >
              Request a Review
            </Button>
          ) : showPublishButton ? (
            <Stack gap={4}>
              {canGenerate && isOwnerOrMod && (
                <GenerateButton
                  versionId={version.id}
                  data-tour="model:create"
                  data-activity="create:model"
                  py={8}
                />
              )}
              <Button.Group>
                <Button
                  color="green"
                  onClick={() => handlePublishClick()}
                  loading={publishing}
                  fullWidth
                >
                  Publish this version
                </Button>
                <Tooltip label={scheduledPublishDate ? 'Reschedule' : 'Schedule publish'} withArrow>
                  <Button
                    color="green"
                    variant="outline"
                    loading={publishing}
                    onClick={() =>
                      dialogStore.trigger({
                        component: SchedulePostModal,
                        props: {
                          onSubmit: handlePublishClick,
                          publishedAt: version.publishedAt,
                          publishingModel: true,
                        },
                      })
                    }
                  >
                    <IconClock size={20} />
                  </Button>
                </Tooltip>
              </Button.Group>

              {scheduledPublishDate && isOwnerOrMod && (
                <Stack>
                  <Group gap={4}>
                    <ThemeIcon color="gray" variant="filled" radius="xl">
                      <IconClock size={20} />
                    </ThemeIcon>
                    <Text size="xs" c="dimmed">
                      Scheduled for {formatDate(scheduledPublishDate, 'MMMM D, h:mma')}
                    </Text>
                  </Group>
                </Stack>
              )}
            </Stack>
          ) : (
            <Stack gap="md">
              {showRepublishPrivateButton && (
                <Button
                  color="green"
                  onClick={handleRepublishPrivateModel}
                  loading={publishing}
                  fullWidth
                  leftSection={<IconRepeat size={16} />}
                >
                  Republish (keep private)
                </Button>
              )}
              {/* Primary Actions Card */}
              <Card withBorder p="md">
                <Stack gap="xs">
                  {canGenerate ? (
                    <GenerateButton
                      versionId={version.id}
                      data-tour="model:create"
                      data-activity="create:model"
                      disabled={isLoadingAccess || !!model.mode}
                      generationPrice={
                        !hasGeneratePermissions &&
                        !isLoadingAccess &&
                        earlyAccessConfig?.chargeForGeneration
                          ? earlyAccessConfig?.generationPrice
                          : undefined
                      }
                      onPurchase={() => onPurchase('generation')}
                      fullWidth
                    />
                  ) : null}
                  {/* Action icon buttons row */}
                  <Group gap={8} wrap="nowrap" justify="center" grow>
                    <Tooltip label="Share" position="top" withArrow>
                      <div style={{ flex: 1 }}>
                        <ShareButton
                          url={router.asPath}
                          title={model.name}
                          collect={{ modelId: model.id, type: CollectionType.Model }}
                        >
                          <Button
                            color="gray"
                            fullWidth
                            style={{ paddingLeft: 0, paddingRight: 0 }}
                          >
                            <IconShare3 size={18} />
                          </Button>
                        </ShareButton>
                      </div>
                    </Tooltip>
                    {onFavoriteClick && (
                      <Tooltip label={isFavorite ? 'Unlike' : 'Like'} position="top" withArrow>
                        <div style={{ flex: 1 }} data-tour="model:like">
                          <LoginRedirect reason="favorite-model">
                            <Button
                              onClick={() =>
                                onFavoriteClick({
                                  versionId: version.id,
                                  setTo: !isFavorite,
                                })
                              }
                              color={isFavorite ? 'green' : 'gray'}
                              fullWidth
                              style={{ paddingLeft: 0, paddingRight: 0 }}
                            >
                              <ThumbsUpIcon color="#fff" filled={isFavorite} size={18} />
                            </Button>
                          </LoginRedirect>
                        </div>
                      </Tooltip>
                    )}
                    {hasDownloadPermissions && !downloadsDisabled && !isPrivateModel && (
                      <ToggleVaultButton modelVersionId={version.id}>
                        {({ isLoading, isInVault, toggleVaultItem }) => (
                          <Tooltip
                            label={isInVault ? 'Remove from Vault' : 'Add To Vault'}
                            position="top"
                            withArrow
                          >
                            <Button
                              color={isInVault ? 'green' : 'gray'}
                              onClick={toggleVaultItem}
                              disabled={isLoading}
                              variant={isInVault ? 'light' : undefined}
                              fullWidth
                              style={{ paddingLeft: 0, paddingRight: 0 }}
                            >
                              {isLoading ? (
                                <Loader size="xs" />
                              ) : isInVault ? (
                                <IconCloudCheck size={18} />
                              ) : (
                                <IconCloudLock size={18} />
                              )}
                            </Button>
                          </Tooltip>
                        )}
                      </ToggleVaultButton>
                    )}
                    {displayCivitaiLink && (
                      <CivitaiLinkManageButton
                        modelId={model.id}
                        modelVersionId={version.id}
                        modelName={model.name}
                        modelType={model.type}
                        hashes={version.hashes}
                        noTooltip
                      >
                        {({ color, onClick, ref, icon, label }) => (
                          <Tooltip label={label}>
                            <Button
                              ref={ref}
                              color={color}
                              onClick={onClick}
                              disabled={!primaryFile}
                              variant="light"
                              fullWidth
                              style={{ paddingLeft: 0, paddingRight: 0 }}
                            >
                              {icon}
                            </Button>
                          </Tooltip>
                        )}
                      </CivitaiLinkManageButton>
                    )}
                    <Tooltip
                      label={
                        isNotificationOn
                          ? 'Stop getting notifications for this model'
                          : 'Get notifications for this model'
                      }
                      position="top"
                      withArrow
                    >
                      <div style={{ flex: 1 }}>
                        <LoginRedirect reason="notify-model">
                          <Button
                            color={isNotificationOn ? 'green' : 'gray'}
                            onClick={() =>
                              toggleNotifyModelMutation.mutate({
                                modelId: model.id,
                                type: isNotificationOn ? ModelEngagementType.Mute : undefined,
                              })
                            }
                            loading={toggleNotifyModelMutation.isLoading}
                            fullWidth
                            style={{ paddingLeft: 0, paddingRight: 0 }}
                          >
                            {isNotificationOn ? (
                              <IconBellCheck size={18} />
                            ) : (
                              <IconBellPlus size={18} />
                            )}
                          </Button>
                        </LoginRedirect>
                      </div>
                    </Tooltip>
                    <Tooltip label="Add to collection" position="top" withArrow>
                      <div style={{ flex: 1 }}>
                        <LoginRedirect reason="add-to-collection">
                          <Button
                            color="gray"
                            onClick={() =>
                              openAddToCollectionModal({
                                props: {
                                  modelId: model.id,
                                  type: CollectionType.Model,
                                },
                              })
                            }
                            fullWidth
                            style={{ paddingLeft: 0, paddingRight: 0 }}
                          >
                            <IconBookmark size={18} />
                          </Button>
                        </LoginRedirect>
                      </div>
                    </Tooltip>
                    {features.auctions && !deleted && !isModelUnpublished && (
                      <BidModelButton
                        entityData={getEntityDataForBidModelButton({
                          version,
                          model,
                          image,
                        })}
                        asButton
                        buttonProps={{
                          color: 'gray',
                          fullWidth: true,
                          style: { paddingLeft: 0, paddingRight: 0 },
                          children: <IconGavel size={18} />,
                        }}
                        divProps={{ style: { flex: 1 } }}
                      />
                    )}
                    {(!user || !isOwner || user.isModerator) && (
                      <Tooltip label="Report" position="top" withArrow>
                        <div style={{ flex: 1 }}>
                          <LoginRedirect reason="report-model">
                            <Button
                              color="gray"
                              onClick={() =>
                                openReportModal({
                                  entityType: ReportEntity.Model,
                                  entityId: model.id,
                                })
                              }
                              fullWidth
                              style={{ paddingLeft: 0, paddingRight: 0 }}
                            >
                              <IconFlag size={18} />
                            </Button>
                          </LoginRedirect>
                        </div>
                      </Tooltip>
                    )}
                  </Group>
                </Stack>
              </Card>
              {/* Component-only model message */}
              {isComponentOnlyModel && (
                <AlertWithIcon
                  color="blue"
                  iconColor="blue"
                  icon={<IconPuzzle size={16} />}
                  size="sm"
                  mt="xs"
                >
                  <Text size="sm">This is a modular model - download components below</Text>
                </AlertWithIcon>
              )}
              {/* Download Section */}
              {!hideDownload && !isComponentOnlyModel && hasVisibleFiles && (
                <Card withBorder>
                  <Card.Section withBorder inheritPadding py="xs" px="sm">
                    <Group justify="space-between">
                      <Text size="sm" fw={600}>
                        Download
                      </Text>
                      <Group gap="xs">
                        {isOwnerOrMod && (
                          <RoutedDialogLink name="filesEdit" state={{ modelVersionId: version.id }}>
                            <Text c="blue.4" size="xs">
                              Manage
                            </Text>
                          </RoutedDialogLink>
                        )}
                        <Text size="xs" c="dimmed">
                          {modelFilesVisible.length} variant
                          {modelFilesVisible.length !== 1 ? 's' : ''} available
                        </Text>
                      </Group>
                    </Group>
                  </Card.Section>
                  <Card.Section>
                    <DownloadVariantDropdown
                      files={filesVisible}
                      versionId={version.id}
                      modelType={model.type}
                      userPreferences={user?.filePreferences}
                      canDownload={canDownload}
                      downloadPrice={
                        !hasDownloadPermissions &&
                        !isLoadingAccess &&
                        earlyAccessConfig?.chargeForDownload
                          ? earlyAccessConfig?.downloadPrice
                          : undefined
                      }
                      isLoadingAccess={isLoadingAccess}
                      archived={archived}
                      onPurchase={() => onPurchase('download')}
                    />
                  </Card.Section>
                </Card>
              )}
            </Stack>
          )}
          {/* Download-related alert */}
          {hideDownload && (
            <AlertWithIcon color="blue" iconColor="blue" icon={<IconBrush size={16} />} size="sm">
              {isDownloadable && !isLoadingAccess ? (
                <Text>
                  You&apos;ve set this model to Generation-Only. Other users will not be able to
                  download this model. Click{' '}
                  <Text
                    component={Link}
                    td="underline"
                    href={`/models/${version.modelId}/model-versions/${version.id}/edit`}
                    className={!features.canWrite ? 'pointer-events-none' : undefined}
                  >
                    here
                  </Text>{' '}
                  to change this behavior.
                </Text>
              ) : (
                <Text>
                  The creator has set this model to Generation-Only.{' '}
                  <Text td="underline" component={Link} href="/articles/11494">
                    Learn more
                  </Text>
                </Text>
              )}
            </AlertWithIcon>
          )}

          {/* Status alerts */}
          {version.status === ModelStatus.UnpublishedViolation && !version.meta?.needsReview && (
            <AlertWithIcon color="red" iconColor="red" icon={<IconExclamationMark />}>
              <Text>
                This model has been unpublished due to a violation of our{' '}
                <Text component="a" href="/content/tos" target="_blank">
                  guidelines
                </Text>{' '}
                and is not visible to the community.{' '}
                {unpublishedReason && unpublishedMessage ? unpublishedMessage : null}
              </Text>
              <Text>
                If you adjust your model to comply with our guidelines, you can request a review
                from one of our moderators. If you believe this was done in error, you can{' '}
                <Text component="a" href="/content/content-appeal" target="_blank">
                  submit an appeal
                </Text>
                .
              </Text>
            </AlertWithIcon>
          )}
          {isPrivateModel && isOwnerOrMod && (
            <AlertWithIcon
              color="yellow"
              iconColor="yellow"
              icon={<IconLock />}
              title="Private Model"
            >
              {model.status !== ModelStatus.UnpublishedViolation &&
              version.status !== ModelStatus.UnpublishedViolation ? (
                <Text>
                  Want to start earning Buzz?{' '}
                  <Anchor onClick={handlePublishPrivateModel}>Publish this model</Anchor>
                </Text>
              ) : (
                <Text>This model is private and has been unpublished due to a violation.</Text>
              )}
            </AlertWithIcon>
          )}
          {version.status === ModelStatus.UnpublishedViolation && version.meta?.needsReview && (
            <AlertWithIcon color="yellow" iconColor="yellow" icon={<IconExclamationMark />}>
              This version is currently being reviewed by our moderators. It will be visible to the
              community once it has been approved.
            </AlertWithIcon>
          )}
          <EarlyAccessAlert
            modelId={model.id}
            versionId={version.id}
            modelType={model.type}
            deadline={version.earlyAccessEndsAt ?? undefined}
          />
          <ModelFileAlert
            versionId={version.id}
            modelType={model.type}
            files={version.files}
            baseModel={version.baseModel}
            usageControl={version.usageControl}
          />

          <Accordion
            variant="separated"
            multiple
            onChange={setDetailAccordions}
            value={detailAccordions}
            styles={(theme) => ({
              content: { padding: 0 },
              label: { padding: 0 },
              item: {
                overflow: 'hidden',
                borderColor: colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
                boxShadow: theme.shadows.sm,
              },
              control: {
                padding: theme.spacing.sm,
                gap: theme.spacing.md,
              },
            })}
          >
            {model.meta?.showcaseCollectionId && collection && (
              <Accordion.Item value="collection-showcase">
                <Accordion.Control
                  disabled={settingShowcase}
                  className="aria-expanded:border-b aria-expanded:border-solid aria-expanded:border-gray-2 dark:aria-expanded:border-dark-4"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <Link
                        href={`/collections/${model.meta?.showcaseCollectionId}`}
                        passHref
                        legacyBehavior
                      >
                        <Anchor
                          variant="text"
                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                          inherit
                        >
                          {collection.name}
                        </Anchor>
                      </Link>
                      <Text size="xs" c="dimmed">
                        Collection
                        {collection.itemCount > 0
                          ? ` - ${collection.itemCount.toLocaleString()} items`
                          : ''}
                      </Text>
                    </div>
                    {isOwnerOrMod ? (
                      <Anchor
                        size="sm"
                        className={clsx(
                          settingShowcase && 'pointer-events-none cursor-not-allowed text-dark-2'
                        )}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          e.preventDefault();
                          if (model.user.username)
                            openCollectionSelectModal({
                              username: model.user.username,
                              onSelect: (value) => {
                                if (collection.id !== value)
                                  setShowcaseCollection(value).catch(() => null);
                              },
                            });
                        }}
                      >
                        Edit
                      </Anchor>
                    ) : (
                      <CollectionFollowAction collectionId={collection.id} />
                    )}
                  </div>
                </Accordion.Control>
                <Accordion.Panel>
                  <CollectionShowcase modelId={model.id} loading={settingShowcase} />
                </Accordion.Panel>
              </Accordion.Item>
            )}
            {/* Required Components Section */}
            {isDownloadable &&
              (Object.keys(groupedFiles.requiredComponents).length > 0 ||
                requiredLinkedComponents.length > 0) && (
                <RequiredComponentsSection
                  groupedFiles={groupedFiles}
                  versionId={version.id}
                  userPreferences={user?.filePreferences}
                  canDownload={canDownload}
                  downloadPrice={
                    !hasDownloadPermissions &&
                    !isLoadingAccess &&
                    earlyAccessConfig?.chargeForDownload
                      ? earlyAccessConfig?.downloadPrice
                      : undefined
                  }
                  isLoadingAccess={isLoadingAccess}
                  archived={archived}
                  onPurchase={() => onPurchase('download')}
                  isPrimary={isComponentOnlyModel}
                  linkedComponents={requiredLinkedComponents}
                />
              )}
            {/* Optional Files Section */}
            {isDownloadable &&
              (groupedFiles.optionalFiles.length > 0 || optionalLinkedComponents.length > 0) && (
                <Accordion.Item value="optional-files">
                  <Accordion.Control>
                    <Group gap="xs">
                      <IconFileSettings size={18} style={{ color: theme.colors.dark[2] }} />
                      <Text fw={500}>Optional Files</Text>
                      <Badge size="sm" variant="light" color="gray">
                        {groupedFiles.optionalFiles.length + optionalLinkedComponents.length}
                      </Badge>
                    </Group>
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap={0}>
                      {/* Linked components (external resources) */}
                      {optionalLinkedComponents.map((lc) => {
                        const config = componentTypeConfig[lc.componentType];
                        const Icon = config?.icon ?? IconPuzzle;
                        return (
                          <Box
                            key={`lc-${lc.recommendedResourceId ?? lc.fileId}`}
                            p="sm"
                            style={{
                              borderBottom: `1px solid ${
                                colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2]
                              }`,
                            }}
                          >
                            <Group justify="space-between" wrap="nowrap">
                              <Group gap="sm" wrap="nowrap">
                                <ThemeIcon
                                  size={36}
                                  radius="md"
                                  color={config?.color ?? 'gray'}
                                  variant="light"
                                >
                                  <Icon size={20} />
                                </ThemeIcon>
                                <Box>
                                  <Group gap={6}>
                                    <Text
                                      component={Link}
                                      href={`/models/${lc.modelId}`}
                                      size="sm"
                                      fw={500}
                                      td="underline"
                                      style={{ textDecorationStyle: 'dotted' }}
                                    >
                                      {lc.modelName}
                                    </Text>
                                    <Badge size="xs" variant="light" color="gray">
                                      {config?.name ?? lc.componentType}
                                    </Badge>
                                  </Group>
                                  <Text size="xs" c="dimmed">
                                    {lc.versionName} &bull; {lc.fileName}
                                  </Text>
                                </Box>
                              </Group>
                              <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
                                {lc.sizeKB ? (
                                  <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                                    {formatKBytes(lc.sizeKB)}
                                  </Text>
                                ) : null}
                                <Tooltip
                                  label={
                                    canDownload
                                      ? 'Download from source model'
                                      : 'Purchase to download'
                                  }
                                >
                                  <ActionIcon
                                    component="a"
                                    href={
                                      archived || isLoadingAccess || !canDownload
                                        ? undefined
                                        : createModelFileDownloadUrl({
                                            versionId: lc.versionId,
                                            fileId: lc.fileId,
                                            type: lc.fileType,
                                            meta: lc.fileMetadata as BasicFileMetadata | undefined,
                                          })
                                    }
                                    onClick={(e: React.MouseEvent) => {
                                      if (!canDownload) {
                                        e.preventDefault();
                                        onPurchase('download');
                                      }
                                    }}
                                    variant="light"
                                    color="gray"
                                    size="md"
                                    radius="md"
                                    disabled={archived || isLoadingAccess}
                                  >
                                    <IconDownload size={16} />
                                  </ActionIcon>
                                </Tooltip>
                              </Group>
                            </Group>
                          </Box>
                        );
                      })}
                      {/* Regular optional files */}
                      {groupedFiles.optionalFiles.map((file) => {
                        const iconConfig = getFileIconConfig(file.name, file.metadata);
                        const FileIcon = iconConfig.icon;
                        const ext = file.name.split('.').pop() ?? '';
                        const downloadUrl = createModelFileDownloadUrl({
                          versionId: version.id,
                          fileId: file.id,
                          type: file.type,
                          meta: file.metadata,
                        });

                        return (
                          <Box
                            key={file.id}
                            p="sm"
                            style={{
                              borderBottom: `1px solid ${
                                colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2]
                              }`,
                            }}
                          >
                            <Group justify="space-between" wrap="nowrap">
                              <Group gap="sm" wrap="nowrap">
                                <ThemeIcon
                                  size={36}
                                  radius="md"
                                  color="gray"
                                  variant="light"
                                  style={{ opacity: 0.6 }}
                                >
                                  <FileIcon size={20} />
                                </ThemeIcon>
                                <Box>
                                  <Text size="sm" fw={500}>
                                    {file.name}
                                  </Text>
                                  <Text size="xs" c="dimmed">
                                    .{ext} &bull; {formatKBytes(file.sizeKB)}
                                  </Text>
                                  <VerifiedText file={file} />
                                </Box>
                              </Group>
                              <Tooltip label={canDownload ? 'Download' : 'Purchase to download'}>
                                <ActionIcon
                                  component="a"
                                  href={
                                    archived || isLoadingAccess || !canDownload
                                      ? undefined
                                      : downloadUrl
                                  }
                                  onClick={(e: React.MouseEvent) => {
                                    if (!canDownload) {
                                      e.preventDefault();
                                      onPurchase('download');
                                    }
                                  }}
                                  variant="light"
                                  color="gray"
                                  size="md"
                                  radius="md"
                                  disabled={archived || isLoadingAccess}
                                >
                                  <IconDownload size={16} />
                                </ActionIcon>
                              </Tooltip>
                            </Group>
                          </Box>
                        );
                      })}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              )}
            <Accordion.Item value="version-details">
              <Accordion.Control>
                <Group justify="space-between">
                  Details
                  {showEditButton && (
                    <Menu withinPortal>
                      <Menu.Target>
                        <Anchor size="sm" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                          Edit
                        </Anchor>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          component={Link}
                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                          href={`/models/${version.modelId}/edit`}
                          className={!features.canWrite ? 'pointer-events-none' : undefined}
                        >
                          Edit Model Details
                        </Menu.Item>
                        <Menu.Item
                          component={Link}
                          onClick={(e: React.MouseEvent) => e.stopPropagation()}
                          href={`/models/${version.modelId}/model-versions/${version.id}/edit`}
                          className={!features.canWrite ? 'pointer-events-none' : undefined}
                        >
                          Edit Version Details
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  )}
                </Group>
              </Accordion.Control>
              <Accordion.Panel p={0}>
                <Stack
                  gap={0}
                  style={{
                    backgroundColor: colorScheme === 'dark' ? '#1f2023' : theme.colors.gray[0],
                  }}
                >
                  {/* Type */}
                  <Group
                    justify="space-between"
                    px="md"
                    py={10}
                    style={{
                      borderBottom: `1px solid ${
                        colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                      }`,
                    }}
                  >
                    <Text size="sm" c="dimmed">
                      Type
                    </Text>
                    <Group gap={6}>
                      <Badge size="sm" radius="xl" variant="filled" color="gray">
                        {getDisplayName(model.type)} {model.checkpointType}
                      </Badge>
                      {version.status !== ModelStatus.Published ? (
                        <Badge size="sm" radius="xl" color="yellow" variant="light">
                          {version.status}
                        </Badge>
                      ) : (
                        <HowToUseModel type={model.type} />
                      )}
                    </Group>
                  </Group>
                  {/* Stats */}
                  <Group
                    justify="space-between"
                    px="md"
                    py={10}
                    style={{
                      borderBottom: `1px solid ${
                        colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                      }`,
                    }}
                  >
                    <Text size="sm" c="dimmed">
                      Stats
                    </Text>
                    <Group gap={12}>
                      {!downloadsDisabled && (
                        <Group gap={4}>
                          <IconDownload size={16} style={{ opacity: 0.5 }} />
                          <Text size="sm">
                            <AnimatedCount value={liveMetrics.downloadCount} abbreviate={false} />
                          </Text>
                        </Group>
                      )}
                      {canGenerate && (
                        <Group gap={4}>
                          <IconBrush size={16} style={{ opacity: 0.5 }} />
                          <Text size="sm">
                            <AnimatedCount value={liveMetrics.generationCount} />
                          </Text>
                        </Group>
                      )}
                      {!!liveMetrics.earnedAmount && (
                        <Group gap={4}>
                          <IconBolt size={16} style={{ opacity: 0.5 }} />
                          <Text size="sm">
                            <AnimatedCount value={liveMetrics.earnedAmount} />
                          </Text>
                        </Group>
                      )}
                    </Group>
                  </Group>
                  {/* Generation Popularity */}
                  {canGenerate &&
                    features.modelVersionPopularity &&
                    model.type === ModelType.Checkpoint && (
                      <Group
                        justify="space-between"
                        px="md"
                        py={10}
                        style={{
                          borderBottom: `1px solid ${
                            colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                          }`,
                        }}
                      >
                        <Text size="sm" c="dimmed">
                          Generation
                        </Text>
                        <ModelVersionPopularity
                          versionId={version.id}
                          isCheckpoint={model.type === ModelType.Checkpoint}
                          listenForUpdates
                        />
                      </Group>
                    )}
                  {/* Reviews */}
                  <Group
                    justify="space-between"
                    px="md"
                    py={10}
                    style={{
                      borderBottom: `1px solid ${
                        colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                      }`,
                    }}
                  >
                    <Text size="sm" c="dimmed">
                      Reviews
                    </Text>
                    <ModelVersionReview
                      modelId={model.id}
                      versionId={version.id}
                      thumbsUpCount={liveMetrics.thumbsUpCount}
                      thumbsDownCount={liveMetrics.thumbsDownCount}
                    />
                  </Group>
                  {/* Published */}
                  <Group
                    justify="space-between"
                    px="md"
                    py={10}
                    style={{
                      borderBottom: `1px solid ${
                        colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                      }`,
                    }}
                  >
                    <Text size="sm" c="dimmed">
                      {version.status === 'Published' && version.publishedAt
                        ? 'Published'
                        : 'Uploaded'}
                    </Text>
                    <Text size="sm">
                      {formatDate(
                        version.status === 'Published' && version.publishedAt
                          ? version.publishedAt
                          : version.createdAt
                      )}
                    </Text>
                  </Group>
                  {/* Base Model */}
                  <Group
                    justify="space-between"
                    px="md"
                    py={10}
                    style={{
                      borderBottom: `1px solid ${
                        colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                      }`,
                    }}
                  >
                    <Text size="sm" c="dimmed">
                      Base Model
                    </Text>
                    <Text size="sm">
                      {version.baseModel}{' '}
                      {version.baseModelType && version.baseModelType !== 'Standard'
                        ? version.baseModelType
                        : ''}
                    </Text>
                  </Group>
                  {/* Hash */}
                  {!!hashes.length && (
                    <Group justify="space-between" px="md" py={10}>
                      <Text size="sm" c="dimmed">
                        Hash
                      </Text>
                      <ModelHash hashes={hashes} />
                    </Group>
                  )}
                  {/* Trigger Words */}
                  {!!version.trainedWords?.length && (
                    <Group
                      justify="space-between"
                      px="md"
                      py={10}
                      style={{
                        borderTop: `1px solid ${
                          colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                        }`,
                      }}
                    >
                      <Text size="sm" c="dimmed">
                        Trigger Words
                      </Text>
                      <TrainedWords
                        trainedWords={version.trainedWords}
                        files={version.files}
                        type={model.type}
                      />
                    </Group>
                  )}
                  {/* AIR */}
                  {features.air && (
                    <Group
                      justify="space-between"
                      px="md"
                      py={10}
                      style={{
                        borderTop: `1px solid ${
                          colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
                        }`,
                      }}
                    >
                      <Group gap="xs">
                        <Text size="sm" c="dimmed">
                          AIR
                        </Text>
                        <URNExplanation size={16} />
                      </Group>
                      <ModelURN
                        baseModel={version.baseModel}
                        type={model.type}
                        modelId={model.id}
                        modelVersionId={version.id}
                      />
                    </Group>
                  )}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
            {version.recommendedResources && version.recommendedResources.length > 0 && (
              <Accordion.Item value="recommended-resources">
                <Accordion.Control>Recommended Resources</Accordion.Control>
                <Accordion.Panel>
                  <Stack gap={2}>
                    {version.recommendedResources.map((resource) => (
                      <Card
                        key={resource.id}
                        component={Link}
                        href={`/models/${resource.model.id}?modelVersionId=${resource.id}`}
                        radius={0}
                        py="xs"
                        style={{
                          cursor: 'pointer',
                          backgroundColor:
                            colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
                        }}
                        data-activity="follow-recommendation:details"
                      >
                        <Stack gap={4}>
                          <Group justify="space-between" gap={8} wrap="nowrap">
                            <Text size="xs" fw={500} lineClamp={2}>
                              {resource.model.name}
                            </Text>
                            <Badge size="xs">{getDisplayName(resource.model.type)}</Badge>
                          </Group>
                          <Text c="dimmed" size="xs">
                            {resource.name}
                          </Text>
                        </Stack>
                      </Card>
                    ))}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            )}
            {version.description && (
              <Accordion.Item value="version-description">
                <Accordion.Control>About this version</Accordion.Control>
                <Accordion.Panel px="sm">
                  <Stack gap={4} className="pb-3">
                    {version.description && (
                      <Box style={{ p: { fontSize: 14, marginBottom: 10 } }}>
                        <ContentClamp
                          maxHeight={200}
                          controlRef={controlRef}
                          styles={{ control: { display: 'none' } }}
                        >
                          <RenderHtml html={version.description} />
                        </ContentClamp>
                      </Box>
                    )}
                    {cleanDescription.length > 150 ? (
                      <Text
                        c="blue.4"
                        size="xs"
                        onClick={() =>
                          dialogStore.trigger({
                            component: VersionDescriptionModal,
                            props: { description: version.description ?? '' },
                          })
                        }
                        tabIndex={0}
                        style={{ cursor: 'pointer' }}
                      >
                        Show more
                      </Text>
                    ) : null}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            )}
          </Accordion>

          {/* Resource Review - shown after model details for users who downloaded */}
          {!model.locked && alreadyDownloaded && (
            <UserResourceReviewComposite
              modelId={model.id}
              modelVersionId={version.id}
              modelName={model.name}
            >
              {({ modelId, modelVersionId, userReview, loading }) => (
                <Card p={8} withBorder>
                  <Stack gap={8}>
                    <Group gap={8} justify="space-between" wrap="nowrap">
                      <Group gap={8} wrap="nowrap">
                        {loading ? (
                          <Loader size="xs" />
                        ) : userReview ? (
                          <>
                            {userReview.recommended ? (
                              <ThumbsUpIcon size={18} />
                            ) : (
                              <ThumbsDownIcon size={18} />
                            )}
                          </>
                        ) : (
                          <IconHeart size={18} />
                        )}
                        {userReview ? (
                          <Text size="sm">
                            You reviewed this on {formatDateMin(userReview.createdAt, false)}
                          </Text>
                        ) : (
                          <Text size="sm">What did you think of this resource?</Text>
                        )}
                      </Group>
                      {!userReview || !userReview.details ? (
                        <ResourceReviewThumbActions
                          modelId={modelId}
                          modelVersionId={modelVersionId}
                          userReview={userReview}
                          size="xs"
                        />
                      ) : (
                        <Group wrap="nowrap" gap={4}>
                          <Button
                            size="xs"
                            color="gray"
                            onClick={() => openResourceReviewEditModal(userReview)}
                          >
                            See Review
                          </Button>
                          <Button
                            size="xs"
                            color="gray"
                            component={Link}
                            px={7}
                            href={`/posts/create?modelId=${modelId}&modelVersionId=${modelVersionId}`}
                          >
                            <IconPhotoPlus size={16} />
                          </Button>
                        </Group>
                      )}
                    </Group>
                  </Stack>
                  {userReview && !userReview.details && (
                    <Card.Section py="sm" mt="sm" inheritPadding withBorder>
                      <EditUserResourceReviewLight
                        modelId={modelId}
                        modelVersionId={modelVersionId}
                        userReview={userReview}
                      />
                    </Card.Section>
                  )}
                </Card>
              )}
            </UserResourceReviewComposite>
          )}

          <ModelVersionDonationGoals modelVersionId={version.id} />

          <SmartCreatorCard
            user={model.user}
            tipBuzzEntityType="Model"
            tipBuzzEntityId={model.id}
            tipsEnabled={!model.poi}
          />
          {onSite && (
            <Group
              align="flex-start"
              justify="flex-end"
              gap={4}
              mt={-10}
              mb={-5}
              style={{ opacity: 0.5 }}
            >
              <IconCivitai size={14} />
              <Text size="xs" lh={1}>
                Created on Civitai
              </Text>
            </Group>
          )}

          <Group justify="space-between" align="flex-start" wrap="nowrap">
            {model.type === 'Checkpoint' && (
              <Stack gap={4}>
                <Group
                  gap={4}
                  wrap="nowrap"
                  style={{ flex: 1, overflow: 'hidden' }}
                  align="flex-start"
                >
                  <IconLicense size={16} />
                  <Text
                    size="xs"
                    c="dimmed"
                    style={{
                      whiteSpace: 'nowrap',
                      lineHeight: 1.1,
                    }}
                  >
                    License{model.licenses.length > 0 ? 's' : ''}:
                  </Text>
                </Group>
                {license && (
                  <Text
                    component="a"
                    href={license.url}
                    rel="nofollow noreferrer"
                    td="underline"
                    target="_blank"
                    size="xs"
                    c="dimmed"
                    style={{ lineHeight: 1.1 }}
                  >
                    {license.name}
                  </Text>
                )}
                {showAddendumLicense && (
                  <Link legacyBehavior href={`/models/license/${version.id}`} passHref>
                    <Anchor
                      variant="text"
                      td="underline"
                      size="xs"
                      c="dimmed"
                      style={{ lineHeight: 1.1 }}
                    >
                      Addendum
                    </Anchor>
                  </Link>
                )}
                {model.licenses.map(({ url, name }) => (
                  <Text
                    key={name}
                    component="a"
                    rel="nofollow"
                    href={url}
                    td="underline"
                    size="xs"
                    c="dimmed"
                    target="_blank"
                    style={{ lineHeight: 1.1 }}
                  >
                    {name}
                  </Text>
                ))}
              </Stack>
            )}
            <PermissionIndicator permissions={model} ml="auto" />
          </Group>
          {license?.notice && (
            <Text size="xs" c="dimmed">
              {license.notice}
            </Text>
          )}
          {license?.poweredBy && (
            <Text size="xs" fw={500}>
              {license.poweredBy}
            </Text>
          )}
          {hasPendingClaimReport && (
            <AlertWithIcon icon={<IconMessageCircle2 />}>
              {`A verified artist believes this model was fine-tuned on their art. We're discussing this with the model creator and artist`}
            </AlertWithIcon>
          )}
          {model.poi && <PoiAlert />}
          {!model.poi && <AdUnitSide_2 />}
        </Stack>
      </ContainerGrid2.Col>

      <ContainerGrid2.Col
        span={{ base: 12, sm: 7, md: 8 }}
        order={{ sm: 1 }}
        className={classes.mainSection}
      >
        <Stack>
          {model.mode !== ModelModifier.TakenDown && !mobile && (
            <ModelCarousel
              modelId={model.id}
              modelVersionId={version.id}
              modelUserId={model.user.id}
              limit={CAROUSEL_LIMIT}
            />
          )}
          {model.description ? (
            <ContentClamp maxHeight={460}>
              <RenderHtml html={model.description} />
            </ContentClamp>
          ) : null}
        </Stack>
      </ContainerGrid2.Col>
    </ContainerGrid2>
  );
}

type Props = {
  version: ModelById['modelVersions'][number];
  model: ModelById;
  image: ImagesInfiniteModel | undefined;
  onFavoriteClick?: (ctx: { versionId?: number; setTo: boolean }) => void;
};

function VersionDescriptionModal({ description }: { description: string }) {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} title="About this version" size="lg" centered>
      <RenderHtml html={description} />
    </Modal>
  );
}
