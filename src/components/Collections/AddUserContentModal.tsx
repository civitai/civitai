import {
  Button,
  Divider,
  Group,
  Modal,
  ModalProps,
  Paper,
  Progress,
  ScrollArea,
  SimpleGrid,
  Stack,
} from '@mantine/core';
import { useState } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { useImageQueryParams } from '~/components/Image/image.utils';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

export function AddUserContentModal({ collectionId, opened, onClose, ...props }: Props) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();
  const clear = useStore((state) => state.clearSelectedImages);
  const { files, uploadToCF } = useCFImageUpload();

  const { query } = useImageQueryParams();

  const handleDropImages = async (droppedFiles: File[]) => {
    await Promise.all(droppedFiles.map((file) => uploadToCF(file)));
  };

  const handleClose = () => {
    onClose();
    clear();
  };

  const addSimpleImagePostCollectionMutation = trpc.collection.addSimpleImagePost.useMutation();
  const handleSubmit = () => {
    const filteredImages = files
      .filter((file) => file.status === 'success')
      .map(({ id, url, ...file }) => ({ ...file, url: id }));

    addSimpleImagePostCollectionMutation.mutate(
      { collectionId, images: filteredImages },
      {
        onSuccess: async () => {
          await queryUtils.image.getInfinite.invalidate({ collectionId });
          handleClose();
        },
      }
    );
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
    >
      <Stack spacing="xl">
        <ImageDropzone
          label="Drop or click to select your images to add to this collection"
          onDrop={handleDropImages}
        />
        {files.length > 0 ? (
          <SimpleGrid
            spacing="sm"
            breakpoints={[
              { minWidth: 'xs', cols: 1 },
              { minWidth: 'sm', cols: 2 },
              { minWidth: 'md', cols: 3 },
            ]}
          >
            {files.map((file) => (
              <Paper
                key={file.id}
                radius="sm"
                p={0}
                sx={{ position: 'relative', overflow: 'hidden', height: 332 }}
                withBorder
              >
                {file.status === 'success' ? (
                  <EdgeImage
                    placeholder="empty"
                    src={file.id}
                    alt={file.name ?? undefined}
                    style={{ objectFit: 'cover', height: '100%' }}
                  />
                ) : (
                  <>
                    <MediaHash {...file} />
                    <Progress
                      size="xl"
                      value={file.progress}
                      label={`${Math.floor(file.progress)}%`}
                      color={file.progress < 100 ? 'blue' : 'green'}
                      striped
                      animate
                    />
                  </>
                )}
              </Paper>
            ))}
          </SimpleGrid>
        ) : (
          <>
            <Divider label="or select from your library" labelPosition="center" />
            <MasonryProvider
              columnWidth={constants.cardSizes.image}
              maxColumnCount={4}
              maxSingleColumnWidth={450}
            >
              <MasonryContainer fluid>
                {currentUser && (
                  <ImagesInfinite
                    filters={{
                      ...query,
                      username: currentUser.username,
                      period: 'AllTime',
                      sort: ImageSort.Newest,
                    }}
                  />
                )}
                {/* <ScrollArea.Autosize maxHeight="calc(100vh - 200px)">
            </ScrollArea.Autosize> */}
              </MasonryContainer>
            </MasonryProvider>
          </>
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
          <Button onClick={handleSubmit} loading={loading}>
            Add
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

type Props = ModalProps & { collectionId: number };

type Store = {
  selectedImages: number[];
  setSelectedImages: (ids: number[]) => void;
  clearSelectedImages: () => void;
};

const useStore = create<Store>()(
  immer((set) => ({
    selectedImages: [],
    setSelectedImages: (ids) =>
      set((state) => {
        state.selectedImages = ids;
      }),
    clearSelectedImages: () =>
      set((state) => {
        state.selectedImages = [];
      }),
  }))
);
