import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
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
  IconArrowFork,
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
import { remove } from 'lodash-es';
import React, { createContext, useContext, useMemo, useState } from 'react';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { openSetBrowsingLevelModal } from '~/components/Dialog/dialog-registry';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UnblockImage } from '~/components/Image/UnblockImage/UnblockImage';
import {
  isMadeOnSite,
  useGenerationStatus,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { ResourceSelectMultiple } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultiple';
import { BrowsingLevelBadge } from '~/components/ImageGuard/ImageGuard2';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ImageMetaModal } from '~/components/Post/EditV2/ImageMetaModal';
import {
  PostEditImageDetail,
  usePostEditStore,
  usePostPreviewContext,
} from '~/components/Post/EditV2/PostEditProvider';
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
import { VideoMetadata } from '~/server/schema/media.schema';
import { Generation } from '~/server/services/generation/generation.types';
import {
  getBaseModelResourceTypes,
  getBaseModelSetType,
  getBaseModelSetTypes,
} from '~/shared/constants/generation.constants';
import { ImageIngestionStatus, MediaType, ModelType } from '~/shared/utils/prisma/enums';
import { useImageStore } from '~/store/image.store';
import { createSelectStore } from '~/store/select.store';
import { sortAlphabeticallyBy, sortByModelTypes } from '~/utils/array-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
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
type ResourceHelper = PostEditImageDetail['resourceHelper'][number];
// #endregion

// #region [AddedImage context]
type State = {
  image: PostEditImageDetail;
  isBlocked: boolean;
  isScanned: boolean;
  isPending: boolean;
  isOnSite: boolean;
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
        ? getBaseModelSetType(resource.modelVersionBaseModel)
        : null;
      if (isDefined(baseModel)) {
        return (
          (getBaseModelResourceTypes(baseModel)?.filter(
            (t) => t.type !== 'Checkpoint'
          ) as AllowedResource[]) ?? []
        );
      }
    } else {
      if (isDefined(resource.modelType) && isDefined(resource.modelVersionBaseModel)) {
        const baseTypes = getBaseModelSetTypes({
          modelType: resource.modelType,
          baseModel: resource.modelVersionBaseModel,
        });
        const allTypes = baseTypes.flatMap(
          (b) => (getBaseModelResourceTypes(b) as AllowedResource[]) ?? []
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

// #region [AddedImage Provider]
export function AddedImage({ image }: { image: PostEditImageDetail }) {
  // #region [state]
  const { showPreview } = usePostPreviewContext();
  const storedImage = useImageStore(image);

  const [images, updateImage, setImages] = usePostEditStore((state) => [
    state.images,
    state.updateImage,
    state.setImages,
  ]);

  const { id, meta, blockedFor, ingestion, nsfwLevel, hideMeta } = storedImage;
  const otherImages = images
    .filter((img) => img.type === 'added')
    .filter((img) => img.data.id !== id && !isMadeOnSite(img.data.meta)) // double filter because TS is stupid
    .map((i) => i.data);

  const allowedResources = useMemo(() => {
    return getAllowedResources(image.resourceHelper);
  }, [image.resourceHelper]);

  const isPending = ingestion === ImageIngestionStatus.Pending;
  // const isBlocked = ingestion === ImageIngestionStatus.Blocked;
  const isScanned = ingestion === ImageIngestionStatus.Scanned;
  const isPendingManualAssignment = ingestion === ImageIngestionStatus.PendingManualAssignment;
  const isBlocked = false;
  const isOnSite = isMadeOnSite(meta);
  // #endregion

  // #region [delete image]
  const deleteImageMutation = trpc.image.delete.useMutation({
    onSuccess: (_, { id }) =>
      setImages((state) => state.filter((x) => x.type !== 'added' || x.data.id !== id)),
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
    if (isOnSite) return;
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
        isOnSite,
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
  const { image, allowedResources, addResource, isAddingResource, isOnSite } =
    useAddedImageContext();

  const cantAdd = image.resourceHelper.length >= status.limits.resources;

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
      {!isOnSite ? (
        <Group spacing="xs">
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
                  uploaded here, or is being filtered out to match your already selected resources.
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
              isTraining={true}
              options={{
                resources: allowedResources,
              }}
              buttonProps={{
                size: 'sm',
                compact: true,
                className: 'text-sm',
                loading: isAddingResource,
                disabled: cantAdd,
              }}
              onChange={(val) => {
                const vals = val as Generation.Resource[] | undefined;
                if (!vals || !vals.length || cantAdd) return;
                vals.forEach((val) => {
                  addResource(val.id);
                });
              }}
            />
          </Tooltip>
        </Group>
      ) : (
        <Badge color="cyan">Made on-site</Badge>
      )}
    </div>
  );
};

const ResourceRow = ({ resource, i }: { resource: ResourceHelper; i: number }) => {
  const { image, isOnSite, otherImages } = useAddedImageContext();
  const [updateImage] = usePostEditStore((state) => [state.updateImage]);

  const {
    modelId,
    modelName,
    modelType,
    modelVersionId,
    modelVersionName,
    modelVersionBaseModel,
    detected,
  } = resource;

  const otherAvailableIDs = useMemo(() => {
    return otherImages
      .map((oi) => {
        if (!oi.resourceHelper.length) return oi.id;
        const otherAllowed = getAllowedResources(oi.resourceHelper);
        const resourceMatch = otherAllowed.find((oa) => oa.type === modelType);
        if (
          resourceMatch &&
          modelVersionBaseModel &&
          resourceMatch.baseModels.includes(modelVersionBaseModel)
        ) {
          return oi.id;
        }
      })
      .filter(isDefined);
  }, [modelType, modelVersionBaseModel, otherImages]);

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
          remove(img.resourceHelper, (r) => r.id === resp.id);
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
    if (isOnSite || !modelVersionId || detected) return;
    openConfirmModal({
      centered: true,
      title: 'Remove Resource',
      children: 'Are you sure you want to remove this resource from this image?',
      labels: { confirm: 'Yes, remove it', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        if (isOnSite) return;
        removeResourceMutation.mutate({ id: image.id, modelVersionId });
      },
    });
  };

  const handleCopyResource = () => {
    if (!otherAvailableIDs.length || !modelVersionId || detected) return;
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
    <Group spacing="xs" noWrap mt={i === 0 ? 4 : undefined}>
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
          <Text>
            {modelName} -{' '}
            <Text span color="dimmed" size="sm">
              {modelVersionName}
            </Text>
          </Text>
          <Group spacing={2}>
            <Badge color="gray" size="md" variant="filled">
              {getDisplayName(modelType ?? 'unknown')}
            </Badge>
          </Group>
        </Box>
      </Link>

      {!detected && (
        <Group spacing={4} noWrap>
          {!otherAvailableIDs.length ? (
            <></>
          ) : (
            <Tooltip label="Copy to All">
              <ActionIcon
                color="violet"
                size="sm"
                onClick={handleCopyResource}
                loading={copyResourceMutation.isLoading}
              >
                <IconArrowFork size={16} />
              </ActionIcon>
            </Tooltip>
          )}
          {isOnSite ? (
            <></>
          ) : (
            <Tooltip label="Delete">
              <ActionIcon
                color="red"
                size="sm"
                onClick={handleRemoveResource}
                loading={removeResourceMutation.isLoading}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      )}
    </Group>
  ) : (
    <div className="flex items-center justify-between gap-3">
      <Text>
        {modelName} -{' '}
        <Text span color="dimmed" size="sm">
          {modelVersionName}
        </Text>
      </Text>
      <Group spacing={4}>
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

  const { meta, hideMeta, resourceHelper: resources } = image;

  const simpleMeta = Object.entries(simpleMetaProps).filter(([key]) => meta?.[key]);
  const hasSimpleMeta = !!simpleMeta.length;
  const resourcesSorted = sortByModelTypes(resources);

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
                        compact
                        classNames={{ label: 'flex gap-1' }}
                        size="sm"
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

          <div className={`flex w-full flex-1 flex-col gap-3 ${!showPreview ? '@sm:gap-4' : ''}`}>
            {/*
          // #region [TOS Violation]
          */}
            {isBlocked && !showPreview && <TosViolationBanner />}
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
                      compact
                      size="sm"
                      onClick={onEditMetaClick}
                      className="text-sm"
                    >
                      EDIT
                    </Button>
                    {meta?.prompt && (
                      <Button
                        variant={hideMeta ? 'filled' : 'light'}
                        color="blue"
                        compact
                        size="sm"
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
                      compact
                      size="sm"
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
            {!resources?.length && image.type === 'image' && (
              <CustomCard className="flex flex-col gap-2">
                <ResourceHeader />
                <Alert className="rounded-lg" color="yellow">
                  <Text>
                    Install the{' '}
                    <Text
                      component="a"
                      href="https://github.com/civitai/sd_civitai_extension"
                      target="_blank"
                      variant="link"
                      rel="nofollow"
                    >
                      Civitai Extension for Automatic 1111 Stable Diffusion Web UI
                    </Text>{' '}
                    to automatically detect all the resources used in your images.
                  </Text>
                </Alert>
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
                    position="right"
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
                    compact
                    size="sm"
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
                  {/* <ActionIcon variant="transparent" size="sm">
                    <IconInfoCircle />
                  </ActionIcon> */}
                </div>
                <Popover>
                  <PopoverButton
                    as={Button}
                    // @ts-ignore eslint-disable-next-line
                    variant="light"
                    color="blue"
                    compact
                    size="sm"
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
                      position="right"
                      iconProps={{ size: 20 }}
                    >
                      The thumbnail is the image that represents your post. It is the first thing
                      viewers see when they come across your post.
                    </InfoPopover>
                  </div>
                  <Button
                    className="text-sm uppercase"
                    size="sm"
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
                          height: metadata?.height ?? 1,
                          postId,
                          thumbnailFrame: metadata?.thumbnailFrame,
                        },
                      });
                    }}
                    compact
                  >
                    Select
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  {image.metadata &&
                  'thumbnailFrame' in image.metadata &&
                  image.metadata.thumbnailFrame != null ? (
                    <CurrentThumbnail
                      imageId={image.id}
                      postId={postId}
                      src={image.url}
                      thumbnailFrame={image.metadata.thumbnailFrame}
                      width={image.metadata.width}
                    />
                  ) : (
                    <Text>Thumbnail will be auto generated.</Text>
                  )}
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
            <Text align="center">Analyzing image</Text>
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
            <ActionIcon>
              <IconDotsVertical
                color="#fff"
                filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
              />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {!isBlocked && (
              <Menu.Item icon={<IconPencil size={16} />} onClick={onEditMetaClick}>
                Edit image
              </Menu.Item>
            )}
            <Menu.Item
              color="red"
              icon={<IconTrash size={16} />}
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
      <Text color="red" className="font-bold">
        TOS Violation
      </Text>
      <Text>This image has been flagged as a TOS violation.</Text>
      {blockedFor && (
        <Text className="flex flex-wrap items-center gap-1">
          <span>Blocked for:</span>
          <Text color="red" inline className="font-semibold">
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
                leftIcon={<IconArrowBackUp size={20} />}
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
          leftIcon={<IconTrash size={20} />}
        >
          Delete
        </Button>
      </div>
    </Alert>
  );
}
