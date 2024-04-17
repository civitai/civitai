import { ActionIcon, Alert, Badge, Button, Divider, Menu, Text } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { PostDetailEditable } from '~/server/services/post.service';
import React, { useState } from 'react';
import { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import {
  IconChevronDown,
  IconChevronUp,
  IconDotsVertical,
  IconEyeOff,
  IconInfoCircle,
  IconPencil,
  IconTrash,
} from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ImageMetaModal } from '~/components/Post/EditV2/ImageMetaModal';
import { usePostImagesContext } from '~/components/Post/EditV2/PostImagesProvider';

type ControlledImage = Partial<PostDetailEditable['images'][number]> & MediaUploadOnCompleteProps;

export function PostImageCards() {
  const images = usePostImagesContext((state) => state.images);
  if (!images.length) return null;
  return (
    <div className="flex flex-col gap-3 ">
      {[...images]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((image) => (
          <PostImageCard key={image.url} image={image} />
        ))}
    </div>
  );
}

type SimpleMetaPropsKey = keyof typeof simpleMetaProps;
const simpleMetaProps = {
  cfgScale: 'Guidance',
  steps: 'Steps',
  sampler: 'Sampler',
  seed: 'Seed',
} as const;
function PostImageCard({ image }: { image: ControlledImage }) {
  const setImages = usePostImagesContext((state) => state.setImages);
  const updateImage = usePostImagesContext((state) => state.updateImage);

  const [showMoreResources, setShowMoreResources] = useState(false);
  const resources = image.resourceHelper?.filter((x) => x.modelId);

  // #region [delete image]
  const deleteImageMutation = trpc.image.delete.useMutation({
    onSuccess: (_, { id }) => setImages((state) => state.filter((x) => x.id !== id)),
    onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
  });

  const handleDelete = () => {
    const id = image.id;
    id
      ? dialogStore.trigger({
          component: ConfirmDialog,
          props: {
            title: 'Delete image',
            message: 'Are you sure you want to delete this image?',
            labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
            confirmProps: { color: 'red', loading: deleteImageMutation.isLoading },
            onConfirm: async () => await deleteImageMutation.mutateAsync({ id }),
          },
        })
      : setImages((state) => state.filter((x) => x.url !== image.url));
  };
  // #endregion

  // #region [image meta]
  const handleEditMetaClick = () => {
    const { id, meta, nsfwLevel, blockedFor } = image;
    if (!!id)
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
  // #endregion

  return (
    <div className="bg-gray-0 dark:bg-dark-8 border border-gray-1 dark:border-dark-6 rounded-lg p-3 flex flex-col gap-3">
      <div className="flex flex-row-reverse flex-wrap md:flex-nowrap gap-3">
        <div className="flex flex-col gap-3 w-full md:w-4/12">
          {/*
         // #region [image]
         */}
          <div className="relative">
            <div style={{ aspectRatio: `${image.metadata.width}/${image.metadata.height}` }}>
              <EdgeMedia
                src={image.url}
                width={450}
                type={image.type}
                className="rounded-lg mx-auto"
              />
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
          {image.meta && (
            <>
              <div className="flex flex-col not-last:*:border-b *:border-gray-4 dark:*:border-dark-4">
                {Object.entries(simpleMetaProps)
                  .filter(([key]) => image.meta?.[key])
                  .map(([key, label]) => (
                    <div key={key} className="flex justify-between py-0.5">
                      <Text>{label}</Text>
                      <Text>{image.meta?.[key as SimpleMetaPropsKey]}</Text>
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
                >
                  <IconPencil size={16} />
                  <span>Edit</span>
                </Button>
              </div>
            </>
          )}
          {/* #endregion */}
        </div>

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
                  >
                    Edit
                  </Button>
                  {image.meta?.prompt && (
                    <Button
                      variant="light"
                      color="blue"
                      compact
                      size="md"
                      classNames={{ label: 'flex gap-1' }}
                    >
                      <IconEyeOff size={16} />
                      <span>Hide Prompt</span>
                    </Button>
                  )}
                </div>
              </div>
              {image.meta?.prompt && (
                <Text className="leading-5 line-clamp-3 ">{image.meta.prompt}</Text>
              )}
              {image.meta?.negativePrompt && (
                <>
                  <Divider />
                  <h3 className=" text-lg font-semibold leading-none text-dark-7 dark:text-gray-0 ">
                    Negative Prompt
                  </h3>
                  <Text className="leading-5 line-clamp-3">{image.meta.negativePrompt}</Text>
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
        </div>
      </div>

      {/*
       // #region [tags]
       */}
      {image.id && !!image.tags?.length && (
        <>
          <Divider />
          <VotableTags entityId={image.id} entityType="image" tags={image.tags} />
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
