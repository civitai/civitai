import {
  Accordion,
  ActionIcon,
  Badge,
  Button,
  Center,
  Checkbox,
  Chip,
  createStyles,
  Group,
  Image as MImage,
  Loader,
  Menu,
  Pagination,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { FileWithPath } from '@mantine/dropzone';
import { useDebouncedValue } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import { showNotification, updateNotification } from '@mantine/notifications';
import { ModelFileVisibility } from '@prisma/client';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconReplace,
  IconSearch,
  IconTags,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import JSZip from 'jszip';
import { isEqual } from 'lodash-es';
import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import {
  AutoTagModal,
  AutoTagSchemaType,
  MAX_TAGS,
  MIN_THRESHOLD,
} from '~/components/Resource/Forms/Training/TrainingAutoTagModal';
import { goBack, goNext } from '~/components/Resource/Forms/Training/TrainingCommon';
import { TrainingEditTagsModal } from '~/components/Resource/Forms/Training/TrainingEditTagsModal';
import { UploadType } from '~/server/common/enums';
import { IMAGE_MIME_TYPE, ZIP_MIME_TYPE } from '~/server/common/mime-types';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { TrainingModelData } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { bytesToKB } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export type ImageDataType = {
  url: string;
  name: string;
  type: string;
  caption: string;
};

type UpdateImageDataType = Partial<ImageDataType> & {
  matcher: string;
  appendCaption?: boolean;
};
export type AutoCaptionType = Nullable<AutoTagSchemaType> & {
  url: string | null;
  isRunning: boolean;
};

type TrainingDataState = {
  imageList: ImageDataType[];
  initialImageList: ImageDataType[];
  ownRights: boolean;
  initialOwnRights: boolean;
  shareDataset: boolean;
  initialShareDataset: boolean;
  autoCaptioning: AutoCaptionType;
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
  setAutoCaptioning: (modelId: number, data: AutoCaptionType) => void;
};

const defaultState: TrainingDataState = {
  imageList: [] as ImageDataType[],
  initialImageList: [] as ImageDataType[],
  ownRights: false,
  shareDataset: false,
  initialOwnRights: false,
  initialShareDataset: false,
  autoCaptioning: {
    maxTags: null,
    threshold: null,
    overwrite: null,
    blacklist: null,
    prependTags: null,
    appendTags: null,
    url: null,
    isRunning: false,
  },
};

const MAX_FILES_ALLOWED = 1000;

export const useImageStore = create<ImageStore>()(
  immer((set) => ({
    updateImage: (modelId, { matcher, url, name, type, caption, appendCaption }) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultState };
        // TODO [bw] why is this not understanding the override I just did above?
        state[modelId]!.imageList = state[modelId]!.imageList.map((i) => {
          const shortName = getShortNameFromUrl(i);
          if (shortName === matcher) {
            return {
              url: url ?? i.url,
              name: name ?? i.name,
              type: type ?? i.type,
              caption:
                caption !== undefined
                  ? appendCaption && i.caption.length > 0
                    ? `${i.caption}, ${caption}`
                    : caption
                  : i.caption,
            };
          }
          return i;
        });
      });
    },
    setImageList: (modelId, imgData) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultState };
        state[modelId]!.imageList = imgData;
      });
    },
    setInitialImageList: (modelId, imgData) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultState };
        state[modelId]!.initialImageList = imgData;
      });
    },
    setOwnRights: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultState };
        state[modelId]!.ownRights = v;
      });
    },
    setShareDataset: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultState };
        state[modelId]!.shareDataset = v;
      });
    },
    setInitialOwnRights: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultState };
        state[modelId]!.initialOwnRights = v;
      });
    },
    setInitialShareDataset: (modelId, v) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultState };
        state[modelId]!.initialShareDataset = v;
      });
    },
    setAutoCaptioning: (modelId, captionData) => {
      set((state) => {
        if (!state[modelId]) state[modelId] = { ...defaultState };
        state[modelId]!.autoCaptioning = captionData;
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

// TODO [bw] is this enough? do we want jfif?
const imageExts: { [key: string]: string } = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const maxWidth = 1024;
const maxHeight = 1024;

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

export const getShortNameFromUrl = (i: ImageDataType) => {
  return `${i.url.split('/').pop() ?? 'unk'}.${i.type.split('/').pop() ?? 'jpg'}`;
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
  } = useImageStore();

  const {
    imageList,
    initialImageList,
    ownRights,
    shareDataset,
    initialOwnRights,
    initialShareDataset,
    autoCaptioning,
  } = useImageStore((state) => state[model.id] ?? { ...defaultState });

  const [page, setPage] = useState(1);
  const [zipping, setZipping] = useState<boolean>(false);
  const [loadingZip, setLoadingZip] = useState<boolean>(false);
  const [modelFileId, setModelFileId] = useState<number | undefined>(undefined);
  const [tagSearchInput, setTagSearchInput] = useState<string>('');
  const [tagList, setTagList] = useState<[string, number][]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [debouncedImageList] = useDebouncedValue(imageList, 300);

  const theme = useMantineTheme();
  const { classes, cx } = useStyles();
  const queryUtils = trpc.useUtils();
  const { upload, getStatus: getUploadStatus } = useS3UploadStore();

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
      }
    } else {
      if (height > maxHeight) {
        width = width * (maxHeight / height);
        height = maxHeight;
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
        // - we could read the type here with some crazy blob/hex inspecting
        const fileSplit = zname.split('.');
        const fileExt = fileSplit.pop() || '';
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
    async onSuccess(response) {
      const blacklist = getCaptionAsList(autoCaptioning.blacklist ?? '');
      const prependList = getCaptionAsList(autoCaptioning.prependTags ?? '');
      const appendList = getCaptionAsList(autoCaptioning.appendTags ?? '');

      Object.entries(response).forEach(([k, v]) => {
        let tags = Object.entries(v)
          .sort(([, a], [, b]) => b - a)
          .filter(
            (t) => t[1] >= (autoCaptioning.threshold ?? MIN_THRESHOLD) && !blacklist.includes(t[0])
          )
          .slice(0, autoCaptioning.maxTags ?? MAX_TAGS)
          .map((t) => t[0]);

        tags = [...prependList, ...tags, ...appendList];

        updateImage(model.id, {
          matcher: k,
          caption: tags.join(', '),
          appendCaption: autoCaptioning.overwrite === 'append',
        });
      });

      const imageLen = Object.keys(response).length;
      showSuccessNotification({
        title: 'Images auto-tagged successfully!',
        message: `Tagged ${imageLen} image${imageLen === 1 ? '' : 's'}.`,
      });
      setAutoCaptioning(model.id, { ...defaultState.autoCaptioning });
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to auto-tag',
        autoClose: false,
      });
      setAutoCaptioning(model.id, { ...defaultState.autoCaptioning });
    },
  });

  useEffect(() => {
    if (autoCaptioning.isRunning || !autoCaptioning.url) return;
    setAutoCaptioning(model.id, { ...autoCaptioning, isRunning: true });
    submitTagMutation.mutate({ url: autoCaptioning.url });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCaptioning.url]);

  useEffect(() => {
    const imageTags = debouncedImageList
      .flatMap((i) => getCaptionAsList(i.caption))
      .filter((v) => (tagSearchInput.length > 0 ? v.includes(tagSearchInput) : v));
    const tagCounts = imageTags.reduce(
      (a: { [key: string]: number }, c) => (a[c] ? ++a[c] : (a[c] = 1), a),
      {}
    );
    // .reduce((a, c) => (a[c] = a[c] || 0, a[c]++, a), {})
    const sortedTagCounts = Object.entries(tagCounts).sort(([, a], [, b]) => b - a);
    setTagList(sortedTagCounts);
    setSelectedTags((s) => s.filter((st) => imageTags.includes(st)));
  }, [debouncedImageList, tagSearchInput]);

  const filteredImages = imageList.filter((i) => {
    if (!selectedTags.length) return true;
    const capts = getCaptionAsList(i.caption).filter((c) => selectedTags.includes(c));
    return capts.length > 0;
  });

  useEffect(() => {
    if (page > 1 && filteredImages.length <= (page - 1) * maxImgPerPage) {
      setPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTags]);

  const removeCaptions = (tags: string[]) => {
    const newImageList = imageList.map((i) => {
      const capts = getCaptionAsList(i.caption).filter((c) => !tags.includes(c));
      return { ...i, caption: capts.join(', ') };
    });
    setImageList(model.id, newImageList);
  };

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
        message: `Packaging ${imageList.length} image${imageList.length !== 1 ? 's' : ''}...`,
      });

      try {
        await upload(
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
          centered: true,
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
          <Group mt="md" position="apart">
            <Group>
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
              <Button
                compact
                disabled={autoCaptioning.isRunning}
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
              {/*perhaps open a modal here to confirm*/}
              <Button compact color="red" onClick={() => setImageList(model.id, [])}>
                <IconTrash size={16} />
                <Text inline ml={4}>
                  Reset
                </Text>
              </Button>
            </Group>

            {filteredImages.length > maxImgPerPage && (
              <Pagination
                page={page}
                onChange={setPage}
                total={Math.ceil(filteredImages.length / maxImgPerPage)}
              />
            )}
          </Group>
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
            <Group>
              <Text>Running auto-tagging...</Text>
              <Loader size="sm" variant="bars" />
            </Group>
          </Paper>
        )}

        {imageList.length > 0 && (
          <Accordion variant="contained" transitionDuration={0}>
            <Accordion.Item value="caption-viewer">
              <Accordion.Control>
                <Group spacing="xs">
                  <Text>Caption Viewer</Text>
                  {selectedTags.length > 0 && <Badge color="red">{selectedTags.length}</Badge>}
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack>
                  <Group>
                    <TextInput
                      icon={<IconSearch size={16} />}
                      placeholder="Search tags"
                      value={tagSearchInput}
                      onChange={(event) =>
                        setTagSearchInput(event.currentTarget.value.toLowerCase())
                      }
                      style={{ flexGrow: 1 }}
                      rightSection={
                        <ActionIcon
                          onClick={() => {
                            setTagSearchInput('');
                          }}
                          disabled={!tagSearchInput.length}
                        >
                          <IconX size={16} />
                        </ActionIcon>
                      }
                    />
                    <Button
                      disabled={!selectedTags.length}
                      size="sm"
                      variant="light"
                      color="red"
                      onClick={() => setSelectedTags([])}
                    >
                      Deselect All
                    </Button>
                    <Menu withArrow>
                      <Menu.Target>
                        <Button disabled={!selectedTags.length} rightIcon={<IconChevronDown />}>
                          Actions
                        </Button>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          icon={<IconTrash size={14} />}
                          onClick={() =>
                            openConfirmModal({
                              title: 'Remove these captions?',
                              children: (
                                <Stack>
                                  <Text>
                                    The following captions will be removed from all images:
                                  </Text>
                                  <Group>
                                    {selectedTags.map((st) => (
                                      <Badge key={st}>{st}</Badge>
                                    ))}
                                  </Group>
                                </Stack>
                              ),
                              labels: { cancel: 'Cancel', confirm: 'Confirm' },
                              centered: true,
                              onConfirm: () => removeCaptions(selectedTags),
                            })
                          }
                        >
                          {`Remove tag${selectedTags.length === 1 ? '' : 's'} (${
                            selectedTags.length
                          })`}
                        </Menu.Item>
                        <Menu.Item
                          icon={<IconReplace size={14} />}
                          onClick={() =>
                            dialogStore.trigger({
                              component: TrainingEditTagsModal,
                              props: {
                                selectedTags,
                                imageList,
                                modelId: model.id,
                                setImageList,
                                setSelectedTags,
                              },
                            })
                          }
                        >
                          {`Replace tag${selectedTags.length === 1 ? '' : 's'} (${
                            selectedTags.length
                          })`}
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                  {!tagList.length ? (
                    <Text size="md" my="sm" align="center">
                      No captions to display.
                    </Text>
                  ) : (
                    <Chip.Group
                      value={selectedTags}
                      onChange={setSelectedTags}
                      multiple
                      mah={300}
                      // mih={40}
                      // resize: 'vertical'
                      style={{ overflowY: 'auto', rowGap: '6px' }}
                    >
                      {tagList.map((t) => (
                        <Chip
                          key={t[0]}
                          value={t[0]}
                          styles={{
                            root: { lineHeight: 0, overflow: 'hidden' },
                            label: { display: 'flex' },
                            iconWrapper: { overflow: 'initial', paddingRight: '10px' },
                          }}
                        >
                          <Group h="100%" maw="100%">
                            {/* TODO when switching to m7, change this to a class */}
                            <Text
                              style={{
                                maxWidth: '90%',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {t[0]}
                            </Text>
                            <Badge color="gray" variant="outline" radius="xl" size="sm">
                              {t[1]}
                            </Badge>
                          </Group>
                        </Chip>
                      ))}
                    </Chip.Group>
                  )}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
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
                            setPage(Math.max(page - 1, 1));
                        }}
                        className={cx(classes.trash, 'trashIcon')}
                      >
                        <IconTrash />
                      </ActionIcon>
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
                    {/* would like to use highlight here for selected tags but only works with direct strings */}
                    {/* TODO we could also eventually replace these with little chips */}
                    <Textarea
                      placeholder="Enter caption data..."
                      autosize
                      disabled={autoCaptioning.isRunning}
                      minRows={1}
                      maxRows={4}
                      value={imgData.caption}
                      onChange={(event) => {
                        updateImage(model.id, {
                          matcher: getShortNameFromUrl(imgData),
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
