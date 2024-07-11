import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Loader,
  LoadingOverlay,
  Menu,
  Text,
  Tooltip,
  Anchor,
} from '@mantine/core';
import { CollectionMode, ImageIngestionStatus } from '@prisma/client';
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
  IconX,
} from '@tabler/icons-react';
import React, { createContext, useContext, useState } from 'react';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { openSetNsfwLevelModal } from '~/components/Dialog/dialog-registry';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UnblockImage } from '~/components/Image/UnblockImage/UnblockImage';
import { BrowsingLevelBadge } from '~/components/ImageGuard/ImageGuard2';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { ImageMetaModal } from '~/components/Post/EditV2/ImageMetaModal';
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
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import { useCollectionsForPostEditor } from '~/components/Post/EditV2/Collections/CollectionSelectDropdown';
import { Flags } from '~/shared/utils';
import { graphicBrowsingLevels } from '~/shared/constants/browsingLevel.constants';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { Dropzone, FileWithPath } from '@mantine/dropzone';
import { IconUpload } from '@tabler/icons-react';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getMetadata } from '~/utils/metadata';
import { constants } from '~/server/common/constants';
import { auditMetaData } from '~/utils/metadata/audit';
import { ComfyNodes } from '~/components/ImageMeta/ImageMeta';
import { isEmpty } from 'lodash-es';
import { calculateSizeInMegabytes } from '~/utils/json-helpers';

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
  image: PostEditImageDetail;
  isBlocked: boolean;
  isScanned: boolean;
  isPending: boolean;
  onDelete: () => void;
  isDeleting: boolean;
  onEditMetaClick: () => void;
  isUpdating: boolean;
  toggleHidePrompt: () => void;
  updateImageMeta: (meta: ImageMetaProps) => Promise<any>;
};
const AddedImageContext = createContext<State | null>(null);
const useAddedImageContext = () => {
  const context = useContext(AddedImageContext);
  if (!context) throw new Error('missing AddedImageContext ');
  return context;
};
// #endregion

// #region [AddedImage Provider]
export function AddedImage({ image }: { image: PostEditImageDetail }) {
  // #region [state]
  const { showPreview } = usePostPreviewContext();
  const storedImage = useImageStore(image);

  const [updateImage, setImages] = usePostEditStore((state) => [
    state.updateImage,
    state.setImages,
  ]);

  const { id, meta, blockedFor, ingestion, nsfwLevel, hideMeta } = storedImage;

  const isPending = ingestion === ImageIngestionStatus.Pending;
  // const isBlocked = ingestion === ImageIngestionStatus.Blocked;
  const isScanned = ingestion === ImageIngestionStatus.Scanned;
  const isBlocked = false;
  // #endregion

  // #region [delete image]
  const deleteImageMutation = trpc.image.delete.useMutation({
    onSuccess: (_, { id }) =>
      setImages((state) => state.filter((x) => x.type !== 'added' || x.data.id !== id)),
    onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
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
    onSuccess: (result, { id, hideMeta, meta }) => {
      updateImage(id, (image) => {
        image.hideMeta = hideMeta ?? false;
        image.meta = (meta as ImageMetaProps) ?? image.meta;
        image.hidden = result.hidden ?? null;
      });
    },
  });
  const toggleHidePrompt = () => {
    updateImageMutation.mutate({ id, hideMeta: !hideMeta });
  };

  const updateImageMeta = (meta: ImageMetaProps) => {
    return updateImageMutation.mutateAsync({ id, meta });
  };
  // #endregion

  return (
    <AddedImageContext.Provider
      value={{
        image,
        isBlocked,
        isPending,
        isScanned,
        onDelete: handleDelete,
        isDeleting: deleteImageMutation.isLoading,
        onEditMetaClick: handleEditMetaClick,
        isUpdating: updateImageMutation.isLoading,
        toggleHidePrompt,
        updateImageMeta,
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
      <HiddenImageBanner />
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

function EditDetail() {
  const [showMoreResources, setShowMoreResources] = useState(false);
  const { showPreview } = usePostPreviewContext();
  const {
    image,
    isBlocked,
    isPending,
    isScanned,
    isDeleting,
    onEditMetaClick,
    isUpdating,
    toggleHidePrompt,
  } = useAddedImageContext();
  const { activeCollection } = useCollectionsForPostEditor();

  const { meta, hideMeta, resourceHelper: resources, nsfwLevel } = image;
  const simpleMeta = Object.entries(simpleMetaProps).filter(([key]) => meta?.[key]);
  const hasSimpleMeta = !!simpleMeta.length;
  const disableHideMeta = !!meta?.prompt && Flags.intersects(nsfwLevel, graphicBrowsingLevels);

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

            {/* #region [Hidden Image] */}
            {!showPreview && <HiddenImageBanner />}
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
                      <Tooltip
                        label="Graphic images without the educational and scientific information provided by metadata is prohibited"
                        width={300}
                        disabled={!disableHideMeta}
                        withinPortal
                        multiline
                      >
                        {/* div is required to display the tooltip when button is disabled */}
                        <div>
                          <Button
                            variant={hideMeta ? 'filled' : 'light'}
                            color="blue"
                            compact
                            size="sm"
                            classNames={{ label: 'flex gap-1 text-sm' }}
                            onClick={toggleHidePrompt}
                            loading={isUpdating}
                            disabled={disableHideMeta}
                          >
                            {hideMeta ? <IconEye size={16} /> : <IconEyeOff size={16} />}
                            <span>{hideMeta ? 'SHOW' : 'HIDE'} PROMPT</span>
                          </Button>
                        </div>
                      </Tooltip>
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
            {!!resources?.length && (
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
            {!resources?.length && (
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

            {activeCollection?.mode === CollectionMode.Contest && (
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
            )}

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

            {/* #region [comfy workflow] */}
            {image.type === 'video' && <ComfyWorkflowCard />}
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
          width={metadata?.width ?? 450}
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
          onClick={!isBlocked ? () => openSetNsfwLevelModal({ imageId: id, nsfwLevel }) : undefined}
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

function HiddenImageBanner() {
  const { image } = useAddedImageContext();
  const { showPreview } = usePostPreviewContext();
  const { hidden, meta } = image;

  if (!hidden || !!meta?.prompt) return null;

  return (
    <Alert
      color="yellow"
      className={`p-3 @container ${showPreview ? 'rounded-none' : 'rounded-lg'}`}
      classNames={{ message: 'flex flex-col items-center justify-center' }}
    >
      {hidden === 'MissingMetadata' ? (
        <>
          <Text color="yellow" className="font-bold">
            Missing educational information
          </Text>
          <Text>
            Your image has been detected to include graphic content. Per our{' '}
            <Anchor href="/content/tos" target="_blank" rel="nofollow noreferrer">
              ToS
            </Anchor>
            , graphic content on Civitai is required to have artistic, educational or scientific
            value. To have your image appear please include metadata. If your image has been marked
            as graphic content in error, please change the rating and a moderator will review your
            image shortly.
          </Text>
        </>
      ) : (
        <>
          <Text color="yellow" className="font-bold">
            Content hidden
          </Text>
          <Text>
            Your image won&apos;t show up in the feed because it&apos;s marked as graphic content.
            If your image has been marked as graphic content in error, please change the rating and
            a moderator will review your image shortly.
          </Text>
        </>
      )}
    </Alert>
  );
}

function ComfyWorkflowCard() {
  const { image, updateImageMeta } = useAddedImageContext();

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleDrop = async (files: FileWithPath[]) => {
    setError(null);
    const [file] = files;

    const meta = await getMetadata(file).catch(() => undefined);
    const result = auditMetaData(meta, true);

    if (!isEmpty(meta) && meta.comfy && result.success) {
      const comfyFieldSize = calculateSizeInMegabytes(meta.comfy);
      if (comfyFieldSize > 1) {
        setError('Comfy metadata is too large. Please consider updating your workflow');
        return;
      }

      setLoading(true);
      await updateImageMeta(meta);
      setLoading(false);
    } else {
      const { blockedFor } = result;
      const message = blockedFor.length
        ? `Blocked for: ${blockedFor.join(', ')}`
        : 'An unexpected error occurred';

      setError(message);
    }
  };

  return (
    <CustomCard className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
          Comfy Workflow
        </h3>
        {image.meta && <ComfyNodes meta={image.meta} />}
      </div>
      <Dropzone
        accept={IMAGE_MIME_TYPE}
        maxFiles={1}
        maxSize={constants.mediaUpload.maxImageFileSize}
        onDrop={handleDrop}
        className={error ? 'border-red-9' : ''}
        loading={loading}
      >
        <Dropzone.Idle>
          <div className="flex items-center justify-center gap-2">
            <IconPlus size={24} />
            <Text>Upload the image output from your comfy workflow</Text>
          </div>
        </Dropzone.Idle>
        <Dropzone.Reject>
          <div className="flex items-center justify-center gap-2">
            <IconX size={24} />
            <Text>Not allowed</Text>
          </div>
        </Dropzone.Reject>
        <Dropzone.Accept>
          <div className="flex items-center justify-center gap-2">
            <IconUpload size={24} />
            <Text>Drop image here</Text>
          </div>
        </Dropzone.Accept>
      </Dropzone>
      {error && (
        <Text color="red" size="xs">
          {error}
        </Text>
      )}
    </CustomCard>
  );
}
