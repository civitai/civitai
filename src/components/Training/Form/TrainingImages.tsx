import {
  ActionIcon,
  Anchor,
  Button,
  Card,
  Center,
  Checkbox,
  createStyles,
  Group,
  Image as MImage,
  Loader,
  Pagination,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { FileWithPath } from '@mantine/dropzone';
import { openConfirmModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import { showNotification, updateNotification } from '@mantine/notifications';
import { ModelFileVisibility } from '@prisma/client';
import {
  IconAlertTriangle,
  IconCheck,
  IconFileDownload,
  IconTags,
  IconTagsOff,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import { isEqual } from 'lodash-es';
import React, { useEffect, useRef, useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { goBack, goNext } from '~/components/Training/Form/TrainingCommon';
import {
  TrainingImagesCaptions,
  TrainingImagesCaptionViewer,
} from '~/components/Training/Form/TrainingImagesCaptionViewer';
import { UploadType } from '~/server/common/enums';
import { IMAGE_MIME_TYPE, ZIP_MIME_TYPE } from '~/server/common/mime-types';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { useS3UploadStore } from '~/store/s3-upload.store';
import {
  defaultTrainingState,
  getShortNameFromUrl,
  type ImageDataType,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';
import { TrainingModelData } from '~/types/router';
import {
  showErrorNotification,
  showSuccessNotification,
  showWarningNotification,
} from '~/utils/notifications';
import { bytesToKB } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { AutoTagModal } from './TrainingAutoTagModal';

const MAX_FILES_ALLOWED = 1000;

export const blankTagStr = '@@none@@';

const useStyles = createStyles((theme) => ({
  imgOverlay: {
    borderBottom: `1px solid ${
      theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2]
    }`,
    position: 'relative',
    '&:hover .trashIcon': {
      display: 'flex',
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

// TODO [bw] is this enough? do we want jfif?
const imageExts: { [key: string]: string } = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const maxWidth = 2048;
const maxHeight = 2048;

const createImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', (error) => reject(error));
    image.src = url;
  });

export const getCaptionAsList = (capt: string) => {
  return capt
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
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
    setAutoCaptioning,
  } = trainingStore;

  const {
    imageList,
    initialImageList,
    ownRights,
    shareDataset,
    initialOwnRights,
    initialShareDataset,
    autoCaptioning,
  } = useTrainingImageStore((state) => state[model.id] ?? { ...defaultTrainingState });

  const [page, setPage] = useState(1);
  const [zipping, setZipping] = useState<boolean>(false);
  const [loadingZip, setLoadingZip] = useState<boolean>(false);
  const [modelFileId, setModelFileId] = useState<number | undefined>(undefined);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const showImgResize = useRef(false);

  const theme = useMantineTheme();
  const { classes, cx } = useStyles();
  const queryUtils = trpc.useUtils();
  const { upload, getStatus: getUploadStatus } = useS3UploadStore();
  const { connected } = useSignalContext();

  const thisModelVersion = model.modelVersions[0];
  const existingDataFile = thisModelVersion.files[0];
  const existingMetadata = existingDataFile?.metadata as FileMetadata | null;

  const notificationId = `${thisModelVersion.id}-uploading-data-notification`;

  const { uploading } = getUploadStatus((file) => file.meta?.versionId === thisModelVersion.id);

  const thisStep = 2;
  const maxImgPerPage = 9;

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
              autoClose: false,
            });
          })
          .finally(() => setLoadingZip(false));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getResizedImgUrl = async (data: FileWithPath | Blob, type: string): Promise<string> => {
    const imgUrl = URL.createObjectURL(data);
    const img = await createImage(imgUrl);
    let { width, height } = img;
    if (width <= maxWidth && height <= maxHeight) return imgUrl;

    if (width > height) {
      if (width > maxWidth) {
        height = height * (maxWidth / width);
        width = maxWidth;
        showImgResize.current = true;
      }
    } else {
      if (height > maxHeight) {
        width = width * (maxHeight / height);
        height = maxHeight;
        showImgResize.current = true;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Error resizing image');
    ctx.drawImage(img, 0, 0, width, height);

    return new Promise((resolve, reject) => {
      canvas.toBlob((file) => {
        if (!file) reject();
        else resolve(URL.createObjectURL(file));
      }, type);
    });
  };

  const handleZip = async (f: FileWithPath, showNotif = true) => {
    if (showNotif) setLoadingZip(true);
    const parsedFiles: ImageDataType[] = [];
    const zipReader = new JSZip();
    const zData = await zipReader.loadAsync(f);
    await Promise.all(
      Object.entries(zData.files).map(async ([zname, zf]) => {
        if (zf.dir) return;
        if (zname.startsWith('__MACOSX/') || zname.endsWith('.DS_STORE')) return;
        // - we could read the type here with some crazy blob/hex inspecting
        const fileSplit = zname.split('.');
        const fileExt = (fileSplit.pop() || '').toLowerCase();
        const baseFileName = fileSplit.join('.');
        if (fileExt in imageExts) {
          const imgBlob = await zf.async('blob');
          try {
            const scaledUrl = await getResizedImgUrl(imgBlob, imageExts[fileExt]);
            const czFile = zipReader.file(`${baseFileName}.txt`);
            let captionStr = '';
            if (czFile) captionStr = await czFile.async('string');
            parsedFiles.push({
              name: zname,
              type: imageExts[fileExt],
              url: scaledUrl,
              caption: captionStr,
            });
          } catch {
            showErrorNotification({
              error: new Error(`An error occurred while parsing "${zname}".`),
            });
          }
        }
      })
    );

    if (showImgResize.current) {
      showWarningNotification({
        title: 'Some images resized',
        message: `Max allowed image dimensions are ${maxWidth}x${maxHeight}.`,
        autoClose: 5000,
      });
      showImgResize.current = false;
    }

    if (showNotif) {
      if (parsedFiles.length > 0) {
        showSuccessNotification({
          title: 'Zip parsed successfully!',
          message: `Found ${parsedFiles.length} images.`,
        });
      } else {
        showErrorNotification({
          error: new Error('Could not find any valid files in zip.'),
          autoClose: false,
        });
      }
      setLoadingZip(false);
    }

    return parsedFiles;
  };

  const handleDrop = async (fileList: FileWithPath[]) => {
    const newFiles = await Promise.all(
      fileList.map(async (f) => {
        if (ZIP_MIME_TYPE.includes(f.type as never)) {
          return await handleZip(f);
        } else {
          try {
            const scaledUrl = await getResizedImgUrl(f, f.type);
            return { name: f.name, type: f.type, url: scaledUrl, caption: '' } as ImageDataType;
          } catch {
            showErrorNotification({
              error: new Error(`An error occurred while parsing "${f.name}".`),
            });
          }
        }
      })
    );

    if (showImgResize.current) {
      showWarningNotification({
        title: 'Some images resized',
        message: `Max allowed image dimensions are ${maxWidth}x${maxHeight}.`,
        autoClose: 5000,
      });
      showImgResize.current = false;
    }

    const filteredFiles = newFiles.flat().filter(isDefined);
    if (filteredFiles.length > MAX_FILES_ALLOWED - imageList.length) {
      showErrorNotification({
        title: 'Too many images',
        error: new Error(`Truncating to ${MAX_FILES_ALLOWED}.`),
        autoClose: false,
      });
      filteredFiles.splice(MAX_FILES_ALLOWED - imageList.length);
    }
    setImageList(model.id, imageList.concat(filteredFiles));
  };

  const updateFileMutation = trpc.modelFile.update.useMutation({
    async onSuccess(_response, request) {
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

  const submitTagMutation = trpc.training.autoTag.useMutation({
    // TODO allow people to rerun failed images
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to auto-tag',
        autoClose: false,
      });
      setAutoCaptioning(model.id, { ...defaultTrainingState.autoCaptioning });
    },
  });

  useEffect(() => {
    if (autoCaptioning.isRunning || !autoCaptioning.url) return;
    setAutoCaptioning(model.id, { ...autoCaptioning, isRunning: true });
    submitTagMutation.mutate({ url: autoCaptioning.url, modelId: model.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCaptioning.url]);

  const filteredImages = imageList.filter((i) => {
    if (!selectedTags.length) return true;
    const capts: string[] = [];
    if (selectedTags.includes(blankTagStr) && getCaptionAsList(i.caption).length === 0)
      capts.push(blankTagStr);
    const mergedCapts = capts.concat(
      getCaptionAsList(i.caption).filter((c) => selectedTags.includes(c))
    );
    return mergedCapts.length > 0;
  });

  useEffect(() => {
    if (page > 1 && filteredImages.length <= (page - 1) * maxImgPerPage) {
      setPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTags]);

  const handleNextAfterCheck = async (dlOnly = false) => {
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
      const fileName = `${thisModelVersion.id}_training_data.zip`;

      if (dlOnly) {
        saveAs(content, fileName);
        setZipping(false);
        return;
      }

      const blobFile = new File([content], fileName, {
        type: 'application/zip',
      });

      showNotification({
        id: notificationId,
        loading: true,
        autoClose: false,
        disallowClose: true,
        title: 'Creating and uploading archive',
        message: `Packaging ${imageList.length} image${imageList.length !== 1 ? 's' : ''}...`,
      });

      try {
        const uploadResp = await upload(
          {
            file: blobFile,
            type: UploadType.TrainingImages,
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
                setZipping(false);
                updateNotification({
                  id: notificationId,
                  icon: <IconX size={18} />,
                  color: 'red',
                  title: 'Failed to upload archive.',
                  message: 'Please try again (or contact us if it continues)',
                });
              }
            } else {
              throw new Error('Missing version data.');
            }
          }
        );
        if (!uploadResp) {
          setZipping(false);
          updateNotification({
            id: notificationId,
            icon: <IconX size={18} />,
            color: 'red',
            title: 'Failed to upload archive.',
            message: 'Please try again (or contact us if it continues)',
          });
        }
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
          centered: true,
          onConfirm: handleNextAfterCheck,
        });
      } else {
        await handleNextAfterCheck();
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
            <Anchor
              href="https://education.civitai.com/using-civitai-the-on-site-lora-trainer"
              target="_blank"
              rel="nofollow noreferrer"
            >
              Dataset and Training Guidelines
            </Anchor>{' '}
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
            max={MAX_FILES_ALLOWED}
            // loading={isLoading}
            count={imageList.length}
            accept={[...IMAGE_MIME_TYPE, ...ZIP_MIME_TYPE]}
            onExceedMax={() =>
              showErrorNotification({
                title: 'Too many images',
                error: new Error(`Truncating to ${MAX_FILES_ALLOWED}.`),
                autoClose: false,
              })
            }
          />
        </div>

        {imageList.length > 0 && (
          <Group my="md">
            <Paper
              shadow="xs"
              radius="sm"
              px={8}
              py={2}
              style={{
                backgroundColor:
                  theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
              }}
            >
              <Text
                style={{ lineHeight: '22px' }}
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
            </Paper>
            <Tooltip
              label="Not connected - will not receive updates. Please try refreshing the page."
              disabled={connected}
            >
              <Button
                compact
                disabled={autoCaptioning.isRunning || !connected}
                style={!connected ? { pointerEvents: 'initial' } : undefined}
                onClick={() =>
                  dialogStore.trigger({
                    component: AutoTagModal,
                    props: {
                      imageList,
                      modelId: model.id,
                      setAutoCaptioning,
                    },
                  })
                }
              >
                <IconTags size={16} />
                <Text inline ml={4}>
                  Auto Tag
                </Text>
              </Button>
            </Tooltip>
            <Button
              compact
              color="cyan"
              loading={zipping}
              onClick={() => handleNextAfterCheck(true)}
            >
              <IconFileDownload size={16} />
              <Text inline ml={4}>
                Download
              </Text>
            </Button>

            <Button
              compact
              color="red"
              disabled={autoCaptioning.isRunning}
              onClick={() => {
                openConfirmModal({
                  title: 'Remove all images?',
                  children: 'This cannot be undone.',
                  labels: { cancel: 'Cancel', confirm: 'Confirm' },
                  centered: true,
                  onConfirm: () => setImageList(model.id, []),
                });
              }}
            >
              <IconTrash size={16} />
              <Text inline ml={4}>
                Reset
              </Text>
            </Button>
          </Group>
        )}

        {filteredImages.length > maxImgPerPage && (
          <Pagination
            withEdges
            mb="md"
            page={page}
            onChange={setPage}
            total={Math.ceil(filteredImages.length / maxImgPerPage)}
          />
        )}

        {autoCaptioning.isRunning && (
          <Paper
            my="lg"
            p="md"
            withBorder
            style={{
              backgroundColor:
                theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
            }}
          >
            <Stack>
              <Text>Running auto-tagging...</Text>
              {autoCaptioning.successes + autoCaptioning.fails.length > 0 ? (
                <Progress
                  value={
                    ((autoCaptioning.successes + autoCaptioning.fails.length) /
                      autoCaptioning.total) *
                    100
                  }
                  label={`${autoCaptioning.successes + autoCaptioning.fails.length} / ${
                    autoCaptioning.total
                  }`}
                  size="xl"
                  radius="xl"
                  striped
                  animate
                />
              ) : (
                <Progress
                  value={100}
                  label="Waiting for data..."
                  size="xl"
                  radius="xl"
                  striped
                  animate
                />
              )}
            </Stack>
          </Paper>
        )}

        {imageList.length > 0 && (
          <TrainingImagesCaptionViewer
            selectedTags={selectedTags}
            setSelectedTags={setSelectedTags}
            modelId={model.id}
            numImages={filteredImages.length}
          />
        )}

        {loadingZip ? (
          <Center style={{ flexDirection: 'column' }}>
            <Loader />
            <Text>Parsing existing images...</Text>
          </Center>
        ) : (
          // nb: if we want to break out of container, add margin: 0 calc(50% - 45vw);
          <SimpleGrid cols={3} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
            {filteredImages
              .slice((page - 1) * maxImgPerPage, (page - 1) * maxImgPerPage + maxImgPerPage)
              .map((imgData, index) => {
                return (
                  <Card key={index} shadow="sm" p={4} radius="sm" withBorder>
                    {/* TODO [bw] probably lightbox here or something similar */}
                    <Card.Section mb="xs">
                      <div className={classes.imgOverlay}>
                        <Group spacing={4} className={cx(classes.trash, 'trashIcon')}>
                          <Tooltip label="Remove captions">
                            <ActionIcon
                              color="violet"
                              variant="filled"
                              size="md"
                              disabled={autoCaptioning.isRunning || !imgData.caption.length}
                              onClick={() => {
                                updateImage(model.id, {
                                  matcher: getShortNameFromUrl(imgData),
                                  caption: '',
                                });
                              }}
                            >
                              <IconTagsOff />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Remove image">
                            <ActionIcon
                              color="red"
                              variant="filled"
                              size="md"
                              disabled={autoCaptioning.isRunning}
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
                                  setPage(Math.max(page - 1, 1));
                              }}
                            >
                              <IconTrash />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                        <MImage
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
                    </Card.Section>
                    <TrainingImagesCaptions
                      imgData={imgData}
                      modelId={model.id}
                      selectedTags={selectedTags}
                    />
                  </Card>
                );
              })}
          </SimpleGrid>
        )}

        {filteredImages.length > maxImgPerPage && (
          <Pagination
            withEdges
            mt="md"
            page={page}
            onChange={setPage}
            total={Math.ceil(filteredImages.length / maxImgPerPage)}
          />
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
        <Button
          onClick={handleNext}
          disabled={autoCaptioning.isRunning}
          loading={zipping || uploading > 0}
        >
          Next
        </Button>
      </Group>
    </>
  );
};
