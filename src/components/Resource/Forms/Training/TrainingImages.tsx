import {
  ActionIcon,
  Button,
  Center,
  Checkbox,
  createStyles,
  Group,
  Image,
  Loader,
  Pagination,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { FileWithPath } from '@mantine/dropzone';
import { openConfirmModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import { showNotification, updateNotification } from '@mantine/notifications';
import { ModelFileVisibility } from '@prisma/client';
import { IconAlertTriangle, IconCheck, IconTrash, IconX } from '@tabler/icons-react'; // import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import { isEqual } from 'lodash-es';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { goBack, goNext } from '~/components/Resource/Forms/Training/TrainingCommon';
import { UploadType } from '~/server/common/enums';
import { IMAGE_MIME_TYPE, ZIP_MIME_TYPE } from '~/server/common/mime-types';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { TrainingModelData } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { bytesToKB } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type ImageDataType = {
  url: string;
  name: string;
  type: string;
  caption: string;
};

type UpdateImageDataType = Partial<Omit<ImageDataType, 'url'>> & { url: string };

type TrainingDataState = {
  imageList: ImageDataType[];
  initialImageList: ImageDataType[];
  ownRights: boolean;
  initialOwnRights: boolean;
  shareDataset: boolean;
  initialShareDataset: boolean;
};

type ImageStore = {
  [id: number]: TrainingDataState | undefined;
  updateImage: (modelId: number, data: UpdateImageDataType) => void;
  setImageList: (modelId: number, data: ImageDataType[]) => void;
  setInitialImageList: (modelId: number, data: ImageDataType[]) => void;
  setOwnRights: (modelId: number, data: boolean) => void;
  setShareDataset: (modelId: number, data: boolean) => void;
  setInitialOwnRights: (modelId: number, data: boolean) => void;
  setInitialShareDataset: (modelId: number, data: boolean) => void;
};

export const useImageStore = create<ImageStore>()(
  immer((set) => ({
    imageList: [],
    initialImageList: [],
    ownRights: false,
    shareDataset: false,
    initialOwnRights: false,
    initialShareDataset: false,
    updateImage: (modelId, { url, name, type, caption }) => {
      set((state) => {
        if (!state[modelId])
          state[modelId] = {
            imageList: [],
            initialImageList: [],
            ownRights: false,
            shareDataset: false,
            initialOwnRights: false,
            initialShareDataset: false,
          };
        // TODO [bw] why is this not understanding the override I just did above?
        state[modelId]!.imageList = state[modelId]!.imageList.map((i) => {
          if (i.url === url) {
            return {
              url,
              name: name ?? i.name,
              type: type ?? i.type,
              caption: caption ?? i.caption,
            };
          }
          return i;
        });
      });
    },
    setImageList: (modelId, imgData) => {
      set((state) => {
        if (!state[modelId])
          state[modelId] = {
            imageList: [],
            initialImageList: [],
            ownRights: false,
            shareDataset: false,
            initialOwnRights: false,
            initialShareDataset: false,
          };
        state[modelId]!.imageList = imgData;
      });
    },
    setInitialImageList: (modelId, imgData) => {
      set((state) => {
        if (!state[modelId])
          state[modelId] = {
            imageList: [],
            initialImageList: [],
            ownRights: false,
            shareDataset: false,
            initialOwnRights: false,
            initialShareDataset: false,
          };
        state[modelId]!.initialImageList = imgData;
      });
    },
    setOwnRights: (modelId, v) => {
      set((state) => {
        if (!state[modelId])
          state[modelId] = {
            imageList: [],
            initialImageList: [],
            ownRights: false,
            shareDataset: false,
            initialOwnRights: false,
            initialShareDataset: false,
          };
        state[modelId]!.ownRights = v;
      });
    },
    setShareDataset: (modelId, v) => {
      set((state) => {
        if (!state[modelId])
          state[modelId] = {
            imageList: [],
            initialImageList: [],
            ownRights: false,
            shareDataset: false,
            initialOwnRights: false,
            initialShareDataset: false,
          };
        state[modelId]!.shareDataset = v;
      });
    },
    setInitialOwnRights: (modelId, v) => {
      set((state) => {
        if (!state[modelId])
          state[modelId] = {
            imageList: [],
            initialImageList: [],
            ownRights: false,
            shareDataset: false,
            initialOwnRights: false,
            initialShareDataset: false,
          };
        state[modelId]!.initialOwnRights = v;
      });
    },
    setInitialShareDataset: (modelId, v) => {
      set((state) => {
        if (!state[modelId])
          state[modelId] = {
            imageList: [],
            initialImageList: [],
            ownRights: false,
            shareDataset: false,
            initialOwnRights: false,
            initialShareDataset: false,
          };
        state[modelId]!.initialShareDataset = v;
      });
    },
  }))
);

const useStyles = createStyles(() => ({
  imgOverlay: {
    position: 'relative',
    '&:hover .trashIcon': {
      display: 'initial',
    },
  },
  trash: {
    display: 'none',
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 10,
    margin: 4,
  },
}));

// TODO [bw] is this enough? do we want jfif and webp?
const imageExts: { [key: string]: string } = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  // webp: 'image/webp',
};

export const TrainingFormImages = ({ model }: { model: NonNullable<TrainingModelData> }) => {
  const {
    updateImage,
    setImageList,
    setInitialImageList,
    setOwnRights,
    setShareDataset,
    setInitialOwnRights,
    setInitialShareDataset,
  } = useImageStore();

  const {
    imageList,
    initialImageList,
    ownRights,
    shareDataset,
    initialOwnRights,
    initialShareDataset,
  } = useImageStore(
    (state) =>
      state[model.id] ?? {
        imageList: [],
        initialImageList: [],
        ownRights: false,
        shareDataset: false,
        initialOwnRights: false,
        initialShareDataset: false,
      }
  );

  const [page, setPage] = useState(1);
  const [zipping, setZipping] = useState<boolean>(false);
  const [loadingZip, setLoadingZip] = useState<boolean>(false);
  const [modelFileId, setModelFileId] = useState<number | undefined>(undefined);
  const theme = useMantineTheme();
  const { classes, cx } = useStyles();
  const queryUtils = trpc.useContext();
  const { upload, getStatus: getUploadStatus } = useS3UploadStore();

  const thisModelVersion = model.modelVersions[0];
  const existingDataFile = thisModelVersion.files[0];
  const existingMetadata = existingDataFile?.metadata as FileMetadata | null;

  const notificationId = `${thisModelVersion.id}-uploading-data-notification`;

  const { uploading } = getUploadStatus((file) => file.meta?.versionId === thisModelVersion.id);

  useEffect(() => {
    // is there any way to generate a file download url given the one we already have?
    // async function parseExisting(ef: (typeof thisModelVersion.files)[number]) {
    async function parseExisting() {
      const url = createModelFileDownloadUrl({
        versionId: thisModelVersion.id,
        type: 'Training Data',
      });
      const result = await fetch(url);
      if (!result.ok) {
        return;
      }
      const blob = await result.blob();
      const zipFile = new File([blob], `${thisModelVersion.id}_training_data.zip`, {
        type: blob.type,
      });
      return await handleZip(zipFile, false);
    }

    if (existingDataFile) {
      setModelFileId(existingDataFile.id);
      const fileOwnRights = existingMetadata?.ownRights ?? false;
      const fileShareDataset = existingMetadata?.shareDataset ?? false;
      setOwnRights(model.id, fileOwnRights);
      setInitialOwnRights(model.id, fileOwnRights);
      setShareDataset(model.id, fileShareDataset);
      setInitialShareDataset(model.id, fileShareDataset);

      if (imageList.length === 0) {
        setLoadingZip(true);
        parseExisting()
          .then((files) => {
            if (files) {
              const flatFiles = files.flat();
              setImageList(model.id, flatFiles);
              setInitialImageList(
                model.id,
                flatFiles.map((d) => ({ ...d }))
              );
            }
          })
          .catch((e) => {
            showErrorNotification({
              error: e ?? 'An error occurred while parsing the existing file.',
            });
          })
          .finally(() => setLoadingZip(false));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const thisStep = 2;
  const maxImgPerPage = 9;

  const handleZip = async (f: FileWithPath, showNotif = true) => {
    // could set loadingZip here too
    const parsedFiles: ImageDataType[] = [];
    const zipReader = new JSZip();
    // zipReader.loadAsync(f).then((zData) => {
    const zData = await zipReader.loadAsync(f);
    await Promise.all(
      Object.entries(zData.files).map(async ([zname, zf]) => {
        // - we could read the type here with some crazy blob/hex inspecting
        const fileSplit = zname.split('.');
        const fileExt = fileSplit.pop() || '';
        const baseFileName = fileSplit.join('.');
        if (fileExt in imageExts) {
          const imgBlob = await zf.async('blob');
          const czFile = zipReader.file(`${baseFileName}.txt`);
          let captionStr = '';
          if (czFile) captionStr = await czFile.async('string');
          parsedFiles.push({
            name: zname,
            type: imageExts[fileExt],
            url: URL.createObjectURL(imgBlob),
            caption: captionStr,
          });
        }
      })
    );

    if (showNotif) {
      if (parsedFiles.length > 0) {
        showSuccessNotification({
          title: 'Zip parsed successfully!',
          message: `Found ${parsedFiles.length} images.`,
        });
      } else {
        showErrorNotification({
          error: new Error('Could not find any valid files in zip.'),
        });
      }
    }

    return parsedFiles;
  };

  const handleDrop = async (fileList: FileWithPath[]) => {
    const newFiles = await Promise.all(
      fileList.map(async (f) => {
        if (ZIP_MIME_TYPE.includes(f.type as never)) {
          return await handleZip(f);
        } else {
          return { name: f.name, type: f.type, url: URL.createObjectURL(f), caption: '' };
        }
      })
    );
    setImageList(model.id, imageList.concat(newFiles.flat()));
  };

  const updateFileMutation = trpc.modelFile.update.useMutation({
    async onSuccess(response, request) {
      setInitialOwnRights(model.id, ownRights);
      setInitialShareDataset(model.id, shareDataset);

      queryUtils.training.getModelBasic.setData({ id: model.id }, (old) => {
        if (!old) return old;

        const versionToUpdate = old.modelVersions.find((mv) => mv.id === thisModelVersion.id);
        if (!versionToUpdate) return old;
        versionToUpdate.files[0].visibility = request.visibility!;
        versionToUpdate.files[0].metadata = request.metadata!;

        return {
          ...old,
          modelVersions: [
            versionToUpdate,
            ...old.modelVersions.filter((mv) => mv.id !== thisModelVersion.id),
          ],
        };
      });
      // TODO [bw] don't invalidate, just update
      await queryUtils.model.getMyTrainingModels.invalidate();
    },
  });

  const upsertFileMutation = trpc.modelFile.upsert.useMutation({
    async onSuccess(response, request) {
      updateNotification({
        id: notificationId,
        icon: <IconCheck size={18} />,
        color: 'teal',
        title: 'Upload complete!',
        message: '',
        autoClose: 3000,
        disallowClose: false,
      });

      setInitialImageList(model.id, imageList);

      queryUtils.training.getModelBasic.setData({ id: model.id }, (old) => {
        if (!old) return old;

        const versionToUpdate = old.modelVersions.find((mv) => mv.id === thisModelVersion.id);
        if (!versionToUpdate) return old;
        versionToUpdate.files = [
          {
            id: response.id,
            url: request.url!,
            type: request.type!,
            metadata: request.metadata!,
            sizeKB: request.sizeKB!,
            visibility: request.visibility!,
          },
        ];

        return {
          ...old,
          modelVersions: [
            versionToUpdate,
            ...old.modelVersions.filter((mv) => mv.id !== thisModelVersion.id),
          ],
        };
      });
      // TODO [bw] don't invalidate, just update
      await queryUtils.model.getMyTrainingModels.invalidate();

      setZipping(false);
      goNext(model.id, thisStep);
    },
    onError(error) {
      setZipping(false);
      updateNotification({
        id: notificationId,
        icon: <IconX size={18} />,
        color: 'red',
        title: 'Failed to upload archive.',
        message: error.message,
      });
    },
  });

  const handleNextAfterCheck = async () => {
    setZipping(true);
    const zip = new JSZip();

    await Promise.all(
      imageList.map(async (imgData, idx) => {
        const filenameBase = String(idx).padStart(3, '0');
        imgData.caption.length > 0 && zip.file(`${filenameBase}.txt`, imgData.caption);

        const imgBlob = await fetch(imgData.url).then((res) => res.blob());

        // TODO [bw] unregister here

        zip.file(`${filenameBase}.${imgData.type.split('/').pop()}`, imgBlob);
      })
    );
    // TODO [bw] handle error
    zip.generateAsync({ type: 'blob' }).then(async (content) => {
      // saveAs(content, 'example.zip');

      const blobFile = new File([content], `${thisModelVersion.id}_training_data.zip`, {
        type: 'application/zip',
      });

      showNotification({
        id: notificationId,
        loading: true,
        autoClose: false,
        disallowClose: true,
        title: 'Creating and uploading archive',
        message: `Packaging ${imageList.length} images...`,
      });

      try {
        await upload(
          {
            file: blobFile,
            type: UploadType.TrainingImages, // TODO [bw] maybe use UploadType.TrainingImagesTemp
            meta: {
              versionId: thisModelVersion.id,
              ownRights,
              shareDataset,
              numImages: imageList.length,
              numCaptions: imageList.filter((i) => i.caption.length > 0).length,
            },
          },
          async ({ meta, size, ...result }) => {
            const { versionId, ...metadata } = meta as {
              versionId: number;
            };
            if (versionId) {
              try {
                await upsertFileMutation.mutateAsync({
                  ...result,
                  ...(modelFileId && { id: modelFileId }),
                  sizeKB: bytesToKB(size),
                  modelVersionId: versionId,
                  type: 'Training Data',
                  visibility:
                    ownRights && shareDataset
                      ? ModelFileVisibility.Public
                      : ownRights
                      ? ModelFileVisibility.Sensitive
                      : ModelFileVisibility.Private,
                  metadata,
                });
              } catch (e: unknown) {
                console.log(e);
                setZipping(false);
                updateNotification({
                  id: notificationId,
                  icon: <IconX size={18} />,
                  color: 'red',
                  title: 'Failed to upload archive.',
                  message: '',
                });
              }
            } else {
              throw new Error('Missing version data.');
            }
          }
        );
      } catch (e) {
        setZipping(false);
        updateNotification({
          id: notificationId,
          icon: <IconX size={18} />,
          color: 'red',
          title: 'Failed to upload archive.',
          message: e instanceof Error ? e.message : '',
        });
      }
    });
  };

  const handleNext = async () => {
    if (isEqual(imageList, initialImageList) && imageList.length !== 0) {
      if (!isEqual(shareDataset, initialShareDataset) || !isEqual(ownRights, initialOwnRights)) {
        setZipping(true);
        await updateFileMutation.mutateAsync({
          id: modelFileId!,
          metadata: { ...existingMetadata!, ownRights, shareDataset },
          visibility:
            ownRights && shareDataset
              ? ModelFileVisibility.Public
              : ownRights
              ? ModelFileVisibility.Sensitive
              : ModelFileVisibility.Private,
        });
        setZipping(false);
      }

      return goNext(model.id, thisStep);
    }

    if (imageList.length) {
      // if no captions, warn
      if (imageList.filter((i) => i.caption.length > 0).length === 0) {
        return openConfirmModal({
          title: (
            <Group spacing="xs">
              <IconAlertTriangle color="gold" />
              <Text size="lg">Missing captions</Text>
            </Group>
          ),
          children:
            'You have not provided any captions for your images. This can produce an inflexible model. We will also attempt to generate sample images, but they may not be what you are looking for. Are you sure you want to continue?',
          labels: { cancel: 'Cancel', confirm: 'Continue' },
          onConfirm: handleNextAfterCheck,
        });
      } else {
        handleNextAfterCheck();
      }
    } else {
      // no images given. could show a takeover or form inline error instead.
      showNotification({
        icon: <IconX size={18} />,
        color: 'red',
        title: 'No images provided',
        message: 'Must select at least 1 image.',
      });
    }
  };
  const totalCaptioned = imageList.filter((i) => i.caption && i.caption.length > 0).length;

  return (
    <>
      <Stack>
        <div>
          <Text>
            You can add an existing dataset for your model, or create a new one here. Not sure what
            to do? Read our{' '}
            <Text
              component={NextLink}
              variant="link"
              target="_blank"
              href="/content/training/dataset-guidelines"
            >
              Dataset and Training Guidelines
            </Text>{' '}
            for more info.
          </Text>
        </div>
        <div>
          <ImageDropzone
            mt="md"
            onDrop={handleDrop}
            label="Drag images (or a zip file) here or click to select files"
            description={
              <Text mt="xs" fz="sm" color={theme.colors.red[5]}>
                Changes made here are not permanently saved until you hit &quot;Next&quot;
              </Text>
            }
            max={1000}
            // loading={isLoading}
            count={100}
            accept={[...IMAGE_MIME_TYPE, ...ZIP_MIME_TYPE]}
          />
        </div>

        {imageList.length > 0 && (
          <Group mt="md" position="apart">
            <Group>
              {/*perhaps open a modal here to confirm*/}
              <Button compact color="red" onClick={() => setImageList(model.id, [])}>
                <IconTrash size={16} />
                <Text inline ml={4}>
                  Clear All
                </Text>
              </Button>
              <Text
                color={
                  totalCaptioned === 0
                    ? theme.colors.red[5]
                    : totalCaptioned < imageList.length
                    ? theme.colors.orange[5]
                    : theme.colors.green[5]
                }
              >
                {`${totalCaptioned} / ${imageList.length} captioned`}
              </Text>
            </Group>

            {imageList.length > maxImgPerPage && (
              <Pagination
                page={page}
                onChange={setPage}
                total={Math.ceil(imageList.length / maxImgPerPage)}
              />
            )}
          </Group>
        )}

        {loadingZip ? (
          <Center style={{ flexDirection: 'column' }}>
            <Loader />
            <Text>Parsing existing images...</Text>
          </Center>
        ) : (
          // nb: if we want to break out of container, add margin: 0 calc(50% - 45vw);
          <SimpleGrid cols={3} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
            {imageList
              .slice((page - 1) * maxImgPerPage, (page - 1) * maxImgPerPage + maxImgPerPage)
              .map((imgData, index) => {
                return (
                  <Stack
                    key={index}
                    // style={{ justifyContent: 'center', alignItems: 'center', position: 'relative' }}
                    style={{ justifyContent: 'flex-start' }}
                  >
                    {/* TODO [bw] probably lightbox here or something similar */}
                    <div className={classes.imgOverlay}>
                      <ActionIcon
                        color="red"
                        variant="filled"
                        size="md"
                        onClick={() => {
                          const newLen = imageList.length - 1;
                          setImageList(
                            model.id,
                            imageList.filter((i) => i.url !== imgData.url)
                          );
                          if (
                            page === Math.ceil(imageList.length / maxImgPerPage) &&
                            newLen % maxImgPerPage === 0
                          )
                            setPage(page - 1);
                        }}
                        className={cx(classes.trash, 'trashIcon')}
                      >
                        <IconTrash />
                      </ActionIcon>
                      <Image
                        alt={imgData.name}
                        src={imgData.url}
                        imageProps={{
                          style: {
                            height: '250px',
                            // if we want to show full image, change objectFit to contain
                            objectFit: 'cover',
                            // object-position: top;
                            width: '100%',
                          },
                          // onLoad: () => URL.revokeObjectURL(imageUrl)
                        }}
                      />
                    </div>
                    <Textarea
                      placeholder="Enter caption data..."
                      autosize
                      minRows={1}
                      maxRows={4}
                      value={imgData.caption}
                      onChange={(event) => {
                        updateImage(model.id, {
                          url: imgData.url,
                          caption: event.currentTarget.value,
                        });
                      }}
                    />
                  </Stack>
                );
              })}
          </SimpleGrid>
        )}

        {imageList.length > 0 && (
          <Paper mt="xl" mb="md" radius="md" p="xl" withBorder>
            <Stack>
              <Title order={4}>Data Ownership and Sharing</Title>
              <Text fz="sm">
                Your dataset is temporarily stored for the purposes of training. After training is
                complete, the dataset is removed. By default, it is not public. Read our{' '}
                <Text
                  component={NextLink}
                  variant="link"
                  href="/content/training/data-policy"
                  target="_blank"
                >
                  dataset storage policy
                </Text>
                .
              </Text>
              <Checkbox
                label="I own the rights to all these images"
                checked={ownRights}
                onChange={(event) => {
                  setOwnRights(model.id, event.currentTarget.checked);
                  !event.currentTarget.checked && setShareDataset(model.id, false);
                }}
              />
              <Checkbox
                label="I want to share my dataset"
                disabled={!ownRights}
                checked={shareDataset}
                onChange={(event) => setShareDataset(model.id, event.currentTarget.checked)}
              />
            </Stack>
          </Paper>
        )}
      </Stack>
      <Group position="right">
        <Button variant="default" onClick={() => goBack(model.id, thisStep)}>
          Back
        </Button>
        <Button onClick={handleNext} loading={zipping || uploading > 0}>
          Next
        </Button>
      </Group>
    </>
  );
};
