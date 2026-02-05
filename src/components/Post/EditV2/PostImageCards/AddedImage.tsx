import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import {
  Accordion,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Menu,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconArrowBackUp,
  IconCopyPlus,
  IconChevronDown,
  IconChevronUp,
  IconDotsVertical,
  IconEye,
  IconEyeOff,
  IconHelp,
  IconPencil,
  IconPlus,
  IconTrash,
  IconUserPlus,
} from '@tabler/icons-react';
import { getQueryKey } from '@trpc/react-query';
import { remove, uniq } from 'lodash-es';
import React, { createContext, useContext, useMemo, useState } from 'react';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { openSetBrowsingLevelModal } from '~/components/Dialog/triggers/set-browsing-level';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { RefreshImageResources } from '~/components/Image/RefreshImageResources/RefreshImageResources';
import { UnblockImage } from '~/components/Image/UnblockImage/UnblockImage';
import {
  isMadeOnSite,
  useGenerationStatus,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { ResourceSelectMultiple } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ImageMetaModal } from '~/components/Post/EditV2/ImageMetaModal';
import { usePostEditStore, usePostPreviewContext } from '~/components/Post/EditV2/PostEditProvider';
import { PostImageTechnique } from '~/components/Post/EditV2/Techniques/PostImageTechnique';
import { ImageTechniquesPopover } from '~/components/Post/EditV2/Techniques/PostImageTechniquesPopover';
import {
  CurrentThumbnail,
  PostImageThumbnailSelect,
} from '~/components/Post/EditV2/Thumbnail/PostImageThumbnailSelect';
import { PostImageTool } from '~/components/Post/EditV2/Tools/PostImageTool';
import { ImageToolsPopover } from '~/components/Post/EditV2/Tools/PostImageToolsPopover';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { useCurrentUserRequired } from '~/hooks/useCurrentUser';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import type { NsfwLevel } from '~/server/common/enums';
import { BlockedReason } from '~/server/common/enums';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { VideoMetadata } from '~/server/schema/media.schema';
import type { PostEditImageDetail, ResourceHelper } from '~/server/services/post.service';
import {
  getBaseModelGroup,
  getGenerationBaseModelAssociatedGroups,
  getGenerationBaseModelResourceOptions,
} from '~/shared/constants/base-model.constants';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus, MediaType, ModelType } from '~/shared/utils/prisma/enums';
import { useImageStore } from '~/store/image.store';
import { createSelectStore } from '~/store/select.store';
import type { MyRecentlyAddedModels } from '~/types/router';
import { sortAlphabeticallyBy, sortByModelTypes } from '~/utils/array-helpers';
import { hasImageLicenseViolation, isValidAIGeneration } from '~/utils/image-utils';
import { showErrorNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';
import { queryClient, trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { CustomCard } from './CustomCard';

// #region [types]
type SimpleMetaPropsKey = keyof typeof simpleMetaProps;
const simpleMetaProps = {
  cfgScale: 'Guidance',
  steps: 'Steps',
  sampler: 'Sampler',
  seed: 'Seed',
  clipSkip: 'Clip skip',
} as const;
type AllowedResource = { type: ModelType; baseModels: string[] };
// #endregion

// #region [AddedImage context]
type State = {
  image: PostEditImageDetail;
  isBlocked: boolean;
  isScanned: boolean;
  isPending: boolean;
  canAdd: boolean;
  otherImages: PostEditImageDetail[];
  allowedResources: AllowedResource[];
  isPendingManualAssignment: boolean;
  onDelete: () => void;
  onEditMetaClick: () => void;
  isDeleting: boolean;
  isUpdating: boolean;
  isAddingResource: boolean;
  toggleHidePrompt: () => void;
  addResource: (modelVersionId: number) => void;
  nsfwLicenseViolation: ReturnType<typeof hasImageLicenseViolation>;
};
const AddedImageContext = createContext<State | null>(null);
const useAddedImageContext = () => {
  const context = useContext(AddedImageContext);
  if (!context) throw new Error('missing AddedImageContext ');
  return context;
};
// #endregion

const getAllowedResources = (resources: ResourceHelper[]) => {
  const resourcesSorted = sortByModelTypes(resources);
  for (const resource of resourcesSorted) {
    if (resource.modelType === ModelType.Checkpoint) {
      const baseModel = !!resource.modelVersionBaseModel
        ? getBaseModelGroup(resource.modelVersionBaseModel)
        : null;
      if (isDefined(baseModel)) {
        return (
          (getGenerationBaseModelResourceOptions(baseModel)?.filter(
            (t) => t.type !== 'Checkpoint'
          ) as AllowedResource[]) ?? []
        );
      }
    } else {
      if (isDefined(resource.modelType) && isDefined(resource.modelVersionBaseModel)) {
        const baseTypes = getGenerationBaseModelAssociatedGroups(
          resource.modelVersionBaseModel,
          resource.modelType
        );
        const allTypes = baseTypes.flatMap(
          (b) => (getGenerationBaseModelResourceOptions(b) as AllowedResource[]) ?? []
        );
        return Object.values(
          allTypes.reduce<Record<string, AllowedResource>>((acc, { type, baseModels }) => {
            if (!acc[type]) {
              acc[type] = { type, baseModels: [] };
            }
            acc[type].baseModels = Array.from(new Set([...acc[type].baseModels, ...baseModels]));
            return acc;
          }, {})
        );
      }
    }
  }
  return [];
};

const canAddFunc = (type: MediaType, meta: ImageMetaProps | null) => {
  return type === MediaType.video || !isMadeOnSite(meta);
};

// #region [AddedImage Provider]
export function AddedImage({ image }: { image: PostEditImageDetail }) {
  // #region [state]
  const { showPreview } = usePostPreviewContext();
  const storedImage = useImageStore(image);
  const queryUtils = trpc.useUtils();

  const [images, updateImage, setImages, postId] = usePostEditStore((state) => [
    state.images,
    state.updateImage,
    state.setImages,
    state.post?.id,
  ]);

  const { id, meta, blockedFor, ingestion, nsfwLevel, hideMeta, type } = storedImage;
  const otherImages = images
    .map((img) => (img.type === 'added' ? img.data : null))
    .filter(isDefined)
    .filter((data) => data.id !== id && canAddFunc(data.type, data.meta));

  const allowedResources = useMemo(() => {
    return getAllowedResources(image.resourceHelper);
  }, [image.resourceHelper]);

  const nsfwLicenseViolation = useMemo(() => {
    return hasImageLicenseViolation(storedImage);
  }, [storedImage.nsfwLevel, storedImage.resourceHelper]);

  const isPending = ingestion === ImageIngestionStatus.Pending;
  // const isBlocked = ingestion === ImageIngestionStatus.Blocked;
  const isScanned = ingestion === ImageIngestionStatus.Scanned;
  const isPendingManualAssignment = ingestion === ImageIngestionStatus.PendingManualAssignment;
  const isBlocked = false;
  const canAdd = canAddFunc(type, meta);
  // #endregion

  // #region [delete image]
  const deleteImageMutation = trpc.image.delete.useMutation({
    onSuccess: (_, { id }) => {
      setImages((state) => state.filter((x) => x.type !== 'added' || x.data.id !== id));
      if (postId)
        queryUtils.post.getEdit.setData({ id: postId }, (old) => {
          if (!old) return old;

          return { ...old, images: old.images?.filter((x) => x.id !== id) };
        });
    },
    onError: (error) => showErrorNotification({ error: new Error(error.message) }),
  });

  const handleDelete = () => {
    if (!isBlocked)
      dialogStore.trigger({
        component: ConfirmDialog,
        props: {
          title: 'Delete image',
          message: 'Are you sure you want to delete this image?',
          labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
          confirmProps: { color: 'red', loading: deleteImageMutation.isLoading },
          onConfirm: async () => await deleteImageMutation.mutateAsync({ id: image.id }),
        },
      });
    else deleteImageMutation.mutate({ id: image.id });
  };
  // #endregion

  // #region [image meta]
  const handleEditMetaClick = () => {
    dialogStore.trigger({
      component: ImageMetaModal,
      props: {
        id,
        meta: meta ?? undefined,
        nsfwLevel,
        blockedFor: blockedFor ?? undefined,
        updateImage,
      },
    });
  };

  const updateImageMutation = trpc.post.updateImage.useMutation({
    onSuccess: (_, { id, hideMeta }) => {
      updateImage(id, (image) => {
        image.hideMeta = hideMeta ?? false;
      });
    },
  });
  const toggleHidePrompt = () => {
    updateImageMutation.mutate({ id, hideMeta: !hideMeta });
  };

  const addResourceMutation = trpc.post.addResourceToImage.useMutation({
    onSuccess: (resp) => {
      if (resp) {
        updateImage(id, (image) => {
          image.resourceHelper = image.resourceHelper.concat(resp);
        });

        const queryKey = getQueryKey(trpc.model.getRecentlyManuallyAdded);
        queryClient.setQueriesData<MyRecentlyAddedModels>({ queryKey, exact: false }, (old) => {
          if (!old) return;
          return uniq([...resp.map((r) => r.modelId).filter(isDefined), ...old]);
        });
      }
    },
    onError(error) {
      showErrorNotification({
        title: 'Unable to add resource',
        error: new Error(error.message),
      });
    },
  });
  const addResource = (modelVersionId: number) => {
    if (!canAdd) return;
    addResourceMutation.mutate({ id: [id], modelVersionId });
  };
  // #endregion

  return (
    <AddedImageContext.Provider
      value={{
        image,
        isBlocked,
        isPending,
        isScanned,
        canAdd,
        otherImages,
        allowedResources,
        onDelete: handleDelete,
        onEditMetaClick: handleEditMetaClick,
        isDeleting: deleteImageMutation.isLoading,
        isUpdating: updateImageMutation.isLoading,
        isAddingResource: addResourceMutation.isLoading,
        toggleHidePrompt,
        addResource,
        isPendingManualAssignment,
        nsfwLicenseViolation,
      }}
    >
      <div className="overflow-hidden rounded-lg border border-gray-1 bg-gray-0 dark:border-dark-6 dark:bg-dark-8">
        {showPreview ? <Preview /> : <EditDetail />}
      </div>
    </AddedImageContext.Provider>
  );
}

// #endregion

const store = createSelectStore();

function Preview() {
  const { image } = useAddedImageContext();
  const { isBlocked } = useAddedImageContext();
  const opened = store.useIsSelected(image.id);
  const value = opened ? 'edit-detail' : null;

  return (
    <div className="flex flex-col">
      <PostImage />
      {isBlocked && <TosViolationBanner />}
      <Accordion
        value={value}
        onChange={(value) => store.toggle(image.id, !!value)}
        variant="separated"
        classNames={{ content: 'p-0' }}
      >
        <Accordion.Item value="edit-detail" className="border-none">
          <Accordion.Control>Edit details</Accordion.Control>
          <Accordion.Panel>
            <EditDetail />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </div>
  );
}

const ResourceHeader = () => {
  const status = useGenerationStatus();
  const { image, allowedResources, addResource, isAddingResource, canAdd } = useAddedImageContext();

  const cantAdd = image.resourceHelper.length >= status.limits.resources;

  const [updateImage] = usePostEditStore((state) => [state.updateImage]);

  return (
    <div className="group flex items-center justify-between">
      <div className="flex items-center gap-2">
        <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
          Resources
        </h3>
        <InfoPopover
          type="hover"
          hideClick={true}
          variant="transparent"
          size="sm"
          position="top"
          iconProps={{ size: 20 }}
        >
          Models, LoRAs, embeddings or other Stable Diffusion or Flux specific resources used to
          create this image.
        </InfoPopover>
      </div>
      <div className="flex items-center gap-2">
        {canAdd ? (
          <>
            <Box className="hidden group-hover:block">
              <InfoPopover
                type="hover"
                hideClick={true}
                variant="transparent"
                size="sm"
                position="top"
                iconProps={{ size: 20 }}
                customIcon={IconHelp}
              >
                <Stack>
                  <Text>Manually add a resource.</Text>
                  <Text size="sm">
                    If you can&apos;t find the one you&apos;re looking for, it&apos;s either not
                    uploaded here, or is being filtered out to match your already selected
                    resources.
                  </Text>
                </Stack>
              </InfoPopover>
            </Box>
            <Tooltip
              label={`Maximum resources reached (${status.limits.resources})`}
              disabled={!cantAdd}
            >
              <ResourceSelectMultiple
                buttonLabel="RESOURCE"
                modalTitle="Select resource(s)"
                selectSource="addResource"
                options={{
                  resources: allowedResources,
                  excludeIds: image.resourceHelper.map((r) => r.modelVersionId).filter(isDefined),
                }}
                buttonProps={{
                  size: 'compact-sm',
                  className: 'text-sm',
                  loading: isAddingResource,
                  disabled: cantAdd,
                }}
                onChange={(vals) => {
                  if (!vals?.length || cantAdd) return;
                  vals.forEach((val) => {
                    addResource(val.id);
                  });
                }}
              />
            </Tooltip>
          </>
        ) : (
          <Badge color="cyan">Made on-site</Badge>
        )}
        <RefreshImageResources
          imageId={image.id}
          onSuccess={(imageResources) => {
            updateImage(image.id, (img) => {
              img.resourceHelper = imageResources;
            });
          }}
        />
      </div>
    </div>
  );
};

const ResourceRow = ({ resource, i }: { resource: ResourceHelper; i: number }) => {
  const { image, canAdd, otherImages } = useAddedImageContext();
  const status = useGenerationStatus();
  const [updateImage] = usePostEditStore((state) => [state.updateImage]);

  const { modelId, modelName, modelType, modelVersionId, modelVersionName, detected } = resource;

  const otherAvailableIDs = useMemo(() => {
    return otherImages
      .map((oi) => {
        // Skip if target image is at resource limit
        if (oi.resourceHelper.length >= status.limits.resources) return null;
        // Skip if target image already has this exact resource
        if (oi.resourceHelper.some((rh) => rh.modelVersionId === modelVersionId)) return null;
        // Allow copy to all other eligible images
        return oi.id;
      })
      .filter(isDefined);
  }, [modelVersionId, otherImages, status.limits.resources]);

  const copyResourceMutation = trpc.post.addResourceToImage.useMutation({
    onSuccess: (resp) => {
      if (resp) {
        for (const r of resp) {
          updateImage(r.imageId, (img) => {
            img.resourceHelper.push(r);
          });
        }
      }
    },
    onError(error) {
      showErrorNotification({
        title: 'Unable to add resources',
        error: new Error(error.message),
      });
    },
  });

  const removeResourceMutation = trpc.post.removeResourceFromImage.useMutation({
    onSuccess: (resp) => {
      if (resp) {
        updateImage(image.id, (img) => {
          remove(img.resourceHelper, (r) => r.modelVersionId === resp.modelVersionId);
        });
      }
    },
    onError(error) {
      showErrorNotification({
        title: 'Unable to remove resource',
        error: new Error(error.message),
      });
    },
  });

  const handleRemoveResource = () => {
    if (!canAdd || !modelVersionId || detected) return;
    openConfirmModal({
      centered: true,
      title: 'Remove Resource',
      children: 'Are you sure you want to remove this resource from this image?',
      labels: { confirm: 'Yes, remove it', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        if (!canAdd) return;
        removeResourceMutation.mutate({ id: image.id, modelVersionId });
      },
    });
  };

  const handleCopyResource = () => {
    if (!otherAvailableIDs.length || !modelVersionId) return;
    openConfirmModal({
      centered: true,
      title: 'Copy to All',
      children: `Add this resource to all other valid images (${otherAvailableIDs.length})?`,
      labels: { confirm: 'Yep!', cancel: 'Cancel' },
      confirmProps: { color: 'green' },
      onConfirm: () => {
        if (!otherAvailableIDs.length) return;
        copyResourceMutation.mutate({ id: otherAvailableIDs, modelVersionId });
      },
    });
  };

  return !!modelId && !!modelVersionId ? (
    <Group gap="xs" wrap="nowrap" mt={i === 0 ? 4 : undefined}>
      {!detected && (
        <Tooltip label="Manually-added" withArrow>
          <ThemeIcon color="cyan" variant="light" radius="xl" size="sm">
            <IconUserPlus size={14} />
          </ThemeIcon>
        </Tooltip>
      )}
      <Link
        href={`/models/${modelId}?modelVersionId=${modelVersionId}`}
        target="_blank"
        className="grow"
      >
        <Box className="flex items-center justify-between gap-3 hover:bg-gray-2 hover:dark:bg-dark-5">
          <Stack gap={0}>
            <Text lineClamp={1}>{modelName}</Text>
            <Text span c="dimmed" size="sm" lineClamp={1}>
              {modelVersionName}
            </Text>
          </Stack>
          <Badge color="gray" size="md" variant="filled">
            {getDisplayName(modelType ?? 'unknown')}
          </Badge>
        </Box>
      </Link>

      {!otherAvailableIDs.length ? (
        <></>
      ) : (
        <Tooltip label="Copy to All">
          <LegacyActionIcon
            color="violet"
            size="sm"
            onClick={handleCopyResource}
            loading={copyResourceMutation.isLoading}
          >
            <IconCopyPlus size={16} />
          </LegacyActionIcon>
        </Tooltip>
      )}
      {!canAdd ? (
        <></>
      ) : (
        <Tooltip label="Delete">
          <LegacyActionIcon
            color="red"
            size="sm"
            onClick={handleRemoveResource}
            loading={removeResourceMutation.isLoading}
          >
            <IconTrash size={16} />
          </LegacyActionIcon>
        </Tooltip>
      )}
    </Group>
  ) : (
    <div className="flex items-center justify-between gap-3">
      <Text>
        {modelName} -{' '}
        <Text span c="dimmed" size="sm">
          {modelVersionName}
        </Text>
      </Text>
      <Group gap={4}>
        <Badge color="gray" size="md" variant="filled">
          {getDisplayName(modelType ?? 'unknown')}
        </Badge>
      </Group>
    </div>
  );
};

function EditDetail() {
  const [showMoreResources, setShowMoreResources] = useState(false);
  const { showPreview } = usePostPreviewContext();
  const {
    image,
    isBlocked,
    isPending,
    isScanned,
    onEditMetaClick,
    isDeleting,
    isUpdating,
    toggleHidePrompt,
    isPendingManualAssignment,
  } = useAddedImageContext();
  const postId = usePostEditStore((state) => state.post?.id);
  const updateImage = usePostEditStore((state) => state.updateImage);

  const { meta, hideMeta, resourceHelper: resources, blockedFor } = image;

  const simpleMeta = Object.entries(simpleMetaProps).filter(([key]) => meta?.[key]);
  const hasSimpleMeta = !!simpleMeta.length;
  const resourcesSorted = sortByModelTypes(resources);
  const cannotVerifyAi =
    !isValidAIGeneration({
      id: image.id,
      nsfwLevel: image.nsfwLevel,
      resources: image.resourceHelper,
      tools: image.tools,
      meta: image.meta as ImageMetaProps,
      tags: image.tags,
    }) || blockedFor === BlockedReason.AiNotVerified;

  return (
    <div className="relative @container">
      <div className={`flex flex-col gap-3 p-3  ${!showPreview ? '@sm:gap-4 @sm:p-6' : ''}`}>
        <LoadingOverlay visible={isDeleting} />
        <div
          className={`flex flex-row-reverse flex-wrap gap-3 ${
            !showPreview ? '@sm:flex-nowrap @sm:gap-6' : ''
          }`}
        >
          {/*
      // #region [image]
      */}
          {(!showPreview || hasSimpleMeta) && (
            <div className={`flex w-full flex-col gap-3 ${!showPreview ? '@sm:w-4/12' : ''}`}>
              {!showPreview && <PostImage />}
              {hasSimpleMeta && (
                <>
                  <div className="flex flex-col *:border-gray-4 not-last:*:border-b dark:*:border-dark-4">
                    {simpleMeta.map(([key, label]) => (
                      <div key={key} className="flex justify-between py-0.5">
                        <Text>{label}</Text>
                        <Text>{meta?.[key as SimpleMetaPropsKey]}</Text>
                      </div>
                    ))}
                  </div>
                  {!isBlocked && !('engine' in (image.meta ?? {})) && (
                    <div>
                      <Button
                        variant="light"
                        color="blue"
                        size="compact-sm"
                        classNames={{ label: 'flex gap-1' }}
                        onClick={onEditMetaClick}
                        className="text-sm"
                      >
                        <IconPencil size={16} />
                        <span>EDIT</span>
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {/* #endregion */}

          <div
            className={`flex w-full flex-1 flex-col gap-3 ${
              !showPreview ? '@sm:w-4/6 @sm:gap-4' : ''
            }`}
          >
            {/*
          // #region [TOS Violation]
          */}
            {isBlocked && !showPreview && <TosViolationBanner />}
            {cannotVerifyAi && (
              <Alert
                color="red"
                className={`p-3 @container ${showPreview ? 'rounded-none' : 'rounded-lg'}`}
                classNames={{ message: 'flex flex-col items-center justify-center' }}
              >
                <Text c="red" className="font-bold">
                  Unable to Verify AI Generation
                </Text>
                <Text size="sm">
                  We couldn&rsquo;t confirm that this image was generated by AI. To resolve this,
                  you can manually add the prompt used to create the image.
                </Text>
              </Alert>
            )}
            <NsfwLicenseViolationAlert />
            {/* #endregion */}

            {/*
          // #region [prompt]
          */}

            <CustomCard className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0">
                  Prompt
                </h3>
                {!isBlocked && (
                  <div className="flex gap-1">
                    <Button
                      variant="light"
                      color="blue"
                      size="compact-sm"
                      onClick={onEditMetaClick}
                      className="text-sm"
                    >
                      EDIT
                    </Button>
                    {meta?.prompt && (
                      <Button
                        variant={hideMeta ? 'filled' : 'light'}
                        color="blue"
                        size="compact-sm"
                        classNames={{ label: 'flex gap-1 text-sm' }}
                        onClick={toggleHidePrompt}
                        loading={isUpdating}
                      >
                        {hideMeta ? <IconEye size={16} /> : <IconEyeOff size={16} />}
                        <span>{hideMeta ? 'SHOW' : 'HIDE'} PROMPT</span>
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {meta?.prompt && (
                <Text className={`line-clamp-3 leading-5 ${hideMeta ? 'opacity-20' : ''}`}>
                  {meta.prompt}
                </Text>
              )}
              {meta?.negativePrompt && (
                <>
                  <Divider />
                  <h3
                    className={`leading-none text-dark-7 dark:text-gray-0 ${
                      hideMeta ? 'opacity-20' : ''
                    }`}
                  >
                    Negative Prompt
                  </h3>
                  <Text className={`line-clamp-3 leading-5 ${hideMeta ? 'opacity-20' : ''}`}>
                    {meta.negativePrompt}
                  </Text>
                </>
              )}
            </CustomCard>

            {/* #endregion */}

            {/*
          // #region [resources]
          */}
            {!!resources?.length && (
              <CustomCard className="flex flex-col gap-2">
                <ResourceHeader />
                {/* TODO check if these ever dont have modelIds */}
                {resourcesSorted
                  .filter((x) => !!x.modelName)
                  .slice(0, !showMoreResources ? 3 : resources.length)
                  .map((resource, i) => (
                    <ResourceRow key={`${image.id}-${i}`} resource={resource} i={i} />
                  ))}
                {resources.length > 3 && (
                  <div>
                    <Button
                      variant="light"
                      color="blue"
                      size="compact-sm"
                      classNames={{ label: 'flex gap-1' }}
                      onClick={() => setShowMoreResources((o) => !o)}
                    >
                      {!showMoreResources ? (
                        <>
                          <IconChevronDown size={16} />
                          <span>Show All ({resources.length})</span>
                        </>
                      ) : (
                        <>
                          <IconChevronUp size={16} />
                          <span>Show Less</span>
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </CustomCard>
            )}
            {/* #endregion */}

            {/*
          // #region [missing resources]
          */}
            {!resources?.length && (
              <CustomCard className="flex flex-col gap-2">
                <ResourceHeader />
                <Center>
                  <Text>
                    We weren&apos;t able to detect any resources used in the creation of this image.
                    You can add them manually using the + Resource button.
                  </Text>
                </Center>
              </CustomCard>
            )}
            {/* #endregion */}

            {/*
          // #region [tools]
          */}

            {/* Commented out as requested by Max -Manuel */}
            {/* {activeCollection?.mode === CollectionMode.Contest && (
              <Alert radius="md">
                <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                  Contest tip!
                </h3>
                {activeCollection.name.toLowerCase().includes('odyssey') ? (
                  <Text mt="md">
                    If you&rsquo;re participating in Project Odyssey, make sure to add the tags for
                    the AI Filmmaking tools you used. This will make you eligible for the Sponsor
                    Company Awards (cash prize of $500) from our Premier Sponsors such as Civitai,
                    ElevenLabs, ThinkDiffusion, Morph Studio, LensGo, Domo AI, DeepMake, and Neural
                    Frames! Do not tag a tool you did not use to make your project.
                  </Text>
                ) : (
                  <Text mt="md">
                    Tagging the tools you used may make you elegible for Sponsored Awards. For
                    example, in Project Odyssey, ElevenLabs has a sponsored $500 USD cash prize.
                  </Text>
                )}
              </Alert>
            )} */}

            <CustomCard className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                    Tools
                  </h3>
                  <InfoPopover
                    type="hover"
                    hideClick={true}
                    variant="transparent"
                    size="sm"
                    className="justify-end"
                    iconProps={{ size: 20 }}
                  >
                    Traditional or generative AI programs, platforms or websites used to create this
                    image.
                  </InfoPopover>
                </div>
                <Popover>
                  <PopoverButton
                    as={Button}
                    // @ts-ignore eslint-disable-next-line
                    variant="light"
                    color="blue"
                    size="compact-sm"
                    classNames={{ label: 'flex gap-1' }}
                    onClick={() => undefined}
                    className="text-sm"
                  >
                    <IconPlus size={16} />
                    <span>TOOL</span>
                  </PopoverButton>
                  <PopoverPanel className="[--anchor-gap:4px]" anchor="top start" focus>
                    {({ close }) => (
                      <Card p={0} withBorder>
                        <ImageToolsPopover image={image} onSuccess={close} />
                      </Card>
                    )}
                  </PopoverPanel>
                </Popover>
              </div>
              {!!image.tools?.length && (
                <ul className="flex flex-col">
                  {sortAlphabeticallyBy([...image.tools], (x) => x.name).map((tool, index) => (
                    <li key={tool.id} className="list-none">
                      {index !== 0 && <Divider />}
                      <PostImageTool image={image} tool={tool} />
                    </li>
                  ))}
                </ul>
              )}
            </CustomCard>
            {/* #endregion */}

            {/*
          // #region [techniques]
          */}

            <CustomCard className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                    Techniques
                  </h3>
                  {/* <LegacyActionIcon variant="transparent" size="sm">
                    <IconInfoCircle />
                  </LegacyActionIcon> */}
                </div>
                <Popover>
                  <PopoverButton
                    as={Button}
                    // @ts-ignore eslint-disable-next-line
                    variant="light"
                    color="blue"
                    size="compact-sm"
                    classNames={{ label: 'flex gap-1' }}
                    onClick={() => undefined}
                    className="text-sm"
                  >
                    <IconPlus size={16} />
                    <span>TECHNIQUE</span>
                  </PopoverButton>
                  <PopoverPanel className="[--anchor-gap:4px]" anchor="top start" focus>
                    {({ close }) => (
                      <Card p={0} withBorder>
                        <ImageTechniquesPopover image={image} onSuccess={close} />
                      </Card>
                    )}
                  </PopoverPanel>
                </Popover>
              </div>
              {!!image.techniques.length && (
                <ul className="flex flex-col">
                  {sortAlphabeticallyBy([...image.techniques], (x) => x.name).map(
                    (technique, index) => (
                      <li key={technique.id} className="list-none">
                        {index !== 0 && <Divider />}
                        <PostImageTechnique image={image} technique={technique} />
                      </li>
                    )
                  )}
                </ul>
              )}
            </CustomCard>
            {/* #endregion */}

            {/* #region [thumbnail] */}
            {image.type === MediaType.video && (
              <CustomCard className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                      Thumbnail
                    </h3>
                    <InfoPopover
                      type="hover"
                      hideClick={true}
                      variant="transparent"
                      size="sm"
                      className="justify-end"
                      iconProps={{ size: 20 }}
                    >
                      The thumbnail is the image that represents your post. It is the first thing
                      viewers see when they come across your post.
                    </InfoPopover>
                  </div>
                  <Button
                    className="text-sm uppercase"
                    variant="light"
                    onClick={() => {
                      const metadata = image.metadata as VideoMetadata;

                      dialogStore.trigger({
                        component: PostImageThumbnailSelect,
                        props: {
                          imageId: image.id,
                          src: image.url,
                          duration: metadata?.duration ?? 1,
                          width: metadata?.width ?? DEFAULT_EDGE_IMAGE_WIDTH,
                          postId,
                          thumbnailFrame: metadata?.thumbnailFrame,
                          updateImage,
                        },
                      });
                    }}
                    size="compact-sm"
                  >
                    Select
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <CurrentThumbnail
                    imageId={image.id}
                    postId={postId}
                    src={image.url}
                    thumbnailFrame={(image.metadata as VideoMetadata)?.thumbnailFrame}
                    thumbnailUrl={image.thumbnailUrl}
                    width={image.metadata.width}
                    updateImage={updateImage}
                  />
                </div>
              </CustomCard>
            )}
            {/* #endregion */}

            {meta?.external && Object.keys(meta?.external).length > 0 && (
              <CustomCard className="flex flex-col gap-2">
                <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                  External Data
                </h3>
                <Text>Found external data - will apply after post is published.</Text>
              </CustomCard>
            )}
          </div>
        </div>
        {/*
 // #region [tags]
 */}
        {(!!image.tags?.length || isScanned) && (
          <>
            <Divider />
            <VotableTags
              entityId={image.id}
              entityType="image"
              tags={!!image.tags.length ? image.tags : undefined}
              nsfwLevel={image.nsfwLevel}
              collapsible
              canAdd
              onTagsLoaded={(tags) => {
                updateImage(image.id, (img) => {
                  img.tags = tags.map((t) => ({ ...t, imageId: image.id }));
                });
              }}
            />
          </>
        )}
        {isPending && (
          <Alert
            color="yellow"
            w="100%"
            radius={0}
            className="rounded-lg p-2"
            classNames={{ message: 'flex items-center justify-center gap-2' }}
          >
            <Loader size="xs" />
            <Text align="center">
              Analyzing image. Image will not be visible to other people while analysis is in
              progress.
            </Text>
          </Alert>
        )}
        {isPendingManualAssignment && (
          <Alert
            color="blue"
            w="100%"
            radius={0}
            className="rounded-lg p-2"
            classNames={{ message: 'flex items-center justify-center gap-2' }}
          >
            <Text align="center">
              This image is waiting for manual review and will receive a rating at a later time.
            </Text>
          </Alert>
        )}
        {/* #endregion */}
      </div>
    </div>
  );
}

function PostImage() {
  const { showPreview } = usePostPreviewContext();
  const { image, isBlocked, onDelete, isDeleting, onEditMetaClick } = useAddedImageContext();
  const { metadata, url, type, id, nsfwLevel } = image;
  return (
    <div className={`relative`}>
      <div
        className="mx-auto flex flex-1"
        style={{
          // TODO - db/code cleanup - ideally we only use metadata to get dimensions in future
          aspectRatio: `${metadata?.width ?? 1}/${metadata?.height ?? 1}`,
          maxWidth: metadata?.width,
        }}
      >
        <EdgeMedia
          src={url}
          width={metadata?.width ?? DEFAULT_EDGE_IMAGE_WIDTH}
          type={type}
          original={type === 'video' ? true : undefined}
          className={showPreview ? 'rounded-none' : 'rounded-lg'}
          anim={type === 'video'}
          html5Controls
        />
      </div>
      <div className="absolute inset-x-0 top-0 z-10 h-12 bg-gradient-to-b from-black opacity-25" />
      {!!nsfwLevel && (
        <BrowsingLevelBadge
          browsingLevel={nsfwLevel}
          size="lg"
          onClick={
            !isBlocked ? () => openSetBrowsingLevelModal({ imageId: id, nsfwLevel }) : undefined
          }
          className={`absolute left-2 top-2 z-20 ${!isBlocked ? 'cursor-pointer' : ''}`}
        />
      )}
      <div className="absolute right-2 top-2 z-20 flex gap-1">
        <Menu withArrow position="bottom-end">
          <Menu.Target>
            <LegacyActionIcon>
              <IconDotsVertical
                color="#fff"
                filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
              />
            </LegacyActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {!isBlocked && (
              <Menu.Item leftSection={<IconPencil size={16} />} onClick={onEditMetaClick}>
                Edit image
              </Menu.Item>
            )}
            <Menu.Item
              color="red"
              leftSection={<IconTrash size={16} />}
              onClick={onDelete}
              disabled={isDeleting}
            >
              Delete image
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>
    </div>
  );
}

// Get human-readable NSFW level name
const getNsfwLevelName = (level: NsfwLevel) => {
  return browsingLevelLabels[level] || 'Unknown';
};

function NsfwLicenseViolationAlert() {
  const { nsfwLicenseViolation } = useAddedImageContext();
  const { showPreview } = usePostPreviewContext();

  if (!nsfwLicenseViolation.violation) return null;

  const { restrictedResources, nsfwLevel } = nsfwLicenseViolation;
  const currentLevelName = getNsfwLevelName(nsfwLevel ?? 0);

  return (
    <Alert
      color="orange"
      className={`p-3 @container ${showPreview ? 'rounded-none' : 'rounded-lg'}`}
      classNames={{ message: 'flex flex-col gap-2' }}
    >
      <Text c="orange" className="font-bold">
        NSFW License Restriction Notice
      </Text>
      <Text size="sm">
        This {currentLevelName} image uses models with licenses that restrict this content level:
      </Text>
      <ul className="ml-4 list-disc">
        {restrictedResources?.map((resource, index) => (
          <li key={index} className="text-sm">
            <Text span className="font-medium">
              {resource.modelName}
            </Text>
            {resource.baseModel && (
              <Text span c="dimmed">
                {' '}
                ({resource.baseModel})
              </Text>
            )}
            {resource.restrictedLevels && resource.restrictedLevels.length > 0 && (
              <Text span size="xs" c="dimmed">
                {' '}
                - Restricts: {resource.restrictedLevels.map(getNsfwLevelName).join(', ')}
              </Text>
            )}
          </li>
        ))}
      </ul>
      <Text size="sm">
        Consider using alternative models or adjusting the content rating to comply with license
        terms.
      </Text>
    </Alert>
  );
}

function TosViolationBanner() {
  const currentUser = useCurrentUserRequired();
  const { image, onDelete, isDeleting } = useAddedImageContext();
  const { blockedFor, id } = image;
  const { showPreview } = usePostPreviewContext();
  return (
    <Alert
      color="red"
      className={`p-3 @container ${showPreview ? 'rounded-none' : 'rounded-lg'}`}
      classNames={{ message: 'flex flex-col items-center justify-center' }}
    >
      <Text c="red" className="font-bold">
        TOS Violation
      </Text>
      <Text>This image has been flagged as a TOS violation.</Text>
      {blockedFor && (
        <Text className="flex flex-wrap items-center gap-1">
          <span>Blocked for:</span>
          <Text c="red" inline className="font-semibold">
            {blockedFor}
          </Text>
        </Text>
      )}
      <div className="flex justify-center gap-3">
        {currentUser.isModerator && (
          <UnblockImage imageId={id} skipConfirm>
            {({ onClick, isLoading }) => (
              <Button
                onClick={onClick}
                loading={isLoading}
                color="gray.6"
                mt="xs"
                leftSection={<IconArrowBackUp size={20} />}
              >
                Unblock
              </Button>
            )}
          </UnblockImage>
        )}
        <Button
          onClick={onDelete}
          loading={isDeleting}
          color="red.7"
          mt="xs"
          leftSection={<IconTrash size={20} />}
        >
          Delete
        </Button>
      </div>
    </Alert>
  );
}
