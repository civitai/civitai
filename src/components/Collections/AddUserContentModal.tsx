import {
  ActionIcon,
  Anchor,
  AspectRatio,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  ModalProps,
  ScrollArea,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconInfoCircle } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
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
import { useCollection } from './collection.utils';
import { ScrollArea as ScrollAreaProvider } from '~/components/ScrollArea/ScrollArea';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

export function AddUserContentModal({ collectionId }: Props) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const { collection } = useCollection(collectionId);
  const selected = useStore((state) => Object.keys(state.selected).map(Number));
  const deselectAll = useStore((state) => state.deselectAll);
  const [error, setError] = useState('');
  const [tagId, setTagId] = useState<number | null>(null);

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
    dialog.onClose();
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
    const data = { collectionId, imageIds: selected, tagId };
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
    <Modal {...dialog} title="Add images to collection" size="80%" onClose={handleClose} centered>
      <Stack spacing="xl">
        {error && (
          <AlertWithIcon color="red" iconColor="red" size="sm" icon={<IconInfoCircle size={16} />}>
            {error}
          </AlertWithIcon>
        )}

        <Button component={Link} href={`/posts/create?collectionId=${collectionId}`}>
          Create a new image post
        </Button>

        <Divider label="or select from your library" labelPosition="center" />
        <ScrollAreaProvider>
          <ScrollArea.Autosize maxHeight="500px">
            <MasonryProvider
              columnWidth={constants.cardSizes.image}
              maxColumnCount={4}
              maxSingleColumnWidth={450}
            >
              <MasonryContainer m={0} p={0} px={0}>
                <ImagesInfinite
                  filters={{
                    collectionId: undefined,
                    userId: currentUser?.id,
                    period: 'AllTime',
                    sort: ImageSort.Newest,
                    hidden: undefined,
                    types: undefined,
                    withMeta: undefined,
                    followed: undefined,
                    fromPlatform: undefined,
                  }}
                  renderItem={SelectableImageCard}
                />
              </MasonryContainer>
            </MasonryProvider>
          </ScrollArea.Autosize>
        </ScrollAreaProvider>
        {(collection?.tags?.length ?? 0) > 0 && (
          <Select
            label="Please select what category of the contest you are participating in."
            withAsterisk
            placeholder="Select a category for your submission"
            data={(collection?.tags ?? []).map((tag) => ({
              value: tag.id.toString(),
              label: tag.name,
            }))}
            onChange={(value) => setTagId(value ? Number(value) : null)}
            value={tagId?.toString() ?? null}
            clearable
          />
        )}
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

type Props = { collectionId: number };

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
                  alt={image.name ?? undefined}
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
        {image.hasMeta && (
          <div className="absolute bottom-0.5 right-0.5 z-10">
            <ImageMetaPopover2 imageId={image.id} type={image.type}>
              <ActionIcon variant="light" color="dark" size="lg">
                <IconInfoCircle color="white" strokeWidth={2.5} size={26} />
              </ActionIcon>
            </ImageMetaPopover2>
          </div>
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
