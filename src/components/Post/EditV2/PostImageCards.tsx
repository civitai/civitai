import { ActionIcon, Alert, Badge, Button, Divider, Menu, Text } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import React, { useState } from 'react';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import {
  IconChevronDown,
  IconChevronUp,
  IconDotsVertical,
  IconEyeOff,
  IconInfoCircle,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ImageMetaModal } from '~/components/Post/EditV2/ImageMetaModal';
import { ControlledImage, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { ImageToolsPopover } from '~/components/Post/EditV2/PostImageToolsPopover';
import { PostImageTool } from '~/components/Post/EditV2/PostImageTool';
import { sortAlphabeticallyBy } from '~/utils/array-helpers';

// #region [types]
type SimpleMetaPropsKey = keyof typeof simpleMetaProps;
const simpleMetaProps = {
  cfgScale: 'Guidance',
  steps: 'Steps',
  sampler: 'Sampler',
  seed: 'Seed',
} as const;
// #endregion

export function PostImageCards() {
  const images = usePostEditStore((state) =>
    [...state.images].sort((a, b) => (a.data.index ?? 0) - (b.data.index ?? 0))
  );
  if (!images.length) return null;
  return (
    <div className="flex flex-col gap-3 ">
      {images.map((image) => (
        <PostImageCard key={image.data.url} image={image} />
      ))}
    </div>
  );
}

function PostImageCard({ image }: { image: ControlledImage }) {
  const [showMoreResources, setShowMoreResources] = useState(false);
  const [setImages, updateImage] = usePostEditStore((state) => [
    state.setImages,
    state.updateImage,
  ]);

  const { metadata, type, url } = image.data;
  const resources =
    image.type === 'added' ? image.data.resourceHelper?.filter((x) => x.modelId) : undefined;
  const meta = image.type === 'added' ? image.data.meta : undefined;

  // #region [delete image]
  const deleteImageMutation = trpc.image.delete.useMutation({
    onSuccess: (_, { id }) =>
      setImages((state) => state.filter((x) => x.type === 'blocked' || x.data.id !== id)),
    onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
  });

  const handleDelete = () => {
    if (image.type === 'added') {
      dialogStore.trigger({
        component: ConfirmDialog,
        props: {
          title: 'Delete image',
          message: 'Are you sure you want to delete this image?',
          labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
          confirmProps: { color: 'red', loading: deleteImageMutation.isLoading },
          onConfirm: async () => await deleteImageMutation.mutateAsync({ id: image.data.id }),
        },
      });
    } else {
      setImages((state) => state.filter((x) => x.data.url !== image.data.url));
    }
  };
  // #endregion

  // #region [image meta]
  const handleEditMetaClick = () => {
    if (image.type === 'added') {
      const { id, meta, nsfwLevel, blockedFor } = image.data;
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
    }
  };
  // #endregion

  return (
    <div className="bg-gray-0 dark:bg-dark-8 border border-gray-1 dark:border-dark-6 rounded-lg p-3 flex flex-col gap-3">
      <div className="flex flex-row-reverse flex-wrap md:flex-nowrap gap-3">
        {/*
         // #region [image]
         */}
        <div className="flex flex-col gap-3 w-full md:w-4/12">
          <div className="relative">
            {/* TODO - ensure that metadata width/height always have value */}
            <div style={{ aspectRatio: `${metadata.width}/${metadata.height}` }}>
              <EdgeMedia src={url} width={450} type={type} className="rounded-lg mx-auto" />
            </div>
            <Menu withArrow>
              <Menu.Target>
                <ActionIcon className="absolute top-2 right-2">
                  <IconDotsVertical
                    color="#fff"
                    filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                  />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item icon={<IconPencil size={16} />} onClick={handleEditMetaClick}>
                  Edit image
                </Menu.Item>
                <Menu.Item
                  color="red"
                  icon={<IconTrash size={16} />}
                  onClick={handleDelete}
                  disabled={deleteImageMutation.isLoading}
                >
                  Delete image
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>
          {meta && (
            <>
              <div className="flex flex-col not-last:*:border-b *:border-gray-4 dark:*:border-dark-4">
                {Object.entries(simpleMetaProps)
                  .filter(([key]) => meta?.[key])
                  .map(([key, label]) => (
                    <div key={key} className="flex justify-between py-0.5">
                      <Text>{label}</Text>
                      <Text>{meta?.[key as SimpleMetaPropsKey]}</Text>
                    </div>
                  ))}
              </div>
              <div>
                <Button
                  variant="light"
                  color="blue"
                  compact
                  classNames={{ label: 'flex gap-1' }}
                  size="md"
                  onClick={handleEditMetaClick}
                  className="text-sm"
                >
                  <IconPencil size={16} />
                  <span>EDIT</span>
                </Button>
              </div>
            </>
          )}
        </div>
        {/* #endregion */}

        <div className="flex flex-col gap-3 w-full md:w-8/12">
          {/*
         // #region [prompt]
         */}

          <CustomCard className="flex flex-col">
            <div className="flex flex-col gap-3">
              <div className="flex justify-between items-center">
                <h3 className="text-xl font-semibold leading-none text-dark-7 dark:text-gray-0">
                  Prompt
                </h3>
                <div className="flex gap-1">
                  <Button
                    variant="light"
                    color="blue"
                    compact
                    size="md"
                    onClick={handleEditMetaClick}
                    className="text-sm"
                  >
                    EDIT
                  </Button>
                  {meta?.prompt && (
                    <Button
                      variant="light"
                      color="blue"
                      compact
                      size="md"
                      classNames={{ label: 'flex gap-1 text-sm' }}
                    >
                      <IconEyeOff size={16} />
                      <span>HIDE PROMPT</span>
                    </Button>
                  )}
                </div>
              </div>
              {meta?.prompt && <Text className="leading-5 line-clamp-3 ">{meta.prompt}</Text>}
              {meta?.negativePrompt && (
                <>
                  <Divider />
                  <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                    Negative Prompt
                  </h3>
                  <Text className="leading-5 line-clamp-3">{meta.negativePrompt}</Text>
                </>
              )}
            </div>
          </CustomCard>

          {/* #endregion */}

          {/*
          // #region [resources]
          */}
          {!!resources?.length && (
            <CustomCard className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                  Resources
                </h3>
                <ActionIcon variant="transparent" size="sm">
                  <IconInfoCircle />
                </ActionIcon>
              </div>
              {resources.slice(0, !showMoreResources ? 3 : resources.length).map((resource, i) => (
                <div key={i} className="flex justify-between items-center gap-3">
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
                    size="md"
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
            <Alert className="rounded-lg" color="yellow">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                    Resources
                  </h3>
                  <ActionIcon variant="transparent" size="sm">
                    <IconInfoCircle />
                  </ActionIcon>
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

          {/*
           // #region [tools]
           */}
          {image.type === 'added' && (
            <CustomCard className="flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                    Tools
                  </h3>
                  <ActionIcon variant="transparent" size="sm">
                    <IconInfoCircle />
                  </ActionIcon>
                </div>
                <ImageToolsPopover image={image.data}>
                  <Button
                    variant="light"
                    color="blue"
                    compact
                    size="md"
                    classNames={{ label: 'flex gap-1' }}
                    onClick={() => undefined}
                    className="text-sm"
                  >
                    <IconPlus size={16} />
                    <span>TOOL</span>
                  </Button>
                </ImageToolsPopover>
              </div>
              {!!image.data.tools.length && (
                <ul className="flex flex-col">
                  {sortAlphabeticallyBy([...image.data.tools], (x) => x.name).map((tool, index) => (
                    <li key={tool.id} className="list-none">
                      {index !== 0 && <Divider />}
                      <PostImageTool image={image.data} tool={tool} />
                    </li>
                  ))}
                </ul>
              )}
            </CustomCard>
          )}
          {/* #endregion */}
        </div>
      </div>

      {/*
       // #region [tags]
       */}
      {image.type === 'added' && image.data.id && !!image.data.tags?.length && (
        <>
          <Divider />
          <VotableTags entityId={image.data.id} entityType="image" tags={image.data.tags} />
        </>
      )}
      {/* #endregion */}
    </div>
  );
}

// #region [Custom Card]
function CustomCard({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`p-3 bg-gray-1 dark:bg-dark-6 rounded-lg border border-gray-2 dark:border-dark-5 ${className}`}
    >
      {children}
    </div>
  );
}
// #endregion
