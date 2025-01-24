import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Center,
  createStyles,
  Group,
  Loader,
  MantineTheme,
  Menu,
  Modal,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import {
  IconBrush,
  IconClock,
  IconCloudCheck,
  IconCloudLock,
  IconDownload,
  IconExclamationMark,
  IconHeart,
  IconLicense,
  IconLock,
  IconMessageCircle2,
  IconPhotoPlus,
  IconShare3,
} from '@tabler/icons-react';
import { TRPCClientErrorBase } from '@trpc/client';
import { DefaultErrorShape } from '@trpc/server';
import dayjs from 'dayjs';
import { startCase } from 'lodash-es';
import { useRouter } from 'next/router';
import { useCallback, useRef, useState } from 'react';
import { AdUnitSide_2 } from '~/components/Ads/AdUnit';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import { useCivitaiLink } from '~/components/CivitaiLink/CivitaiLinkProvider';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import {
  DescriptionTable,
  type Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import {
  openCollectionSelectModal,
  openResourceReviewEditModal,
} from '~/components/Dialog/dialog-registry';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { FileInfo } from '~/components/FileInfo/FileInfo';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { CollectionShowcase } from '~/components/Model/CollectionShowcase/CollectionShowcase';
import { EarlyAccessAlert } from '~/components/Model/EarlyAccessAlert/EarlyAccessAlert';
import { HowToButton, HowToUseModel } from '~/components/Model/HowToUseModel/HowToUseModel';
import { useModelShowcaseCollection } from '~/components/Model/model.utils';
import { ModelCarousel } from '~/components/Model/ModelCarousel/ModelCarousel';
import { ModelFileAlert } from '~/components/Model/ModelFileAlert/ModelFileAlert';
import { ModelHash } from '~/components/Model/ModelHash/ModelHash';
import { ModelURN, URNExplanation } from '~/components/Model/ModelURN/ModelURN';
import { DownloadButton } from '~/components/Model/ModelVersions/DownloadButton';
import {
  useModelVersionPermission,
  useQueryModelVersionsEngagement,
} from '~/components/Model/ModelVersions/model-version.utils';
import ModelVersionDonationGoals from '~/components/Model/ModelVersions/ModelVersionDonationGoals';
import { ModelVersionEarlyAccessPurchase } from '~/components/Model/ModelVersions/ModelVersionEarlyAccessPurchase';
import { ModelVersionReview } from '~/components/Model/ModelVersions/ModelVersionReview';
import { ScheduleModal } from '~/components/Model/ScheduleModal/ScheduleModal';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PermissionIndicator } from '~/components/PermissionIndicator/PermissionIndicator';
import { PoiAlert } from '~/components/PoiAlert/PoiAlert';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import {
  EditUserResourceReviewLight,
  UserResourceReviewComposite,
} from '~/components/ResourceReview/EditUserResourceReview';
import { useQueryUserResourceReview } from '~/components/ResourceReview/resourceReview.utils';
import { ResourceReviewThumbActions } from '~/components/ResourceReview/ResourceReviewThumbActions';
import { GenerateButton } from '~/components/RunStrategy/GenerateButton';
import { RunButton } from '~/components/RunStrategy/RunButton';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { IconCivitai } from '~/components/SVG/IconCivitai';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { TrackView } from '~/components/TrackView/TrackView';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { ToggleVaultButton } from '~/components/Vault/ToggleVaultButton';
import { VerifiedText } from '~/components/VerifiedText/VerifiedText';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  baseModelLicenses,
  CAROUSEL_LIMIT,
  constants,
  ModelFileType,
} from '~/server/common/constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { unpublishReasons } from '~/server/common/moderation-helpers';
import { getFileDisplayName, getPrimaryFile } from '~/server/utils/model-helpers';
import {
  CollectionType,
  ModelFileVisibility,
  ModelModifier,
  ModelStatus,
  ModelUsageControl,
} from '~/shared/utils/prisma/enums';
import { ModelById } from '~/types/router';
import { formatDate, formatDateMin } from '~/utils/date-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { formatKBytes } from '~/utils/number-helpers';
import { getDisplayName, removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles(() => ({
  ctaContainer: {
    width: '100%',
    flexWrap: 'wrap',
    ['> *']: { flexGrow: 1 },

    [containerQuery.largerThan('sm')]: {
      ['> *']: { flexGrow: 0 },
    },
  },
}));

export function ModelVersionDetails({ model, version, onBrowseClick, onFavoriteClick }: Props) {
  const user = useCurrentUser();
  const { classes, cx } = useStyles();
  const { connected: civitaiLinked } = useCivitaiLink();
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const features = useFeatureFlags();
  // TODO.manuel: use control ref to display the show more button
  const controlRef = useRef<HTMLButtonElement | null>(null);
  const [scheduleModalOpened, setScheduleModalOpened] = useState(false);
  const [detailAccordions, setDetailAccordions] = useLocalStorage({
    key: 'model-version-details-accordions',
    defaultValue: ['version-details'],
  });
  const adContainerRef = useRef<HTMLDialogElement | null>(null);

  const {
    isLoadingAccess,
    isDownloadable,
    isSelectableInGenerator,
    canDownload: hasDownloadPermissions,
    canGenerate: hasGeneratePermissions,
  } = useModelVersionPermission({
    modelVersionId: version.id,
  });

  // We'll use this flag mainly to let the owner know of the status, but the `isDownloadable` flag determines whether this user can download or not.
  const downloadsDisabled =
    !!version?.usageControl && version?.usageControl !== ModelUsageControl.Download;

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
  const filesVisible = version.files?.filter(
    (f) => f.visibility === ModelFileVisibility.Public || isOwnerOrMod
  );
  const filesVisibleCount = filesVisible.length;
  const hasVisibleFiles = filesVisibleCount > 0;

  const displayCivitaiLink =
    civitaiLinked && !!version.hashes && version.hashes?.length > 0 && hasDownloadPermissions;
  const hasPendingClaimReport = model.reportStats && model.reportStats.ownershipProcessing > 0;

  const isEarlyAccess = !!version?.earlyAccessEndsAt && version.earlyAccessEndsAt > new Date();
  const earlyAccessConfig = version?.earlyAccessConfig;
  const canGenerate =
    isSelectableInGenerator &&
    features.imageGeneration &&
    version.canGenerate &&
    (!isEarlyAccess || !!earlyAccessConfig?.chargeForGeneration || hasGeneratePermissions);
  const publishVersionMutation = trpc.modelVersion.publish.useMutation();
  const publishModelMutation = trpc.model.publish.useMutation();
  const requestReviewMutation = trpc.model.requestReview.useMutation();
  const requestVersionReviewMutation = trpc.modelVersion.requestReview.useMutation();
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
  const getDownloadProps = useCallback(
    (file: { type?: string; metadata?: BasicFileMetadata } | null) => {
      if (isLoadingAccess) {
        return {};
      }

      if (hasDownloadPermissions) {
        if (!file) {
          return;
        }

        const url = createModelFileDownloadUrl({
          versionId: version.id,
          type: file.type,
          meta: file.metadata,
        });

        return {
          // This will allow users to right-click save
          href: url,
        };
      } else {
        return {
          onClick: () => {
            onPurchase('download');
          },
        };
      }
    },
    [isLoadingAccess, hasDownloadPermissions, version.id, router]
  );

  const { currentUserReview } = useQueryUserResourceReview({
    modelId: model.id,
    modelVersionId: version.id,
  });
  const isFavorite = currentUserReview?.recommended;

  const { alreadyDownloaded } = useQueryModelVersionsEngagement({
    modelId: model.id,
    versionId: version.id,
  });

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
    } catch (e) {
      const error = e as TRPCClientErrorBase<DefaultErrorShape>;
      const reason = error?.message?.includes('Insufficient funds')
        ? 'You do not have enough funds to publish this model. You can remove early access or purchase more buzz in order to publish.'
        : 'Something went wrong while publishing your model. Please try again later.';

      showErrorNotification({
        error: new Error(error.message),
        title: 'Error publishing model',
        reason,
      });
    }

    await queryUtils.model.getById.invalidate({ id: model.id });
    await queryUtils.modelVersion.getById.invalidate({ id: version.id });
    await queryUtils.image.getInfinite.invalidate();
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

  const modelDetails: DescriptionTableProps['items'] = [
    {
      label: 'Type',
      value: (
        <Group spacing={0} noWrap position="apart">
          <Badge radius="sm" px={5}>
            {getDisplayName(model.type)} {model.checkpointType}
          </Badge>
          {version.status !== ModelStatus.Published ? (
            <Badge color="yellow" radius="sm">
              {version.status}
            </Badge>
          ) : (
            <HowToUseModel type={model.type} />
          )}
        </Group>
      ),
    },
    {
      label: 'Stats',
      value: (
        <Group spacing={4}>
          {!downloadsDisabled && (
            <IconBadge radius="xs" icon={<IconDownload size={14} />}>
              <Text>{(version.rank?.downloadCountAllTime ?? 0).toLocaleString()}</Text>
            </IconBadge>
          )}
          {version.canGenerate && (
            <GenerateButton
              modelVersionId={version.id}
              data-activity="create:version-stat"
              disabled={isLoadingAccess}
              generationPrice={
                !hasGeneratePermissions &&
                !isLoadingAccess &&
                earlyAccessConfig?.chargeForGeneration
                  ? earlyAccessConfig?.generationPrice
                  : undefined
              }
              onPurchase={() => onPurchase('generation')}
            >
              <IconBadge radius="xs" icon={<IconBrush size={14} />}>
                <Text>{(version.rank?.generationCountAllTime ?? 0).toLocaleString()}</Text>
              </IconBadge>
            </GenerateButton>
          )}
        </Group>
      ),
    },
    {
      label: 'Reviews',
      value: (
        <ModelVersionReview
          modelId={model.id}
          versionId={version.id}
          thumbsUpCount={version.rank?.thumbsUpCountAllTime ?? 0}
          thumbsDownCount={version.rank?.thumbsDownCountAllTime ?? 0}
        />
      ),
    },
    version.status === 'Published' && version.publishedAt
      ? { label: 'Published', value: formatDate(version.publishedAt) }
      : { label: 'Uploaded', value: formatDate(version.createdAt) },
    {
      label: 'Base Model',
      value:
        version.baseModel === 'ODOR' ? (
          <Group spacing={8} position="apart" noWrap>
            <Text component={Link} href="/product/odor" target="_blank">
              {version.baseModel}{' '}
            </Text>
            <HowToButton href="https://youtu.be/7j_sakwGK8M" tooltip="What is this?" />
          </Group>
        ) : (
          <Group spacing={8} position="apart" noWrap>
            <Text>
              {version.baseModel}{' '}
              {version.baseModelType && version.baseModelType === 'Standard'
                ? ''
                : version.baseModelType}
            </Text>
            <HowToButton
              href="https://youtu.be/IIy3YwsXtTE?si=YiJDxMODCOTkUUM4&t=417"
              tooltip="What is this?"
            />
          </Group>
        ),
    },
    {
      label: 'Training',
      value: (
        <Group spacing={4}>
          {version.steps && (
            <Badge size="sm" radius="sm" color="teal">
              Steps: {version.steps.toLocaleString()}
            </Badge>
          )}
          {version.epochs && (
            <Badge size="sm" radius="sm" color="teal">
              Epochs: {version.epochs.toLocaleString()}
            </Badge>
          )}
        </Group>
      ),
      visible: !!version.steps || !!version.epochs,
    },
    {
      label: 'Usage Tips',
      value: (
        <Group spacing={4}>
          {version.clipSkip && (
            <Badge size="sm" radius="sm" color="cyan">
              Clip Skip: {version.clipSkip.toLocaleString()}
            </Badge>
          )}
          {!!version.settings?.strength && (
            <Badge size="sm" radius="sm" color="cyan">
              {`Strength: ${version.settings.strength}`}
            </Badge>
          )}
        </Group>
      ),
      visible: !!version.clipSkip || !!version.settings?.strength,
    },
    {
      label: 'Trigger Words',
      visible: !!version.trainedWords?.length,
      value: (
        <TrainedWords trainedWords={version.trainedWords} files={version.files} type={model.type} />
      ),
    },
    {
      label: 'Training Images',
      value: (
        <Text
          variant="link"
          component="a"
          href={`/api/download/training-data/${version.id}`}
          target="_blank"
          download
        >
          Download
        </Text>
      ),
      visible:
        !!filesVisible.find((file) => (file.type as ModelFileType) === 'Training Data') &&
        !archived,
    },
    {
      label: 'Hash',
      value: <ModelHash hashes={hashes} />,
      visible: !!hashes.length,
    },
    {
      label: (
        <Group spacing="xs">
          <Text weight={500}>AIR</Text>
          <URNExplanation size={20} />
        </Group>
      ),
      value: (
        <ModelURN
          baseModel={version.baseModel}
          type={model.type}
          modelId={model.id}
          modelVersionId={version.id}
        />
      ),
      visible: features.air,
    },
    {
      label: (
        <Group spacing="xs">
          <Text weight={500}>Bounty</Text>
        </Group>
      ),
      value: (
        <Text variant="link" component="a" href={`/bounties/${model.meta?.bountyId as number}`}>
          Go to bounty
        </Text>
      ),
      visible: !!model.meta?.bountyId,
    },
  ];

  const getFileDetails = (file: ModelById['modelVersions'][number]['files'][number]) => (
    <Group position="apart" noWrap spacing={0}>
      <VerifiedText file={file} />
      <Group spacing={4}>
        <Text size="xs" color="dimmed">
          {file.type === 'Pruned Model' ? 'Pruned ' : ''}
          {file.metadata.format}
        </Text>
        <FileInfo file={file} />
      </Group>
    </Group>
  );
  const primaryFileDetails = primaryFile && getFileDetails(primaryFile);

  const downloadMenuItems = filesVisible.map((file) =>
    !archived ? (
      <Menu.Item
        key={file.id}
        component="a"
        py={4}
        icon={<VerifiedText file={file} iconOnly />}
        {...getDownloadProps(file)}
      >
        {getFileDisplayName({ file, modelType: model.type })} ({formatKBytes(file.sizeKB)}){' '}
        {file.visibility !== 'Public' && (
          <Tooltip label="Only visible to you" position="top" withArrow>
            <ThemeIcon color="blue" size="xs" sx={{ alignSelf: 'center' }} ml="xs">
              <IconLock />
            </ThemeIcon>
          </Tooltip>
        )}
      </Menu.Item>
    ) : (
      <Menu.Item key={file.id} py={4} icon={<VerifiedText file={file} iconOnly />} disabled>
        {`${startCase(file.type)}${
          ['Model', 'Pruned Model'].includes(file.type) ? ' ' + file.metadata.format : ''
        } (${formatKBytes(file.sizeKB)})`}
      </Menu.Item>
    )
  );
  const downloadFileItems = filesVisible.map((file) => (
    <Card
      key={file.id}
      radius={0}
      py="xs"
      sx={(theme) => ({
        backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
      })}
    >
      <Stack spacing={4}>
        <Group position="apart" noWrap>
          <Group spacing={4}>
            <Text size="xs" weight={500} lineClamp={2}>
              {getFileDisplayName({ file, modelType: model.type })} ({formatKBytes(file.sizeKB)})
            </Text>
            {file.visibility !== 'Public' ? (
              <Badge size="xs" radius="xl" color="violet">
                {file.visibility}
              </Badge>
            ) : null}
          </Group>
          <Button
            component="a"
            variant="subtle"
            size="xs"
            {...getDownloadProps(file)}
            disabled={archived}
            compact
          >
            Download
          </Button>
        </Group>
        {getFileDetails(file)}
      </Stack>
    </Card>
  ));

  const cleanDescription = version.description ? removeTags(version.description) : '';

  const hasPosts = !!version.posts?.length;
  const showPublishButton =
    isOwnerOrMod &&
    (version.status !== ModelStatus.Published || model.status !== ModelStatus.Published) &&
    hasFiles &&
    hasPosts;
  const scheduledPublishDate =
    version.status === ModelStatus.Scheduled ? version.publishedAt : undefined;
  const publishing = publishModelMutation.isLoading || publishVersionMutation.isLoading;
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
      : `Removal reason: ${version.meta?.customMessage}.`;
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
    <ContainerGrid gutter="xl" gutterSm="sm" gutterMd="xl">
      <TrackView entityId={version.id} entityType="ModelVersion" type="ModelVersionView" />
      <ContainerGrid.Col xs={12} sm={5} md={4} orderSm={2} ref={adContainerRef}>
        <Stack>
          {model.mode !== ModelModifier.TakenDown && (
            <ModelCarousel
              modelId={model.id}
              modelVersionId={version.id}
              modelUserId={model.user.id}
              limit={CAROUSEL_LIMIT}
              mobile
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
            <Stack spacing={4}>
              {version.canGenerate && isOwnerOrMod && (
                <GenerateButton modelVersionId={version.id} data-activity="create:model" py={8} />
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
                    onClick={() => setScheduleModalOpened((current) => !current)}
                  >
                    <IconClock size={20} />
                  </Button>
                </Tooltip>
              </Button.Group>

              {scheduledPublishDate && isOwnerOrMod && (
                <Stack>
                  <Group spacing={4}>
                    <ThemeIcon color="gray" variant="filled" radius="xl">
                      <IconClock size={20} />
                    </ThemeIcon>
                    <Text size="xs" color="dimmed">
                      Scheduled for {dayjs(scheduledPublishDate).format('MMMM D, h:mma')}
                    </Text>
                  </Group>
                </Stack>
              )}
            </Stack>
          ) : (
            <Stack spacing={4}>
              <Group spacing="xs" className={classes.ctaContainer}>
                <Group spacing="xs" sx={{ flex: 1, ['> *']: { flexGrow: 1 } }} noWrap>
                  {canGenerate && (
                    <GenerateButton
                      modelVersionId={version.id}
                      data-activity="create:model"
                      sx={{ flex: '2 !important', paddingLeft: 8, paddingRight: 12 }}
                      disabled={isLoadingAccess || !!model.mode}
                      generationPrice={
                        !hasGeneratePermissions &&
                        !isLoadingAccess &&
                        earlyAccessConfig?.chargeForGeneration
                          ? earlyAccessConfig?.generationPrice
                          : undefined
                      }
                      onPurchase={() => onPurchase('generation')}
                    />
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
                      {({ color, onClick, ref, icon, label }) =>
                        !canGenerate ? (
                          <Button
                            ref={ref}
                            color={color}
                            onClick={onClick}
                            leftIcon={icon}
                            disabled={!primaryFile}
                            sx={{ flex: '2 !important', paddingLeft: 8, paddingRight: 12 }}
                            fullWidth
                          >
                            {label}
                          </Button>
                        ) : (
                          <Tooltip label={label}>
                            <Button
                              ref={ref}
                              color={color}
                              onClick={onClick}
                              disabled={!primaryFile}
                              variant="light"
                              sx={{ flex: 1, paddingLeft: 8, paddingRight: 8 }}
                              fullWidth
                            >
                              {icon}
                            </Button>
                          </Tooltip>
                        )
                      }
                    </CivitaiLinkManageButton>
                  )}
                  {displayCivitaiLink || canGenerate ? (
                    filesCount === 1 ? (
                      <DownloadButton
                        canDownload={canDownload}
                        downloadPrice={
                          !hasDownloadPermissions &&
                          !isLoadingAccess &&
                          earlyAccessConfig?.chargeForDownload
                            ? earlyAccessConfig?.downloadPrice
                            : undefined
                        }
                        component="a"
                        {...getDownloadProps(primaryFile)}
                        tooltip="Download"
                        disabled={!primaryFile || archived || isLoadingAccess}
                        sx={{ flex: 1, paddingLeft: 8, paddingRight: 8 }}
                        iconOnly
                      />
                    ) : (
                      <Menu position="bottom-end">
                        <Menu.Target>
                          <DownloadButton
                            canDownload={canDownload}
                            downloadPrice={
                              !hasDownloadPermissions &&
                              !isLoadingAccess &&
                              earlyAccessConfig?.chargeForDownload
                                ? earlyAccessConfig?.downloadPrice
                                : undefined
                            }
                            disabled={!primaryFile || archived || isLoadingAccess}
                            sx={{ flex: 1, paddingLeft: 8, paddingRight: 8 }}
                            iconOnly
                          />
                        </Menu.Target>
                        <Menu.Dropdown>{downloadMenuItems}</Menu.Dropdown>
                      </Menu>
                    )
                  ) : (
                    <DownloadButton
                      component="a"
                      {...getDownloadProps(primaryFile)}
                      canDownload={canDownload}
                      downloadPrice={
                        !hasDownloadPermissions &&
                        !isLoadingAccess &&
                        earlyAccessConfig?.chargeForDownload
                          ? earlyAccessConfig?.downloadPrice
                          : undefined
                      }
                      disabled={!primaryFile || archived || isLoadingAccess}
                      sx={{ flex: '2 !important', paddingLeft: 8, paddingRight: 12 }}
                    >
                      <Text align="center">
                        {primaryFile ? (
                          <>
                            Download <Text span>{`(${formatKBytes(primaryFile?.sizeKB)})`}</Text>
                          </>
                        ) : !isDownloadable ? (
                          'Download disabled'
                        ) : (
                          'No file'
                        )}
                      </Text>
                    </DownloadButton>
                  )}
                </Group>
                <Group spacing="xs" sx={{ flex: 1, ['> *']: { flexGrow: 1 } }} noWrap>
                  {!displayCivitaiLink && !isEarlyAccess && isDownloadable && (
                    <RunButton
                      variant="light"
                      modelVersionId={version.id}
                      disabled={!!model.mode}
                    />
                  )}
                  <Tooltip label="Share" position="top" withArrow>
                    <div>
                      <ShareButton
                        url={router.asPath}
                        title={model.name}
                        collect={{ modelId: model.id, type: CollectionType.Model }}
                      >
                        <Button sx={{ paddingLeft: 8, paddingRight: 8 }} color="gray" fullWidth>
                          <IconShare3 size={24} />
                        </Button>
                      </ShareButton>
                    </div>
                  </Tooltip>

                  {onFavoriteClick && (
                    <Tooltip label={isFavorite ? 'Unlike' : 'Like'} position="top" withArrow>
                      <div>
                        <LoginRedirect reason="favorite-model">
                          <Button
                            onClick={() =>
                              onFavoriteClick({ versionId: version.id, setTo: !isFavorite })
                            }
                            color={isFavorite ? 'green' : 'gray'}
                            sx={{ paddingLeft: 8, paddingRight: 8 }}
                            fullWidth
                          >
                            <ThumbsUpIcon color="#fff" filled={isFavorite} size={24} />
                          </Button>
                        </LoginRedirect>
                      </div>
                    </Tooltip>
                  )}
                  {hasDownloadPermissions && !downloadsDisabled && (
                    <ToggleVaultButton modelVersionId={version.id}>
                      {({ isLoading, isInVault, toggleVaultItem }) => (
                        <Tooltip
                          label={isInVault ? 'Remove from Vault' : 'Add To Vault'}
                          position="top"
                          withArrow
                        >
                          <Button
                            sx={{ paddingLeft: 8, paddingRight: 8 }}
                            color={isInVault ? 'green' : 'gray'}
                            onClick={toggleVaultItem}
                            disabled={isLoading}
                            variant={isInVault ? 'light' : undefined}
                          >
                            {isLoading ? (
                              <Loader size="xs" />
                            ) : isInVault ? (
                              <IconCloudCheck size={24} />
                            ) : (
                              <IconCloudLock size={24} />
                            )}
                          </Button>
                        </Tooltip>
                      )}
                    </ToggleVaultButton>
                  )}
                </Group>
              </Group>
              {primaryFileDetails}
            </Stack>
          )}
          {version.status === ModelStatus.UnpublishedViolation && !version.meta?.needsReview && (
            <AlertWithIcon color="red" iconColor="red" icon={<IconExclamationMark />}>
              <Text>
                This model has been unpublished due to a violation of our{' '}
                <Text component="a" variant="link" href="/content/tos" target="_blank">
                  guidelines
                </Text>{' '}
                and is not visible to the community.{' '}
                {unpublishedReason && unpublishedMessage ? unpublishedMessage : null}
              </Text>
              <Text>
                If you adjust your model to comply with our guidelines, you can request a review
                from one of our moderators. If you believe this was done in error, you can{' '}
                <Text component="a" variant="link" href="/appeal" target="_blank">
                  submit an appeal
                </Text>
                .
              </Text>
            </AlertWithIcon>
          )}
          {version.status === ModelStatus.UnpublishedViolation && version.meta?.needsReview && (
            <AlertWithIcon color="yellow" iconColor="yellow" icon={<IconExclamationMark />}>
              This version is currently being reviewed by our moderators. It will be visible to the
              community once it has been approved.
            </AlertWithIcon>
          )}
          <ModelVersionDonationGoals modelVersionId={version.id} />
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
          />

          {(!isDownloadable || downloadsDisabled) && (
            <Alert title="Download disabled" color="yellow" icon={<IconDownload />}>
              {isDownloadable ? (
                <Text>
                  As the owner, you can still download this model. Other users will not be able to.
                  Click{' '}
                  <Link href={`/models/${version.modelId}/model-versions/${version.id}/edit`}>
                    here
                  </Link>{' '}
                  to change this behavior
                </Text>
              ) : (
                <Text>
                  The owner of this model has disabled downloads for this model.{' '}
                  {canGenerate &&
                    'You can still generate images using this model in our generator, but will not be able to download the model files.'}
                </Text>
              )}
            </Alert>
          )}

          {!model.locked && alreadyDownloaded && (
            <UserResourceReviewComposite
              modelId={model.id}
              modelVersionId={version.id}
              modelName={model.name}
            >
              {({ modelId, modelVersionId, userReview, loading }) => (
                <Card p={8} withBorder>
                  <Stack spacing={8}>
                    <Group spacing={8} position="apart" noWrap>
                      <Group spacing={8} noWrap>
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
                        <Group noWrap spacing={4}>
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
          <Accordion
            variant="separated"
            multiple
            onChange={setDetailAccordions}
            value={detailAccordions}
            styles={(theme) => ({
              content: { padding: 0 },
              item: {
                overflow: 'hidden',
                borderColor:
                  theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3],
                boxShadow: theme.shadows.sm,
              },
              control: {
                padding: theme.spacing.sm,
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
                        <Anchor variant="text" onClick={(e) => e.stopPropagation()} inherit>
                          {collection.name}
                        </Anchor>
                      </Link>
                      <Text size="xs" color="dimmed">
                        Collection
                        {collection.itemCount > 0
                          ? ` - ${collection.itemCount.toLocaleString()} items`
                          : ''}
                      </Text>
                    </div>
                    {isOwnerOrMod && (
                      <Anchor
                        size="sm"
                        className={cx(
                          settingShowcase && 'text-dark-2 cursor-not-allowed pointer-events-none'
                        )}
                        onClick={(e) => {
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
                    )}
                  </div>
                </Accordion.Control>
                <Accordion.Panel>
                  <CollectionShowcase modelId={model.id} loading={settingShowcase} />
                </Accordion.Panel>
              </Accordion.Item>
            )}
            <Accordion.Item value="version-details">
              <Accordion.Control>
                <Group position="apart">
                  Details
                  {showEditButton && (
                    <Menu withinPortal>
                      <Menu.Target>
                        <Anchor size="sm" onClick={(e) => e.stopPropagation()}>
                          Edit
                        </Anchor>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          component={Link}
                          onClick={(e) => e.stopPropagation()}
                          href={`/models/${version.modelId}/edit`}
                        >
                          Edit Model Details
                        </Menu.Item>
                        <Menu.Item
                          component={Link}
                          onClick={(e) => e.stopPropagation()}
                          href={`/models/${version.modelId}/model-versions/${version.id}/edit`}
                        >
                          Edit Version Details
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  )}
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <DescriptionTable
                  items={modelDetails}
                  labelWidth="30%"
                  withBorder
                  paperProps={{
                    sx: {
                      borderLeft: 0,
                      borderRight: 0,
                      borderBottom: 0,
                    },
                    radius: 0,
                  }}
                />
              </Accordion.Panel>
            </Accordion.Item>
            {isDownloadable && (
              <Accordion.Item
                value="version-files"
                sx={(theme) => ({
                  marginTop: theme.spacing.md,
                  marginBottom: !model.locked ? theme.spacing.md : undefined,
                  borderColor: !filesCount ? `${theme.colors.red[4]} !important` : undefined,
                })}
              >
                <Accordion.Control disabled={archived}>
                  <Group position="apart">
                    {filesVisibleCount > 0
                      ? `${filesVisibleCount === 1 ? '1 File' : `${filesVisibleCount} Files`}`
                      : 'Files'}
                    {isOwnerOrMod && (
                      <RoutedDialogLink name="filesEdit" state={{ modelVersionId: version.id }}>
                        <Text variant="link" size="sm">
                          Manage Files
                        </Text>
                      </RoutedDialogLink>
                    )}
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack spacing={2}>
                    {hasVisibleFiles ? (
                      downloadFileItems
                    ) : (
                      <Center p="xl">
                        <Text size="md" color="dimmed">
                          This version is missing files
                        </Text>
                      </Center>
                    )}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            )}
            {version.recommendedResources && version.recommendedResources.length > 0 && (
              <Accordion.Item value="recommended-resources">
                <Accordion.Control>Recommended Resources</Accordion.Control>
                <Accordion.Panel>
                  <Stack spacing={2}>
                    {version.recommendedResources.map((resource) => (
                      <Card
                        key={resource.id}
                        component={Link}
                        href={`/models/${resource.model.id}?modelVersionId=${resource.id}`}
                        radius={0}
                        py="xs"
                        sx={(theme) => ({
                          cursor: 'pointer',
                          backgroundColor:
                            theme.colorScheme === 'dark'
                              ? theme.colors.dark[6]
                              : theme.colors.gray[0],
                        })}
                        data-activity="follow-recommendation:details"
                      >
                        <Stack spacing={4}>
                          <Group position="apart" spacing={8} noWrap>
                            <Text size="xs" weight={500} lineClamp={2}>
                              {resource.model.name}
                            </Text>
                            <Badge size="xs">{getDisplayName(resource.model.type)}</Badge>
                          </Group>
                          <Text color="dimmed" size="xs">
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
                <Accordion.Panel px="sm" pb="sm">
                  <Stack spacing={4}>
                    {version.description && (
                      <Box sx={{ p: { fontSize: 14, marginBottom: 10 } }}>
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
                        variant="link"
                        size="xs"
                        onClick={() =>
                          dialogStore.trigger({
                            component: VersionDescriptionModal,
                            props: { description: version.description ?? '' },
                          })
                        }
                        tabIndex={0}
                        sx={{ cursor: 'pointer' }}
                      >
                        Show more
                      </Text>
                    ) : null}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            )}
          </Accordion>

          <SmartCreatorCard
            user={model.user}
            tipBuzzEntityType="Model"
            tipBuzzEntityId={model.id}
          />
          {onSite && (
            <Group
              align="flex-start"
              position="right"
              spacing={4}
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

          <Group position="apart" align="flex-start" noWrap>
            {model.type === 'Checkpoint' && (
              <Group spacing={4} noWrap style={{ flex: 1, overflow: 'hidden' }} align="flex-start">
                <IconLicense size={16} />
                <Text
                  size="xs"
                  color="dimmed"
                  sx={{
                    whiteSpace: 'nowrap',
                    lineHeight: 1.1,
                  }}
                >
                  License{model.licenses.length > 0 ? 's' : ''}:
                </Text>
                <Stack spacing={0}>
                  {license && (
                    <Text
                      component="a"
                      href={license.url}
                      rel="nofollow noreferrer"
                      td="underline"
                      target="_blank"
                      size="xs"
                      color="dimmed"
                      sx={{ lineHeight: 1.1 }}
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
                        color="dimmed"
                        sx={{ lineHeight: 1.1 }}
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
          {license?.notice && (
            <Text size="xs" color="dimmed">
              {license.notice}
            </Text>
          )}
          {license?.poweredBy && (
            <Text size="xs" weight={500}>
              {license.poweredBy}
            </Text>
          )}
          {hasPendingClaimReport && (
            <AlertWithIcon icon={<IconMessageCircle2 />}>
              {`A verified artist believes this model was fine-tuned on their art. We're discussing this with the model creator and artist`}
            </AlertWithIcon>
          )}
          {model.poi && <PoiAlert />}
          {!model.nsfw && <AdUnitSide_2 />}
        </Stack>
      </ContainerGrid.Col>

      <ContainerGrid.Col
        xs={12}
        sm={7}
        md={8}
        orderSm={1}
        sx={(theme: MantineTheme) => ({
          [containerQuery.largerThan('xs')]: {
            padding: `0 ${theme.spacing.sm}px`,
            margin: `${theme.spacing.sm}px 0`,
          },
        })}
      >
        <Stack>
          {model.mode !== ModelModifier.TakenDown && (
            <ModelCarousel
              modelId={model.id}
              modelVersionId={version.id}
              modelUserId={model.user.id}
              limit={CAROUSEL_LIMIT}
              onBrowseClick={onBrowseClick}
            />
          )}
          {model.description ? (
            <ContentClamp maxHeight={460}>
              <RenderHtml html={model.description} withMentions />
            </ContentClamp>
          ) : null}
        </Stack>
      </ContainerGrid.Col>
      <ScheduleModal
        opened={scheduleModalOpened}
        onClose={() => setScheduleModalOpened((current) => !current)}
        onSubmit={(date: Date) => handlePublishClick(date)}
      />
    </ContainerGrid>
  );
}

type Props = {
  version: ModelById['modelVersions'][number];
  model: ModelById;
  onBrowseClick?: VoidFunction;
  onFavoriteClick?: (ctx: { versionId?: number; setTo: boolean }) => void;
};

function VersionDescriptionModal({ description }: { description: string }) {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} title="About this version" overflow="inside" size="lg" centered>
      <RenderHtml html={description} />
    </Modal>
  );
}
