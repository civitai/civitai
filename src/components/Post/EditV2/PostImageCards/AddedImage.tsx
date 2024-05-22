import {
  Accordion,
  ActionIcon,
  Alert,
  AspectRatio,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Menu,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { ImageIngestionStatus } from '@prisma/client';
import {
  IconArrowBackUp,
  IconChevronDown,
  IconChevronUp,
  IconDotsVertical,
  IconEye,
  IconEyeOff,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import React, { createContext, useContext, useState } from 'react';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { openSetBrowsingLevelModal } from '~/components/Dialog/dialog-registry';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UnblockImage } from '~/components/Image/UnblockImage/UnblockImage';
import { BrowsingLevelBadge } from '~/components/ImageGuard/ImageGuard2';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { AudioMetaModal, ImageMetaModal } from '~/components/Post/EditV2/ImageMetaModal';
import {
  PostEditImageDetail,
  usePostEditStore,
  usePostPreviewContext,
} from '~/components/Post/EditV2/PostEditProvider';
import { ImageToolsPopover } from '~/components/Post/EditV2/Tools/PostImageToolsPopover';
import { PostImageTool } from '~/components/Post/EditV2/Tools/PostImageTool';
import { sortAlphabeticallyBy } from '~/utils/array-helpers';
import { useImageStore } from '~/store/image.store';
import { useCurrentUserRequired } from '~/hooks/useCurrentUser';
import { CustomCard } from './CustomCard';
import { createSelectStore } from '~/store/select.store';
import { ImageTechniquesPopover } from '~/components/Post/EditV2/Techniques/PostImageTechniquesPopover';
import { PostImageTechnique } from '~/components/Post/EditV2/Techniques/PostImageTechnique';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { AudioMetadata, ImageMetadata } from '~/server/schema/media.schema';
import { formatBytes, formatDuration } from '~/utils/number-helpers';
import { useDebouncer } from '~/utils/debouncer';
import { EXTENSION_BY_MIME_TYPE } from '~/server/common/mime-types';
import { SimpleImageUpload } from '~/libs/form/components/SimpleImageUpload';

// #region [types]
type SimpleMetaPropsKey = keyof typeof simpleMetaProps;
const simpleMetaProps = {
  cfgScale: 'Guidance',
  steps: 'Steps',
  sampler: 'Sampler',
  seed: 'Seed',
  clipSkip: 'Clip skip',
} as const;
// #endregion

// #region [AddedImage context]
type State = {
  media: PostEditImageDetail;
  isBlocked: boolean;
  isScanned: boolean;
  isPending: boolean;
  onDelete: () => void;
  isDeleting: boolean;
  onEditMetaClick: () => void;
  isUpdating: boolean;
  toggleHidePrompt: () => void;
  updateTitle: (title: string) => void;
};
const AddedImageContext = createContext<State | null>(null);
const useAddedImageContext = () => {
  const context = useContext(AddedImageContext);
  if (!context) throw new Error('missing AddedImageContext ');
  return context;
};
// #endregion

// #region [AddedImage Provider]
export function AddedImage({ media }: { media: PostEditImageDetail }) {
  // #region [state]
  const { showPreview } = usePostPreviewContext();
  const storedImage = useImageStore(media);
  const [updateImage, setImages] = usePostEditStore((state) => [
    state.updateImage,
    state.setImages,
  ]);
  const debouncer = useDebouncer(1000);

  const { id, meta, blockedFor, ingestion, nsfwLevel, hideMeta, type } = storedImage;

  const isPending = ingestion === ImageIngestionStatus.Pending;
  // const isBlocked = ingestion === ImageIngestionStatus.Blocked;
  const isScanned = ingestion === ImageIngestionStatus.Scanned;
  const isBlocked = false;
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
          onConfirm: async () => await deleteImageMutation.mutateAsync({ id: media.id }),
        },
      });
    else deleteImageMutation.mutate({ id: media.id });
  };
  // #endregion

  // #region [image meta]
  const handleEditMetaClick = () => {
    dialogStore.trigger({
      component: type === 'audio' ? AudioMetaModal : ImageMetaModal,
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
    onSuccess: (_, { id, hideMeta, name }) => {
      updateImage(id, (image) => {
        image.hideMeta = hideMeta ?? false;
        image.name = name ?? image.name;
      });
    },
  });
  const toggleHidePrompt = () => {
    updateImageMutation.mutate({ id, hideMeta: !hideMeta });
  };
  // #endregion

  // #region [audio title]
  const handleUpdateTitle = (title: string) => {
    debouncer(() => {
      updateImageMutation.mutate({ id, name: title });
    });
  };
  // #endregion

  return (
    <AddedImageContext.Provider
      value={{
        media: media,
        isBlocked,
        isPending,
        isScanned,
        onDelete: handleDelete,
        isDeleting: deleteImageMutation.isLoading,
        onEditMetaClick: handleEditMetaClick,
        isUpdating: updateImageMutation.isLoading,
        toggleHidePrompt,
        updateTitle: handleUpdateTitle,
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
  const { media } = useAddedImageContext();
  const { isBlocked } = useAddedImageContext();
  const opened = store.useIsSelected(media.id);
  const value = opened ? 'edit-detail' : null;

  return (
    <div className="flex flex-col">
      {media.type === 'audio' ? <PostAudio /> : <PostImage />}
      {isBlocked && <TosViolationBanner />}
      <Accordion
        value={value}
        onChange={(value) => store.toggle(media.id, !!value)}
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

function EditDetail() {
  const [showMoreResources, setShowMoreResources] = useState(false);
  const { showPreview } = usePostPreviewContext();
  const {
    media,
    isBlocked,
    isPending,
    isScanned,
    isDeleting,
    onEditMetaClick,
    isUpdating,
    toggleHidePrompt,
    updateTitle,
  } = useAddedImageContext();

  const { meta, hideMeta, resourceHelper: resources } = media;
  const isAudio = media.type === 'audio';
  const simpleMeta = Object.entries(simpleMetaProps).filter(([key]) => meta?.[key]);
  const hasSimpleMeta = !!simpleMeta.length;

  return (
    <div className="relative @container">
      <div className={`flex flex-col gap-3 p-3  ${!showPreview ? '@sm:gap-4 @sm:p-6' : ''}`}>
        <LoadingOverlay visible={isDeleting} />
        <div
          className={`flex flex-row-reverse flex-wrap gap-3 ${
            !showPreview ? '@sm:flex-nowrap @sm:gap-6' : ''
          }`}
        >
          {/* #region [image] */}
          {(!showPreview || hasSimpleMeta) && (
            <div className={`flex w-full flex-col gap-3 ${!showPreview ? '@sm:w-4/12' : ''}`}>
              {!showPreview && (isAudio ? <PostAudio /> : <PostImage />)}
              {hasSimpleMeta && (
                <>
                  <div className="flex flex-col *:border-gray-4 not-last:*:border-b dark:*:border-dark-4">
                    {simpleMeta.map(([key, label]) => (
                      <div key={key} className="flex justify-between py-0.5">
                        <Text size="sm" weight={500}>
                          {label}
                        </Text>
                        <Text size="sm" weight={700}>
                          {meta?.[key as SimpleMetaPropsKey]}
                        </Text>
                      </div>
                    ))}
                  </div>
                  {!isBlocked && (
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
            {/* #region [TOS Violation] */}
            {isBlocked && !showPreview && <TosViolationBanner />}
            {/* #endregion */}

            {/* #region [title] */}
            {isAudio && (
              <TextInput
                label="Title"
                placeholder="Wind in the willows"
                size="md"
                radius="md"
                defaultValue={media.name ?? undefined}
                onChange={(e) => updateTitle(e.currentTarget.value)}
                withAsterisk
                required
              />
            )}
            {/* #endregion */}

            {/* #region [prompt] */}
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

            {/* #region [resources] */}
            {!isAudio && !!resources?.length && (
              <CustomCard className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                    Resources
                  </h3>
                  <InfoPopover
                    type="hover"
                    variant="transparent"
                    size="sm"
                    position="right"
                    iconProps={{ size: 20 }}
                  >
                    Models, LoRAs, embeddings or other Stable Diffusion specific resources used to
                    create this image.
                  </InfoPopover>
                </div>
                {resources
                  .filter((x) => !!x.modelName)
                  .slice(0, !showMoreResources ? 3 : resources.length)
                  .map((resource, i) => (
                    <div key={i} className="flex items-center justify-between gap-3">
                      <Text>
                        {resource.modelName} - {resource.modelType}
                      </Text>
                      <Badge color="gray" size="md" variant="filled">
                        {resource.modelVersionName}
                      </Badge>
                    </div>
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

            {/* #region [missing resources] */}
            {!isAudio && !resources?.length && (
              <Alert className="rounded-lg" color="yellow">
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                      Resources
                    </h3>
                    <InfoPopover
                      type="hover"
                      variant="transparent"
                      size="sm"
                      position="right"
                      iconProps={{ size: 20 }}
                    >
                      Models, LoRAs, embeddings or other Stable Diffusion specific resources used to
                      create this image.
                    </InfoPopover>
                  </div>
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
                </div>
              </Alert>
            )}
            {/* #endregion */}

            {/* #region [tools] */}
            <CustomCard className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                    Tools
                  </h3>
                  <InfoPopover
                    type="hover"
                    variant="transparent"
                    size="sm"
                    position="right"
                    iconProps={{ size: 20 }}
                  >
                    Traditional or generative AI programs, platforms or websites used to create this
                    image.
                  </InfoPopover>
                </div>
                <ImageToolsPopover image={media}>
                  <Button
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
                  </Button>
                </ImageToolsPopover>
              </div>
              {!!media.tools?.length && (
                <ul className="flex flex-col">
                  {sortAlphabeticallyBy([...media.tools], (x) => x.name).map((tool, index) => (
                    <li key={tool.id} className="list-none">
                      {index !== 0 && <Divider />}
                      <PostImageTool image={media} tool={tool} />
                    </li>
                  ))}
                </ul>
              )}
            </CustomCard>
            {/* #endregion */}

            {/* #region [techniques] */}
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
                <ImageTechniquesPopover image={media}>
                  <Button
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
                  </Button>
                </ImageTechniquesPopover>
              </div>
              {!!media.techniques.length && (
                <ul className="flex flex-col">
                  {sortAlphabeticallyBy([...media.techniques], (x) => x.name).map(
                    (technique, index) => (
                      <li key={technique.id} className="list-none">
                        {index !== 0 && <Divider />}
                        <PostImageTechnique image={media} technique={technique} />
                      </li>
                    )
                  )}
                </ul>
              )}
            </CustomCard>
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

        {/* #region [tags] */}
        {(!!media.tags?.length || isScanned) && (
          <>
            <Divider />
            <VotableTags
              entityId={media.id}
              entityType="image"
              tags={!!media.tags.length ? media.tags : undefined}
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
        {/* #endregion */}
      </div>
    </div>
  );
}

function PostImage() {
  const { showPreview } = usePostPreviewContext();
  const { media, isBlocked, onDelete, isDeleting, onEditMetaClick } = useAddedImageContext();
  const { url, type, id, nsfwLevel } = media;
  const metadata = media.metadata as ImageMetadata | null | undefined;

  return (
    <div className="relative">
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
          width={metadata?.width ?? 450}
          type={type}
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

function PostAudio() {
  const { showPreview } = usePostPreviewContext();
  const { media, onDelete, isDeleting } = useAddedImageContext();
  const metadata = media.metadata as AudioMetadata | null | undefined;

  return (
    <Stack spacing="sm" p={showPreview ? 'md' : undefined}>
      <Paper
        p={8}
        radius="md"
        sx={(theme) => ({
          position: 'relative',
          backgroundColor: theme.fn.rgba(theme.colors.blue[7], 0.2),
          borderColor: theme.colors.blue[7],
        })}
        withBorder
      >
        <Stack spacing={8}>
          <Group position="right">
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
                <Menu.Item
                  color="red"
                  icon={<IconTrash size={16} />}
                  onClick={onDelete}
                  disabled={isDeleting}
                >
                  Delete audio
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
          {/* <SimpleImageUpload w="100%" h="100%" /> */}
          <EdgeMedia src={media.url} type={media.type} duration={metadata?.duration} />
        </Stack>
      </Paper>
      <Stack spacing={4}>
        {metadata && (
          <>
            <Group position="apart" noWrap>
              <Text weight={500} color="dimmed" size="sm">
                Duration
              </Text>
              <Text weight={700} size="sm">
                {formatDuration(metadata.duration)}
              </Text>
            </Group>
            <Divider />
            <Group position="apart" noWrap>
              <Text weight={500} color="dimmed" size="sm">
                Size
              </Text>
              <Text weight={700} size="sm">
                {formatBytes(metadata.size ?? 0)}
              </Text>
            </Group>
          </>
        )}
        {media.mimeType && (
          <>
            <Divider />
            <Group position="apart" noWrap>
              <Text weight={500} color="dimmed" size="sm">
                Format
              </Text>
              <Text weight={700} size="sm" tt="uppercase">
                {EXTENSION_BY_MIME_TYPE[media.mimeType]}
              </Text>
            </Group>
          </>
        )}
      </Stack>
    </Stack>
  );
}

function TosViolationBanner() {
  const currentUser = useCurrentUserRequired();
  const { media, onDelete, isDeleting } = useAddedImageContext();
  const { blockedFor, id } = media;
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
