import {
  ActionIcon,
  Anchor,
  AspectRatio,
  Button,
  Center,
  Checkbox,
  Divider,
  Group,
  Loader,
  Modal,
  ModalProps,
  Paper,
  Progress,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { IconInfoCircle, IconTrash } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import {
  addSimpleImagePostInput,
  bulkSaveCollectionItemsInput,
} from '~/server/schema/collection.schema';
import { ImageGetInfinite } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/server/common/mime-types';
import { truncate } from 'lodash-es';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { NextLink } from '@mantine/next';

export function AddUserContentModal({ collectionId, opened, onClose, ...props }: Props) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const selected = useStore((state) => Object.keys(state.selected).map(Number));
  const deselectAll = useStore((state) => state.deselectAll);
  const [error, setError] = useState('');

  const { files, uploadToCF, removeImage, resetFiles } = useCFImageUpload();

  const handleDropImages = async (droppedFiles: File[]) => {
    deselectAll();
    setError('');
    for (const file of droppedFiles) {
      uploadToCF(file);
    }
  };

  const handleClose = () => {
    resetFiles();
    onClose();
    deselectAll();
    setError('');
  };

  const addSimpleImagePostCollectionMutation = trpc.collection.addSimpleImagePost.useMutation();
  const handleSubmitUploads = () => {
    setError('');
    const filteredImages = files.filter((file) => file.status === 'success');
    const data = { collectionId, images: filteredImages };
    // Manually check for input errors
    const results = addSimpleImagePostInput.safeParse(data);
    if (!results.success) {
      setError('You must upload or select at least one image.');
      return;
    }

    addSimpleImagePostCollectionMutation.mutate(
      { collectionId, images: filteredImages },
      {
        onSuccess: async (data) => {
          handleClose();
          showSuccessNotification({
            autoClose: 10000, // 10s
            title: 'Your media has been successfully added to this collection.',
            message: (
              <Stack>
                <Text>
                  <Anchor href={`/posts/${data.post.id}/edit`}>Click here</Anchor> to add tags and
                  descriptions to your images.
                </Text>
              </Stack>
            ),
          });
          await queryUtils.image.getInfinite.invalidate();
          await queryUtils.collection.getById.invalidate({ id: collectionId });
          await queryUtils.collection.getAllUser.invalidate();
        },
        onError(error) {
          showErrorNotification({
            title: 'Unable to add images to collection',
            error: new Error(error.message),
          });
        },
      }
    );
  };

  const saveCollectionItemsMutation = trpc.collection.bulkSaveItems.useMutation();
  const handleSubmitExisting = () => {
    setError('');
    const data = { collectionId, imageIds: selected };
    // Manually check for input errors
    const results = bulkSaveCollectionItemsInput.safeParse(data);
    if (!results.success) {
      setError('You must upload or select at least one image');
      return;
    }

    saveCollectionItemsMutation.mutate(data, {
      onSuccess: async () => {
        handleClose();
        await queryUtils.image.getInfinite.invalidate();
      },
      onError(error) {
        showErrorNotification({
          title: 'Unable to add images to collection',
          error: new Error(error.message),
        });
      },
    });
  };

  const uploading = files.some((file) => file.status === 'uploading');
  const loading = uploading || addSimpleImagePostCollectionMutation.isLoading;

  return (
    <Modal
      {...props}
      title="Add images to collection"
      size="80%"
      opened={opened}
      onClose={handleClose}
      centered
    >
      <Stack spacing="xl">
        {error && (
          <AlertWithIcon color="red" iconColor="red" size="sm" icon={<IconInfoCircle size={16} />}>
            {error}
          </AlertWithIcon>
        )}
        <Button component={NextLink} href={`/posts/create?collection=${collectionId}`}>
          Create a new image post
        </Button>

        <Divider label="or select from your library" labelPosition="center" />
        <MasonryProvider
          columnWidth={constants.cardSizes.image}
          maxColumnCount={4}
          maxSingleColumnWidth={450}
        >
          <MasonryContainer m={0} p={0}>
            <ScrollArea.Autosize maxHeight="500px">
              {currentUser && (
                <ImagesInfinite
                  filters={{
                    collectionId: undefined,
                    username: currentUser.username,
                    period: 'AllTime',
                    sort: ImageSort.Newest,
                    hidden: undefined,
                    types: undefined,
                    withMeta: undefined,
                    followed: undefined,
                    fromPlatform: undefined,
                  }}
                  renderItem={SelectableImageCard}
                  nextPageLoaderOptions={{ root: undefined }}
                />
              )}
            </ScrollArea.Autosize>
          </MasonryContainer>
        </MasonryProvider>
        <Group
          spacing="xs"
          position="right"
          mx="-lg"
          px="lg"
          pt="lg"
          sx={(theme) => ({
            borderTop: `1px solid ${
              theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
            }`,
          })}
        >
          <Button variant="default" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            onClick={selected.length > 0 ? handleSubmitExisting : handleSubmitUploads}
            loading={loading}
          >
            Add
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

type Props = ModalProps & { collectionId: number };

function SelectableImageCard({ data: image }: { data: ImageGetInfinite[number] }) {
  const toggleSelected = useStore((state) => state.toggleSelected);
  const selected = useStore(useCallback((state) => !!state.selected[image.id], [image.id]));

  return (
    <MasonryCard
      shadow="sm"
      p={0}
      onClick={() => toggleSelected(image.id)}
      sx={{ opacity: selected ? 0.6 : 1, cursor: 'pointer' }}
      withBorder
    >
      <div style={{ position: 'relative' }}>
        <ImageGuard2 image={image}>
          {(safe) => (
            <>
              <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
              {!safe ? (
                <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                  <MediaHash {...image} />
                </AspectRatio>
              ) : (
                <EdgeMedia
                  src={image.url}
                  name={image.name ?? image.id.toString()}
                  alt={
                    image.meta
                      ? truncate(image.meta.prompt, { length: constants.altTruncateLength })
                      : image.name ?? undefined
                  }
                  type={image.type}
                  width={450}
                  placeholder="empty"
                  style={{ width: '100%' }}
                />
              )}
            </>
          )}
        </ImageGuard2>

        <Checkbox
          size="lg"
          checked={selected}
          sx={{ position: 'absolute', top: 5, right: 5 }}
          readOnly
        />
        {!image.hideMeta && image.meta && (
          <ImageMetaPopover meta={image.meta} mainResourceId={image.modelVersionId ?? undefined}>
            <ActionIcon
              variant="light"
              color="dark"
              size="lg"
              sx={{ position: 'absolute', bottom: 5, right: 5 }}
            >
              <IconInfoCircle color="white" strokeWidth={2.5} size={26} />
            </ActionIcon>
          </ImageMetaPopover>
        )}
      </div>
    </MasonryCard>
  );
}

type StoreState = {
  selected: Record<number, boolean>;
  getSelected: () => number[];
  toggleSelected: (value: number) => void;
  selectMany: (values: number[]) => void;
  deselectAll: () => void;
};

const useStore = create<StoreState>()(
  immer((set, get) => ({
    selected: {},
    getSelected: () => {
      const dict = get().selected;
      return Object.keys(dict).map(Number);
    },
    toggleSelected: (value) => {
      set((state) => {
        if (state.selected[value]) delete state.selected[value];
        else state.selected[value] = true;
      });
    },
    selectMany: (values) => {
      set((state) => {
        values.map((value) => {
          state.selected[value] = true;
        });
      });
    },
    deselectAll: () => {
      set((state) => {
        state.selected = {};
      });
    },
  }))
);
