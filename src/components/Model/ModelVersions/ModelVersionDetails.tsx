import { type ModelVersionTerms, acceptsBlueBuzz, generationPrice } from '@civitai/buzz';
import { generatorReadiness } from '~/shared/generation/generator-readiness';
import { formatLicensingFee } from '~/utils/licensing-fee-display';
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
  Popover,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useDisclosure, useLocalStorage } from '@mantine/hooks';
import {
  IconBellCheck,
  IconBellPlus,
  IconBolt,
  IconBookmark,
  IconBrush,
  IconCalendarPlus,
  IconClock,
  IconCloudCheck,
  IconCloudLock,
  IconDownload,
  IconExclamationMark,
  IconFileSettings,
  IconFlag,
  IconGavel,
  IconHeart,
  IconInfoSquareRounded,
  IconLock,
  IconMessageCircle2,
  IconPhotoPlus,
  IconPuzzle,
  IconRepeat,
  IconShare3,
} from '@tabler/icons-react';
import type { TRPCClientErrorBase } from '@trpc/client';
import type { TRPCDefaultErrorShape } from '@trpc/server';
import clsx from 'clsx';
import { useRouter } from 'next/router';
import { forwardRef, useMemo, useRef, useState } from 'react';
import { AdUnitSide_2 } from '~/components/Ads/AdUnit';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { DsTooltip } from '~/components/AppLayout/ShellDs/ContentDs';
import { ShellButton } from '~/components/AppLayout/ShellDs/ShellDs';
import { BlockSlot } from '~/components/AppBlocks/BlockSlot';
import { PublisherSubscriptionBanner } from '~/components/Apps/PublisherSubscriptionBanner';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import {
  BidModelButton,
  getEntityDataForBidModelButton,
} from '~/components/Auction/BidModelButton';
import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { CollectionFollowAction } from '~/components/Collections/components/CollectionFollow';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { AnimatedCount, useLiveMetrics, useMetricSubscription } from '~/components/Metrics';
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
import { ModelUnpublishedAlert } from '~/components/Model/ModelUnpublishedAlert';
import { siteAppealHref } from '~/components/SiteAppeal/site-appeal-href';
import { useModelShowcaseCollection } from '~/components/Model/model.utils';
import { ModelAvailabilityUpdate } from '~/components/Model/ModelAvailabilityUpdate/ModelAvailabilityUpdate';
import { ModelCarousel } from '~/components/Model/ModelCarousel/ModelCarousel';
import { ModelFileAlert } from '~/components/Model/ModelFileAlert/ModelFileAlert';
import { ModelHash } from '~/components/Model/ModelHash/ModelHash';
import {
  ModelBadge,
  PageGroup,
  PageStack,
  PageText,
  VersionDetailsCol,
  VersionDetailsGrid,
} from '~/components/Model/ModelPageDs/ModelPageDs';
import { ModelURN, URNExplanation } from '~/components/Model/ModelURN/ModelURN';
import { DownloadVariantDropdown } from '~/components/Model/ModelVersions/DownloadVariantDropdown';
import { ModelModerationCard } from '~/components/Model/ModelVersions/ModelModerationCard';
import { ModelTensorMetadata } from '~/components/Model/ModelVersions/ModelTensorMetadata';
import { LoadedCornerBadge } from '~/components/ResourceLoad/ResourceResidency';
import { ModelVersionReview } from '~/components/Model/ModelVersions/ModelVersionReview';
import { RequiredComponentsSection } from '~/components/Model/ModelVersions/RequiredComponentsSection';
import { VerifiedText } from '~/components/VerifiedText/VerifiedText';
import {
  toModelVersionPermissionData,
  useModelVersionPermission,
  useQueryModelVersionsEngagement,
} from '~/components/Model/ModelVersions/model-version.utils';
import {
  getModelVersionActionLayout,
  showRequestReviewFor,
} from '~/components/Model/ModelVersions/model-version-layout';
import ModelVersionDonationGoal from '~/components/Model/ModelVersions/ModelVersionDonationGoal';
import { ModelVersionSaleBanner } from '~/components/Model/ModelVersions/ModelVersionSaleBadge';
import { ModelVersionEarlyAccessPurchase } from '~/components/Model/ModelVersions/ModelVersionEarlyAccessPurchase';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PermissionIndicator } from '~/components/PermissionIndicator/PermissionIndicator';
import { BaseModelWarningAlert } from '~/components/Model/BaseModelWarningAlert/BaseModelWarningAlert';
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
import { BaseModelLicense } from '~/components/Model/ModelVersions/BaseModelLicense';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useEngagedModelMembership } from '~/hooks/useEngagedModelMembership';
import { applyNotifyToggled } from '~/store/engaged-models.optimistic';
import { restoreMembership, snapshotMembership } from '~/store/engaged-models.store';
import { useIsMobile } from '~/hooks/useIsMobile';
import useIsClient from '~/hooks/useIsClient';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  CAROUSEL_LIMIT,
  constants,
  getEffectiveCommercialUse,
  getDisplayedBaseModelLicense,
  getEffectiveDifferentLicense,
  getRestrictedNsfwLevelsForBaseModel,
  hasAdditionalLicensePermissions,
} from '~/server/common/constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { getBaseModelGroup } from '~/shared/constants/basemodel.constants';
import { SfwOnlyBadge } from '~/components/SfwOnlyBadge/SfwOnlyBadge';
import { getEcosystemSeoPageForKey } from '~/shared/constants/ecosystem-seo.constants';
import { ReportEntity } from '~/shared/utils/report-helpers';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import {
  getPrimaryFile,
  groupFilesByVariant,
  resolveActiveFile,
} from '~/server/utils/model-helpers';
import {
  AppealCategory,
  Availability,
  CollectionType,
  ModelEngagementType,
  ModelFileVisibility,
  ModelModifier,
  ModelStatus,
  ModelUsageControl,
} from '~/shared/utils/prisma/enums';
import type { ModelById } from '~/types/router';
import { useLockReviewAction } from '~/components/Model/LockReview/useLockReviewAction';
import { HiddenMetricNotice } from '~/components/Model/HiddenMetricNotice';
import { formatDate, formatDateMin } from '~/utils/date-helpers';
import { notifyIfPublishHeld } from '~/utils/model-publish-toast';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { componentTypeConfig, getFileIconConfig } from '~/utils/file-display-icons';
import { formatKBytes } from '~/utils/number-helpers';
import { getDisplayName, getModelUrl, removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import classes from './ModelVersionDetails.module.scss';

// Hoisted constant inline-style objects — these previously allocated a fresh
// object on every render inside the Details/file rows (feeding SSR GC). Same
// values, referenced by identity.
const styleDottedUnderline: React.CSSProperties = { textDecorationStyle: 'dotted' };
const styleNowrap: React.CSSProperties = { whiteSpace: 'nowrap' };
const styleFlexShrink0: React.CSSProperties = { flexShrink: 0 };
const styleOpacity06: React.CSSProperties = { opacity: 0.6 };
const styleIconOpacity: React.CSSProperties = { opacity: 0.5 };

export function ModelVersionDetails(props: Props) {
  return <ModelVersionDetailsContent {...props} />;
}

function ModelVersionDetailsContent({ model, version, image, onFavoriteClick, ds = false }: Props) {
  useMetricSubscription('ModelVersion', version.id);
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const user = useCurrentUser();
  // `showNsfw` lives on the browsing-settings store (BrowserSettingsProvider),
  // not on CurrentUser — that field was removed from CurrentUser when the
  // browsing-settings refactor moved viewer prefs into their own provider.
  const viewerShowNsfw = useBrowsingSettings((x) => x.showNsfw);
  const { connected: civitaiLinked } = useCivitaiLink();
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const features = useFeatureFlags();
  // `modelPageDeferBelowFold` trial: below-the-fold, non-SEO sections render only once the client
  // has mounted, behind fixed-height placeholders. The flag is serialised with the page, so the
  // server render and the hydrating render both see `true && !isClient` and emit the same
  // placeholders; the real sections replace them on the next client render. With the flag off this
  // is always false and the page renders exactly as before.
  const isClient = useIsClient();
  const deferBelowFold = !!features.modelPageDeferBelowFold && !isClient;
  // TODO.manuel: use control ref to display the show more button
  const controlRef = useRef<HTMLButtonElement | null>(null);
  const [detailAccordions, setDetailAccordions] = useLocalStorage({
    key: 'model-version-details-accordions',
    defaultValue: ['version-details', 'required-components'],
  });
  const adContainerRef = useRef<HTMLDivElement | null>(null);
  const [feeInfoOpened, feeInfoHandlers] = useDisclosure(false);

  // The version is already on hand from model.getById: the permission hook and the children that call
  // it read this instead of refetching modelVersion.getById.
  const permissionData = toModelVersionPermissionData(model, version);

  const {
    isLoadingAccess,
    isDownloadable,
    isSelectableInGenerator,
    canDownload: hasDownloadPermissions,
    canGenerate: hasGeneratePermissions,
    generationRequiresPurchase,
  } = useModelVersionPermission({
    modelVersionId: version.id,
    modelVersion: permissionData,
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

  const filesCount = version.files?.length;
  // ExternalGeneration versions are intentionally file-less (routed via external engines),
  // so publish/republish gates should treat them as having the required assets.
  const isExternalGeneration = version.usageControl === ModelUsageControl.ExternalGeneration;
  const hasFiles = filesCount > 0 || isExternalGeneration;
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
  const tensorMetadataEnabled = detailAccordions.includes('tensor-metadata');

  // Shared active-file selection: the download variant picker drives it, and the
  // Tensors panel and the details rows below follow it (instead of each having
  // its own file selector).
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  // modelFilesVisible is empty for component-only and ExternalGeneration
  // versions, which still need a file for the Hash/AIR rows below.
  const activeFile = useMemo(
    () =>
      resolveActiveFile(modelFilesVisible, selectedFileId, {
        metadata: user?.filePreferences,
      }) ?? primaryFile,
    [modelFilesVisible, selectedFileId, user?.filePreferences, primaryFile]
  );
  const hashes = activeFile?.hashes ?? [];

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

  const paidAccessEndsAt = version?.paidAccess?.endsAt;
  const isEarlyAccess = !!paidAccessEndsAt && paidAccessEndsAt > new Date();
  const paidAccessTerms = version?.paidAccess?.terms as ModelVersionTerms | undefined;
  // Owners see it too, worded differently: they are quoted their stored price, but their own live sale
  // should not be invisible on their own model page.
  const saleForViewer = version?.paidAccess?.sale ?? null;
  // What the PAGE shows. `paidAccess.terms` stays the stored value because the version edit form
  // initialises from it and would otherwise save a discounted price back over the creator's own — the
  // same reason the tier cap is never folded into it. That rule protects an editor, not a button: an
  // owner reading their own model page should see the price a buyer is quoted, like everyone else.
  const displayTerms = saleForViewer?.buyerTerms ?? paidAccessTerms;
  // Which Buzz the price chips advertise — a sale that takes Blue must not read as Yellow-only.
  const paidAccessAcceptsBlue = acceptsBlueBuzz(paidAccessTerms);
  const isDraft = version?.status === ModelStatus.Draft;

  // const shouldOmit = [1562709, 1672021, 1669468].includes(model.id) && !user?.isModerator;
  // Owners/mods can test covered drafts before publishing, including hosted weights.
  // version.canGenerate below still enforces coverage, ecosystem support, and generation gates.
  const couldGenerate =
    (!isDraft || isOwnerOrMod) &&
    isSelectableInGenerator &&
    features.imageGeneration &&
    // !shouldOmit &&
    (!isEarlyAccess || !!paidAccessTerms?.generation || hasGeneratePermissions);
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
        const result = await publishModelMutation.mutateAsync({
          id: model.id,
          versionIds,
        });
        notifyIfPublishHeld(result);
      } else {
        // Just republish the version and its posts
        const result = await publishVersionMutation.mutateAsync({ id: version.id });
        notifyIfPublishHeld(result);
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
      props: { modelVersionId: version.id, reason, modelVersion: permissionData },
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
  // PR2: per-visible-set membership for this single model (Notify/Mute).
  const { isEngaged: isModelEngaged, isKnown: isNotifyKnown } = useEngagedModelMembership(model.id);
  const { data: followingUsers = [] } = trpc.user.getFollowingUsers.useQuery(undefined, {
    enabled: !!user,
    staleTime: 60 * 1000, // 1 minute - avoid refetching on every model view
  });
  const isNotificationOn =
    (followingUsers.includes(model.user.id) || isModelEngaged('Notify')) && !isModelEngaged('Mute');
  const toggleNotifyModelMutation = trpc.user.toggleNotifyModel.useMutation({
    onMutate() {
      // Optimistic store update + snapshot for rollback.
      const snapshot = snapshotMembership(model.id);
      applyNotifyToggled(model.id, !isNotificationOn);
      return { snapshot };
    },
    onError(error, _vars, context) {
      if (context?.snapshot) restoreMembership(model.id, context.snapshot);
      showErrorNotification({ title: 'Failed to update notification settings', error });
    },
  });

  const handlePublishClick = async (publishDate?: Date) => {
    try {
      if (model.status !== ModelStatus.Published) {
        // Publish model, version and all of its posts
        const versionIds =
          model.status === ModelStatus.UnpublishedViolation && user?.isModerator
            ? model.modelVersions.map(({ id }) => id)
            : [version.id];
        const result = await publishModelMutation.mutateAsync({
          id: model.id,
          publishedAt: publishDate,
          versionIds,
        });
        notifyIfPublishHeld(result);
      } else {
        // Just publish the version and its posts
        const result = await publishVersionMutation.mutateAsync({
          id: version.id,
          publishedAt: publishDate,
        });
        notifyIfPublishHeld(result);
      }

      await queryUtils.model.getById.invalidate({ id: model.id });
      await queryUtils.modelVersion.getById.invalidate({ id: version.id });
      await queryUtils.image.getInfinite.invalidate();
    } catch (e) {
      const error = e as TRPCClientErrorBase<TRPCDefaultErrorShape>;
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
      const error = e as TRPCClientErrorBase<TRPCDefaultErrorShape>;
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
  const publishing = publishModelMutation.isPending || publishVersionMutation.isPending;
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
  const violation =
    model.status === ModelStatus.UnpublishedViolation ||
    version.status === ModelStatus.UnpublishedViolation;
  const underReview = !!(model.meta?.needsReview || version.meta?.needsReview);
  const showRequestReview = showRequestReviewFor({
    isOwner: !!isOwner,
    isModerator: !!user?.isModerator,
    violation,
    underReview,
  });
  const deleted = !!model.deletedAt && model.status === ModelStatus.Deleted;
  const showEditButton = isOwnerOrMod && !deleted && !showRequestReview;
  const license = getDisplayedBaseModelLicense(version.baseModel);
  // Link the base model to its ecosystem SEO landing page when one is live (SEO internal linking).
  const ecosystemSeoPage = getEcosystemSeoPageForKey(getBaseModelGroup(version.baseModel));
  // Base model can restrict mature content (e.g. Ideogram) and/or commercial use.
  // Both are derived per displayed version rather than stored on the model.
  const baseModelRestrictsMature =
    getRestrictedNsfwLevelsForBaseModel(version.baseModel).length > 0;
  const onSite = !!version.trainingStatus;
  const showAddendumLicense =
    constants.supportedBaseModelAddendums.includes(version.baseModel as 'SD 1.5' | 'SDXL 1.0') &&
    hasAdditionalLicensePermissions(model);

  const { branch, showDownloadSection } = getModelVersionActionLayout({
    showRequestReview,
    showPublishButton: !!showPublishButton,
    hideDownload,
    isComponentOnlyModel,
    hasVisibleFiles,
  });

  const downloadSection = showDownloadSection ? (
    <Card withBorder data-tour="model:download">
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
          selectedFileId={selectedFileId}
          onSelectFileId={setSelectedFileId}
          canDownload={canDownload}
          downloadPrice={
            !hasDownloadPermissions && !isLoadingAccess && displayTerms?.download
              ? displayTerms.download.price
              : undefined
          }
          listedPrice={
            hasDownloadPermissions && isOwnerOrMod && displayTerms?.download
              ? displayTerms.download.price
              : undefined
          }
          acceptsBlueBuzz={paidAccessAcceptsBlue}
          isLoadingAccess={isLoadingAccess}
          archived={archived}
          onPurchase={() => onPurchase('download')}
        />
      </Card.Section>
    </Card>
  ) : null;

  return (
    <VersionDetailsGrid ds={ds}>
      <TrackView entityId={version.id} entityType="ModelVersion" type="ModelVersionView" />
      <VersionDetailsCol
        ds={ds}
        side="sidebar"
        className={classes.sidebarSection}
        ref={adContainerRef}
      >
        <Stack>
          {/* Owner-only banner: lists publisher_all_my_models subscriptions
              that would render here so the model owner can opt out of any
              specific subscription for this model. Hidden for non-owners. */}
          {isOwner && <PublisherSubscriptionBanner modelId={model.id} modelType={model.type} />}
          {model.mode !== ModelModifier.TakenDown && mobile && (
            <ModelCarousel
              modelId={model.id}
              modelVersionId={version.id}
              modelUserId={model.user.id}
              limit={CAROUSEL_LIMIT}
              minor={model.minor}
            />
          )}
          {/* App Blocks: model.sidebar_top slot. Renders publisher-installed and
              platform-default blocks, capped at 3. Client-only — the server
              emits a placeholder div.
              Placed AFTER the mobile-only ModelCarousel above so that on small
              screens (where the sidebar column stacks full-width) the block sits
              BELOW the image carousel rather than pushing it down. On sm+ the
              mobile carousel renders nothing, so the block keeps its sidebar-top
              position (the gallery lives in the other grid column). */}
          <BlockSlot
            slotId="model.sidebar_top"
            context={{
              slotId: 'model.sidebar_top',
              modelId: model.id,
              modelVersionId: version.id,
              modelName: model.name,
              modelType: model.type,
              modelNsfwLevel: model.nsfwLevel,
              creatorUserId: model.user.id,
              viewerUserId: user?.id ?? null,
              viewerUsername: user?.username ?? null,
              viewerStatus: user?.bannedAt ? 'banned' : user?.muted ? 'muted' : 'active',
              viewerNsfwEnabled: viewerShowNsfw,
              theme: colorScheme === 'dark' ? 'dark' : 'light',
            }}
          />
          {branch === 'request-review' ? (
            <Button
              color="yellow"
              onClick={handleRequestReviewClick}
              loading={requestReviewMutation.isPending || requestVersionReviewMutation.isPending}
              fullWidth
            >
              Request a Review
            </Button>
          ) : branch === 'publish-pending' ? (
            <Stack gap={4}>
              {canGenerate && isOwnerOrMod && (
                <GenerateButton
                  versionId={version.id}
                  modelId={model.id}
                  wildcardSetId={version.wildcardSetId}
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
                  {isModelUnpublished || isVersionUnpublished
                    ? 'Republish this version'
                    : 'Publish this version'}
                </Button>
                {/*
                  Hide the Schedule control once a model/version has been
                  unpublished. The publish raw SQL guard
                  (`publishedAt IS NULL OR publishedAt > NOW()`) restores
                  the original publishedAt on republish, so any picked
                  schedule date would silently be ignored — letting the
                  user open a date picker that has no effect would be
                  misleading. Same write-once-on-republish invariant we
                  now enforce for Post.publishedAt via updatePost.
                */}
                {!isModelUnpublished && !isVersionUnpublished && (
                  <Tooltip
                    label={scheduledPublishDate ? 'Reschedule' : 'Schedule publish'}
                    withArrow
                  >
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
                )}
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
              <ModelVersionSaleBanner
                sale={saleForViewer}
                isOwner={isOwner}
                isModerator={!!user?.isModerator}
              />
              {downloadSection}
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
              {features.batchPostScheduling &&
                isOwner &&
                !deleted &&
                !model.mode &&
                model.status === ModelStatus.Published &&
                version.status === ModelStatus.Published && (
                  <Tooltip
                    label="Upload a set of images once and schedule them as posts over days or weeks, each attributed to this version."
                    multiline
                    w={280}
                    withArrow
                  >
                    <Button
                      component={Link}
                      href={`/posts/batch?modelId=${model.id}&modelVersionId=${version.id}`}
                      variant="light"
                      fullWidth
                      leftSection={<IconCalendarPlus size={16} />}
                    >
                      Promote this model
                    </Button>
                  </Tooltip>
                )}
              {/* Primary Actions Card */}
              <Card withBorder p="md">
                <Stack gap="xs">
                  {canGenerate ? (
                    <div className="relative flex w-full">
                      <GenerateButton
                        versionId={version.id}
                        modelId={model.id}
                        wildcardSetId={version.wildcardSetId}
                        data-tour="model:create"
                        data-activity="create:model"
                        disabled={isLoadingAccess || !!model.mode}
                        generationPrice={
                          generationRequiresPurchase && !isLoadingAccess && displayTerms
                            ? generationPrice(displayTerms)
                            : undefined
                        }
                        listedPrice={
                          !generationRequiresPurchase && isOwnerOrMod && displayTerms
                            ? generationPrice(displayTerms) || undefined
                            : undefined
                        }
                        acceptsBlueBuzz={paidAccessAcceptsBlue}
                        onPurchase={() => onPurchase('generation')}
                        fullWidth
                      />
                      {features.imageGeneration && (
                        <LoadedCornerBadge readiness={generatorReadiness(version)} />
                      )}
                    </div>
                  ) : null}
                  {/* Action icon buttons row */}
                  <div className="flex gap-2">
                    <ActionTooltip ds={ds} label="Share">
                      <div className="flex-1">
                        <ShareButton
                          url={router.asPath}
                          title={model.name}
                          collect={{ modelId: model.id, type: CollectionType.Model }}
                        >
                          <ActionButton ds={ds} color="gray" aria-label="Share">
                            <IconShare3 size={18} />
                          </ActionButton>
                        </ShareButton>
                      </div>
                    </ActionTooltip>
                    {onFavoriteClick && (
                      <ActionTooltip ds={ds} label={isFavorite ? 'Unlike' : 'Like'}>
                        <div className="flex-1" data-tour="model:like">
                          <LoginRedirect reason="favorite-model">
                            <ActionButton
                              ds={ds}
                              onClick={() =>
                                onFavoriteClick({
                                  versionId: version.id,
                                  setTo: !isFavorite,
                                })
                              }
                              color={isFavorite ? 'green' : 'gray'}
                              aria-label={isFavorite ? 'Unlike' : 'Like'}
                            >
                              <ThumbsUpIcon color="#fff" filled={isFavorite} size={18} />
                            </ActionButton>
                          </LoginRedirect>
                        </div>
                      </ActionTooltip>
                    )}
                    {hasDownloadPermissions && !downloadsDisabled && !isPrivateModel && (
                      <ToggleVaultButton modelVersionId={version.id}>
                        {({ isLoading, isInVault, toggleVaultItem }) => (
                          <ActionTooltip
                            ds={ds}
                            label={isInVault ? 'Remove from Vault' : 'Add To Vault'}
                            className="flex-1"
                          >
                            <ActionButton
                              ds={ds}
                              className="flex-1"
                              color={isInVault ? 'green' : 'gray'}
                              onClick={toggleVaultItem}
                              disabled={isLoading}
                              light={isInVault}
                              aria-label={isInVault ? 'Remove from Vault' : 'Add to Vault'}
                            >
                              {isLoading ? (
                                <Loader size="xs" />
                              ) : isInVault ? (
                                <IconCloudCheck size={18} />
                              ) : (
                                <IconCloudLock size={18} />
                              )}
                            </ActionButton>
                          </ActionTooltip>
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
                              className="flex-1"
                              color={color}
                              onClick={onClick}
                              disabled={!primaryFile}
                              variant="light"
                              fullWidth
                              style={{ paddingLeft: 0, paddingRight: 0 }}
                              aria-label={label}
                            >
                              {icon}
                            </Button>
                          </Tooltip>
                        )}
                      </CivitaiLinkManageButton>
                    )}
                    <ActionTooltip
                      ds={ds}
                      label={
                        isNotificationOn
                          ? 'Stop getting notifications for this model'
                          : 'Get notifications for this model'
                      }
                    >
                      <div className="flex-1">
                        <LoginRedirect reason="notify-model">
                          <ActionButton
                            ds={ds}
                            color={isNotificationOn ? 'green' : 'gray'}
                            onClick={() => {
                              // F1: block the toggle until Notify/Mute membership is
                              // known — a cold store reads not-engaged and would fire
                              // the OPPOSITE of the user's intent.
                              if (!isNotifyKnown) return;
                              // Carry an EXPLICIT direction (setTo) — never a blind
                              // server toggle. on→OFF (set Mute, overrides a
                              // follow-based auto-watch); off→ON (set Notify). With
                              // setTo the server sets the row to exactly this state, so
                              // a click acting on a fabricated/errored "off" for a
                              // genuinely-ON model can no longer silently DELETE the
                              // Notify — it's an idempotent subscribe, and the
                              // optimistic write matches the guaranteed server outcome.
                              toggleNotifyModelMutation.mutate({
                                modelId: model.id,
                                type: isNotificationOn
                                  ? ModelEngagementType.Mute
                                  : ModelEngagementType.Notify,
                                setTo: true,
                              });
                            }}
                            loading={toggleNotifyModelMutation.isPending || !isNotifyKnown}
                            aria-label={
                              isNotificationOn
                                ? 'Stop getting notifications for this model'
                                : 'Get notifications for this model'
                            }
                          >
                            {isNotificationOn ? (
                              <IconBellCheck size={18} />
                            ) : (
                              <IconBellPlus size={18} />
                            )}
                          </ActionButton>
                        </LoginRedirect>
                      </div>
                    </ActionTooltip>
                    <ActionTooltip ds={ds} label="Add to collection">
                      <div className="flex-1">
                        <LoginRedirect reason="add-to-collection">
                          <ActionButton
                            ds={ds}
                            color="gray"
                            onClick={() =>
                              openAddToCollectionModal({
                                props: {
                                  modelId: model.id,
                                  type: CollectionType.Model,
                                },
                              })
                            }
                            aria-label="Add to collection"
                          >
                            <IconBookmark size={18} />
                          </ActionButton>
                        </LoginRedirect>
                      </div>
                    </ActionTooltip>
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
                        divProps={{ className: 'flex-1' }}
                      />
                    )}
                    {(!user || !isOwner || user.isModerator) && (
                      <ActionTooltip ds={ds} label="Report">
                        <div className="flex-1">
                          <LoginRedirect reason="report-model">
                            <ActionButton
                              ds={ds}
                              color="gray"
                              onClick={() =>
                                openReportModal({
                                  entityType: ReportEntity.Model,
                                  entityId: model.id,
                                })
                              }
                              aria-label="Report"
                            >
                              <IconFlag size={18} />
                            </ActionButton>
                          </LoginRedirect>
                        </div>
                      </ActionTooltip>
                    )}
                    <LockReviewActionButton ds={ds} model={model} />
                  </div>
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
              <ModelVersionSaleBanner
                sale={saleForViewer}
                isOwner={isOwner}
                isModerator={!!user?.isModerator}
              />
              {downloadSection}
            </Stack>
          )}
          {/* Outside the branch ternary on purpose: `publish-pending` is the branch a
              moderator reviewing an unpublished or draft model lands in. */}
          {user?.isModerator && (
            <ModelModerationCard modelId={model.id} versionFlags={version.flags} />
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

          {version.status === ModelStatus.UnpublishedViolation && !underReview && (
            <ModelUnpublishedAlert
              reason={version.meta?.unpublishedReason}
              customMessage={version.meta?.customMessage}
              // Moderators see this alert too, and only the owner can appeal. The form's Model appeal
              // is for a removed model; a version removed on its own is Other.
              appealHref={
                isOwner
                  ? siteAppealHref(
                      features.siteAppealForm,
                      model.status === ModelStatus.UnpublishedViolation
                        ? { category: AppealCategory.Model, id: model.id }
                        : { category: AppealCategory.Other }
                    )
                  : undefined
              }
            />
          )}
          {isPrivateModel && isOwnerOrMod && (
            <AlertWithIcon
              color="yellow"
              iconColor="yellow"
              icon={<IconLock />}
              title="Private Model"
            >
              {!violation ? (
                <Text>
                  Want to start earning Buzz?{' '}
                  <Anchor onClick={handlePublishPrivateModel}>Publish this model</Anchor>
                </Text>
              ) : underReview ? (
                <Text>
                  This model is private and is currently being reviewed by our moderators.
                </Text>
              ) : (
                <Text>This model is private and has been unpublished due to a violation.</Text>
              )}
            </AlertWithIcon>
          )}
          {version.status === ModelStatus.UnpublishedViolation && underReview && (
            <AlertWithIcon color="yellow" iconColor="yellow" icon={<IconExclamationMark />}>
              This version is currently being reviewed by our moderators. It will be visible to the
              community once it has been approved.
            </AlertWithIcon>
          )}
          <EarlyAccessAlert
            modelId={model.id}
            versionId={version.id}
            modelType={model.type}
            deadline={paidAccessEndsAt ?? undefined}
          />
          <ModelFileAlert
            versionId={version.id}
            modelType={model.type}
            files={version.files}
            baseModel={version.baseModel}
            usageControl={version.usageControl}
          />
          <BaseModelWarningAlert baseModel={version.baseModel} />

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
              <Accordion.Item value="collection-showcase" className="group">
                {/* The follow/edit action sits BESIDE the control, not inside it: the control is a
                    <button>, so nesting one there is invalid DOM and React drops the inner button's
                    events on some paths. The expanded underline moves with it, keyed off the item's
                    own data-active so it still spans the full row. */}
                <div className="flex items-center group-data-[active]:border-b group-data-[active]:border-solid group-data-[active]:border-gray-2 dark:group-data-[active]:border-dark-4">
                  <Accordion.Control disabled={settingShowcase} className="flex-1">
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
                  </Accordion.Control>
                  <div className="pr-3">
                    {isOwnerOrMod ? (
                      <Anchor
                        size="sm"
                        className={clsx(
                          settingShowcase && 'pointer-events-none cursor-not-allowed text-dark-2'
                        )}
                        onClick={() => {
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
                </div>
                <Accordion.Panel>
                  {/* Collapsed by default, so deferring the body moves nothing on first paint. */}
                  {!deferBelowFold && (
                    <CollectionShowcase modelId={model.id} loading={settingShowcase} />
                  )}
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
                    !hasDownloadPermissions && !isLoadingAccess && paidAccessTerms?.download
                      ? paidAccessTerms.download.price
                      : undefined
                  }
                  acceptsBlueBuzz={paidAccessAcceptsBlue}
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
                          <div
                            key={`lc-${lc.recommendedResourceId ?? lc.fileId}`}
                            className={classes.fileRow}
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
                                      href={getModelUrl({
                                        modelId: lc.modelId,
                                        modelName: lc.modelName,
                                      })}
                                      size="sm"
                                      fw={500}
                                      td="underline"
                                      style={styleDottedUnderline}
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
                              <Group gap="xs" wrap="nowrap" style={styleFlexShrink0}>
                                {lc.sizeKB ? (
                                  <Text size="xs" c="dimmed" style={styleNowrap}>
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
                                    aria-label={
                                      canDownload
                                        ? 'Download from source model'
                                        : 'Purchase to download'
                                    }
                                  >
                                    <IconDownload size={16} />
                                  </ActionIcon>
                                </Tooltip>
                              </Group>
                            </Group>
                          </div>
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
                          <div key={file.id} className={classes.fileRow}>
                            <Group justify="space-between" wrap="nowrap">
                              <Group gap="sm" wrap="nowrap">
                                <ThemeIcon
                                  size={36}
                                  radius="md"
                                  color="gray"
                                  variant="light"
                                  style={styleOpacity06}
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
                          </div>
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
                <PageStack ds={ds} gap={0} className={classes.detailsPanel}>
                  {/* Type */}
                  <div className={classes.detailRow}>
                    <span className={classes.detailLabel}>Type</span>
                    <PageGroup ds={ds} gap={6}>
                      <ModelBadge ds={ds} size="sm" radius="xl" variant="filled" color="gray">
                        {getDisplayName(model.type)} {model.checkpointType}
                      </ModelBadge>
                      {version.status !== ModelStatus.Published ? (
                        <ModelBadge ds={ds} size="sm" radius="xl" color="yellow" variant="light">
                          {version.status}
                        </ModelBadge>
                      ) : (
                        <HowToUseModel type={model.type} />
                      )}
                    </PageGroup>
                  </div>
                  {/* Stats */}
                  <div className={classes.detailRow}>
                    <span className={classes.detailLabel}>Stats</span>
                    <PageGroup ds={ds} gap={12}>
                      {!downloadsDisabled && (
                        <PageGroup ds={ds} gap={4}>
                          <IconDownload size={16} style={styleIconOpacity} />
                          <PageText ds={ds} size="sm">
                            {version.hiddenMetrics?.downloads ? (
                              <HiddenMetricNotice size={16} />
                            ) : (
                              <AnimatedCount
                                value={liveMetrics.downloadCount}
                                abbreviate={false}
                                resetKey={version.id}
                              />
                            )}
                          </PageText>
                        </PageGroup>
                      )}
                      {(canGenerate || version.hiddenMetrics?.generations) && (
                        <PageGroup ds={ds} gap={4}>
                          <IconBrush size={16} style={styleIconOpacity} />
                          <PageText ds={ds} size="sm">
                            {version.hiddenMetrics?.generations ? (
                              <HiddenMetricNotice size={16} />
                            ) : (
                              <AnimatedCount
                                value={liveMetrics.generationCount}
                                resetKey={version.id}
                              />
                            )}
                          </PageText>
                        </PageGroup>
                      )}
                      {(!!liveMetrics.earnedAmount || version.hiddenMetrics?.buzz) && (
                        <PageGroup ds={ds} gap={4}>
                          <IconBolt size={16} style={styleIconOpacity} />
                          <PageText ds={ds} size="sm">
                            {version.hiddenMetrics?.buzz ? (
                              <HiddenMetricNotice size={16} />
                            ) : (
                              <AnimatedCount
                                value={liveMetrics.earnedAmount}
                                resetKey={version.id}
                              />
                            )}
                          </PageText>
                        </PageGroup>
                      )}
                    </PageGroup>
                  </div>
                  {/* Generation License Fee */}
                  {Number(version.licensingFee ?? 0) > 0 && (
                    <div className={classes.detailRow}>
                      <span className={classes.detailLabel}>Generation License Fee</span>
                      <Group gap={4} wrap="nowrap">
                        <CurrencyIcon currency="BUZZ" size={16} />
                        <Text size="sm">
                          {formatLicensingFee(Number(version.licensingFee), version.baseModel)}
                        </Text>
                        <Popover
                          width={260}
                          shadow="md"
                          withArrow
                          position="top"
                          opened={feeInfoOpened}
                          onChange={feeInfoHandlers.close}
                        >
                          <Popover.Target>
                            <ActionIcon
                              size="xs"
                              variant="subtle"
                              color="gray"
                              onClick={feeInfoHandlers.toggle}
                              aria-label="License fee info"
                            >
                              <IconInfoSquareRounded size={18} />
                            </ActionIcon>
                          </Popover.Target>
                          <Popover.Dropdown>
                            <Text size="xs">
                              The creator has issued a license fee. This amount is added on top of
                              the standard generation cost for each image generated on Civitai with
                              this resource.
                            </Text>
                          </Popover.Dropdown>
                        </Popover>
                      </Group>
                    </div>
                  )}
                  {/* Reviews */}
                  <div className={classes.detailRow}>
                    <span className={classes.detailLabel}>Reviews</span>
                    <ModelVersionReview
                      modelId={model.id}
                      versionId={version.id}
                      thumbsUpCount={liveMetrics.thumbsUpCount}
                      thumbsDownCount={liveMetrics.thumbsDownCount}
                    />
                  </div>
                  {/* Published */}
                  <div className={classes.detailRow}>
                    <span className={classes.detailLabel}>
                      {version.status === 'Published' && version.publishedAt
                        ? 'Published'
                        : 'Uploaded'}
                    </span>
                    <PageText ds={ds} size="sm">
                      {formatDate(
                        version.status === 'Published' && version.publishedAt
                          ? version.publishedAt
                          : version.createdAt
                      )}
                    </PageText>
                  </div>
                  {/* Base Model */}
                  <div className={classes.detailRow}>
                    <span className={classes.detailLabel}>Base Model</span>
                    <PageGroup ds={ds} gap={6} nowrap>
                      <PageText ds={ds} size="sm">
                        {ecosystemSeoPage ? (
                          <Anchor
                            component={Link}
                            href={`/ecosystems/${ecosystemSeoPage.slug}`}
                            inherit
                          >
                            {version.baseModel}
                          </Anchor>
                        ) : (
                          version.baseModel
                        )}{' '}
                        {version.baseModelType && version.baseModelType !== 'Standard'
                          ? version.baseModelType
                          : ''}
                      </PageText>
                      <SfwOnlyBadge baseModel={version.baseModel} />
                    </PageGroup>
                  </div>
                  {/* Training */}
                  {(!!version.steps || !!version.epochs) && (
                    <div className={classes.detailRow}>
                      <span className={classes.detailLabel}>Training</span>
                      <PageGroup ds={ds} gap={4}>
                        {!!version.steps && (
                          <ModelBadge ds={ds} size="sm" radius="sm" color="teal">
                            Steps: {version.steps.toLocaleString()}
                          </ModelBadge>
                        )}
                        {!!version.epochs && (
                          <ModelBadge ds={ds} size="sm" radius="sm" color="teal">
                            Epochs: {version.epochs.toLocaleString()}
                          </ModelBadge>
                        )}
                      </PageGroup>
                    </div>
                  )}
                  {/* Usage Tips */}
                  {(isDefined(version.clipSkip) || isDefined(version.settings?.strength)) && (
                    <div className={classes.detailRow}>
                      <span className={classes.detailLabel}>Usage Tips</span>
                      <PageGroup ds={ds} gap={4}>
                        {isDefined(version.clipSkip) && (
                          <ModelBadge ds={ds} size="sm" radius="sm" color="cyan">
                            Clip Skip: {version.clipSkip}
                          </ModelBadge>
                        )}
                        {isDefined(version.settings?.strength) && (
                          <ModelBadge ds={ds} size="sm" radius="sm" color="cyan">
                            {`Strength: ${version.settings.strength}`}
                          </ModelBadge>
                        )}
                      </PageGroup>
                    </div>
                  )}
                  {/* Hash */}
                  {!!hashes.length && (
                    <div className={classes.detailRowPlain}>
                      <span className={classes.detailLabel}>Hash</span>
                      <ModelHash hashes={hashes} ds={ds} />
                    </div>
                  )}
                  {/* Trigger Words */}
                  {!!version.trainedWords?.length && (
                    <div className={classes.detailRowTop}>
                      <span className={classes.detailLabel}>Trigger Words</span>
                      <TrainedWords
                        trainedWords={version.trainedWords}
                        files={version.files}
                        type={model.type}
                        ds={ds}
                      />
                    </div>
                  )}
                  {/* AIR */}
                  {features.air && (
                    <div className={classes.detailRowTop}>
                      <PageGroup ds={ds} gap="xs">
                        <span className={classes.detailLabel}>AIR</span>
                        <URNExplanation size={16} />
                      </PageGroup>
                      <ModelURN
                        baseModel={version.baseModel}
                        type={model.type}
                        modelId={model.id}
                        modelVersionId={version.id}
                        fileId={activeFile?.id}
                        fileType={activeFile?.type}
                        ds={ds}
                      />
                    </div>
                  )}
                </PageStack>
              </Accordion.Panel>
            </Accordion.Item>
            {isDownloadable && modelFilesVisible.length > 0 && (
              <ModelTensorMetadata
                files={modelFilesVisible}
                userPreferences={user?.filePreferences}
                enabled={tensorMetadataEnabled}
                selectedFileId={selectedFileId}
              />
            )}
            {version.recommendedResources && version.recommendedResources.length > 0 && (
              <Accordion.Item value="recommended-resources">
                <Accordion.Control>Recommended Resources</Accordion.Control>
                <Accordion.Panel>
                  <Stack gap={2}>
                    {version.recommendedResources.map((resource) => (
                      <Card
                        key={resource.id}
                        component={Link}
                        href={getModelUrl({
                          modelId: resource.model.id,
                          modelName: resource.model.name,
                          modelVersionId: resource.id,
                        })}
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

          <ModelVersionDonationGoal modelVersionId={version.id} modelVersion={permissionData} />

          {deferBelowFold ? (
            <div data-deferred-section="creator-card" className={classes.deferredCreatorCard} />
          ) : (
            <SmartCreatorCard
              user={model.user}
              tipBuzzEntityType="Model"
              tipBuzzEntityId={model.id}
              tipsEnabled={!model.poi}
            />
          )}
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

          {deferBelowFold ? (
            <div data-deferred-section="license" className={classes.deferredLicense} />
          ) : (
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              {(model.type === 'Checkpoint' || !!license || model.licenses.length > 0) && (
                <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                  <BaseModelLicense license={license} plural={model.licenses.length > 0}>
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
                  </BaseModelLicense>
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
              <PermissionIndicator
                permissions={{
                  ...model,
                  // Permissions are derived per displayed version from its base model:
                  // non-commercial base models (e.g. Ideogram) force commercial use off,
                  // mature-restricted base models force SFW-only generation, and
                  // same-license base models (e.g. LTXV 2.5) force merges to match.
                  allowCommercialUse: getEffectiveCommercialUse(
                    model.allowCommercialUse,
                    version.baseModel
                  ),
                  sfwOnly: model.sfwOnly || baseModelRestrictsMature,
                  allowDifferentLicense: getEffectiveDifferentLicense(
                    model.allowDifferentLicense,
                    version.baseModel
                  ),
                }}
                ml="auto"
              />
            </Group>
          )}
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
      </VersionDetailsCol>

      <VersionDetailsCol ds={ds} side="main" className={classes.mainSection}>
        <Stack>
          {model.mode !== ModelModifier.TakenDown && !mobile && (
            <ModelCarousel
              modelId={model.id}
              modelVersionId={version.id}
              modelUserId={model.user.id}
              limit={CAROUSEL_LIMIT}
              minor={model.minor}
            />
          )}
          {model.description ? (
            <ContentClamp maxHeight={460}>
              <RenderHtml html={model.description} />
            </ContentClamp>
          ) : null}
        </Stack>
      </VersionDetailsCol>
    </VersionDetailsGrid>
  );
}

type Props = {
  version: ModelById['modelVersions'][number];
  model: ModelById;
  image: ImagesInfiniteModel | undefined;
  onFavoriteClick?: (ctx: { versionId?: number; setTo: boolean }) => void;
  /** `@civitai/components` markup in place of Mantine (`modelPageDesignSystemMarkup`). */
  ds?: boolean;
};

function VersionDescriptionModal({ description }: { description: string }) {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} title="About this version" size="lg" centered>
      <RenderHtml html={description} />
    </Modal>
  );
}

function LockReviewActionButton({ ds, model }: { ds: boolean; model: ModelById }) {
  const action = useLockReviewAction(model);
  if (!action.show) return null;

  return (
    <ActionTooltip ds={ds} label={action.tooltip ?? action.label}>
      <div className="flex-1">
        <ActionButton
          ds={ds}
          color="gray"
          disabled={action.disabled}
          onClick={action.open}
          aria-label={action.label}
        >
          <IconLock size={18} />
        </ActionButton>
      </div>
    </ActionTooltip>
  );
}

function ActionTooltip({
  ds,
  label,
  className,
  children,
}: {
  ds: boolean;
  label: string;
  /** ON only: the design-system wrapper is the row's flex item, so it carries the item's class. */
  className?: string;
  children: React.ReactElement;
}) {
  if (ds)
    return (
      <DsTooltip label={label} className={className ?? 'flex-1'}>
        {children}
      </DsTooltip>
    );
  return (
    <Tooltip label={label} position="top" withArrow>
      {children}
    </Tooltip>
  );
}

type ActionButtonProps = {
  ds: boolean;
  color: 'gray' | 'green';
  light?: boolean;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  'aria-label': string;
  children: React.ReactNode;
};

/**
 * A full-width icon button in the action row. A loading or disabled one stays a Mantine `Button`
 * whatever the flag says: the design-system markup has no loader overlay or disabled colours.
 */
const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  { ds, color, light, loading, disabled, ...rest },
  ref
) {
  if (ds && !loading && !disabled)
    return (
      <ShellButton
        ref={ref}
        variant={
          light
            ? color === 'green'
              ? 'light-green'
              : 'light-gray'
            : color === 'green'
            ? 'filled-green'
            : 'filled-gray'
        }
        fullWidth
        style={{ paddingLeft: 0, paddingRight: 0 }}
        {...rest}
      />
    );
  return (
    <Button
      ref={ref}
      color={color}
      variant={light ? 'light' : undefined}
      loading={loading}
      disabled={disabled}
      fullWidth
      style={{ paddingLeft: 0, paddingRight: 0 }}
      {...rest}
    />
  );
});
