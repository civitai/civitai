import {
  Accordion,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Checkbox,
  Code,
  Divider,
  Group,
  Image as MImage,
  List,
  Loader,
  Modal,
  Pagination,
  Paper,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import type { FileWithPath } from '@mantine/dropzone';
import { openConfirmModal } from '@mantine/modals';
import type { NotificationData } from '@mantine/notifications';
import { hideNotification, showNotification, updateNotification } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCheck,
  IconCloudOff,
  IconFileDownload,
  IconInfoCircle,
  IconTags,
  IconTagsOff,
  IconTransferIn,
  IconTrash,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from '@tabler/icons-react';
import { clsx } from 'clsx';
import { saveAs } from 'file-saver';
import { capitalize, isEqual, uniq } from 'lodash-es';
import dynamic from 'next/dynamic';
import pLimit from 'p-limit';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import type { ImageSelectSource } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import type {
  ImageSelectModalProps,
  SelectedImage,
} from '~/components/Training/Form/ImageSelectModal';
import { getTextTagsAsList, goBack, goNext } from '~/components/Training/Form/TrainingCommon';
import {
  blankTagStr,
  labelDescriptions,
  TrainingImagesSwitchLabel,
  TrainingImagesTags,
  TrainingImagesTagViewer,
} from '~/components/Training/Form/TrainingImagesTagViewer';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';
import { constants } from '~/server/common/constants';
import { UploadType } from '~/server/common/enums';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import {
  IMAGE_MIME_TYPE,
  MIME_TYPES,
  VIDEO_MIME_TYPE,
  ZIP_MIME_TYPE,
} from '~/shared/constants/mime-types';
import { ModelFileVisibility } from '~/shared/utils/prisma/enums';
import { useS3UploadStore } from '~/store/s3-upload.store';
import {
  defaultTrainingState,
  defaultTrainingStateVideo,
  getShortNameFromUrl,
  type ImageDataType,
  type LabelTypes,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';
import type { TrainingModelData } from '~/types/router';
import { createImageElement } from '~/utils/image-utils';
import { getJSZip } from '~/utils/lazy';
import { auditPrompt } from '~/utils/metadata/audit';
import {
  showErrorNotification,
  showSuccessNotification,
  showWarningNotification,
} from '~/utils/notifications';
import { bytesToKB } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

import styles from './TrainingImages.module.scss';
import { useDomainColor } from '~/hooks/useDomainColor';
import { TrainingDatasetsView, DatasetConfig } from '~/components/Training/Form/TrainingDatasets';

const TrainingImagesCaptions = dynamic(
  () =>
    import('~/components/Training/Form/TrainingImagesCaptionViewer').then(
      (x) => x.TrainingImagesCaptions
    ),
  { ssr: false }
);
const TrainingImagesCaptionViewer = dynamic(
  () =>
    import('~/components/Training/Form/TrainingImagesCaptionViewer').then(
      (x) => x.TrainingImagesCaptionViewer
    ),
  { ssr: false }
);

const AutoLabelModal = dynamic(
  () => import('components/Training/Form/TrainingAutoLabelModal').then((m) => m.AutoLabelModal),
  { ssr: false }
);

const ImageSelectModal = dynamic(() => import('~/components/Training/Form/ImageSelectModal'), {
  ssr: false,
});

function openImageSelectModal(props: ImageSelectModalProps) {
  dialogStore.trigger({ component: ImageSelectModal, props });
}

const MAX_FILES_ALLOWED = 1000;

const limit = pLimit(10);

// TODO [bw] is this enough? do we want jfif?
const imageExts: { [key: string]: string } = {
  png: MIME_TYPES.png,
  jpg: MIME_TYPES.jpg,
  jpeg: MIME_TYPES.jpeg,
  webp: MIME_TYPES.webp,
};
const videoExts: { [key: string]: string } = {
  mp4: MIME_TYPES.mp4,
  webm: MIME_TYPES.webm,
};

const minWidth = 256;
const minHeight = 256;
const maxWidth = 2048;
const maxHeight = 2048;
// Absolute minimum - images below this will be rejected (training service requirement)
const absoluteMinDimension = 64;

const LabelSelectModal = ({
  modelId,
  mediaType,
}: {
  modelId: number;
  mediaType: TrainingDetailsObj['mediaType'];
}) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;

  const { labelType, imageList } = useTrainingImageStore(
    (state) =>
      state[modelId] ?? {
        ...(mediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState),
      }
  );
  const { setLabelType } = trainingStore;

  // I mean, this could probably be better
  const firstLabel = imageList.find((i) => i.label.length > 0)?.label;
  const estimatedType =
    (firstLabel?.length ?? 0) > 80 && // long string
    (firstLabel?.split(',')?.length ?? 0) < (firstLabel?.length ?? 0) * 0.05 // not many commas
      ? 'caption'
      : 'tag';

  const [labelValue, setLabelValue] = useState<LabelTypes>(estimatedType);

  const handleSelect = () => {
    setLabelType(modelId, mediaType, labelValue);
    handleClose();
  };

  return (
    <Modal
      {...dialog}
      centered
      size="md"
      radius="md"
      title={
        <Group gap="xs">
          <IconInfoCircle />
          <Text size="lg">Found labels</Text>
        </Group>
      }
    >
      <Stack>
        <Stack gap={0}>
          <Text>You&apos;ve included some labeling.</Text>
          <Text>Which type are they?</Text>
        </Stack>
        <Group gap="xs">
          <Text size="sm">Current type: </Text>
          <Badge>{labelType}</Badge>
        </Group>
        <Group gap="xs">
          <Text size="sm">Estimated type: </Text>
          <Badge color={labelType === estimatedType ? 'blue' : 'red'}>{estimatedType}</Badge>
        </Group>
        <SegmentedControl
          value={labelValue}
          data={constants.autoLabel.labelTypes.map((l) => ({
            label: capitalize(l),
            value: l,
          }))}
          onChange={(l) => setLabelValue(l as LabelTypes)}
          radius="sm"
          fullWidth
        />
        <Paper shadow="xs" radius="xs" p="md" withBorder>
          <Text component="div">{labelDescriptions[labelValue]}</Text>
        </Paper>
        <Group justify="flex-end" mt="xl">
          <Button onClick={handleSelect}>OK</Button>
        </Group>
      </Stack>
    </Modal>
  );
};

export const TrainingFormImages = ({ model }: { model: NonNullable<TrainingModelData> }) => {
  const thisModelVersion = model.modelVersions[0];
  const thisTrainingDetails = thisModelVersion.trainingDetails as TrainingDetailsObj | undefined;
  const thisMediaType = thisTrainingDetails?.mediaType ?? 'image';
  const isVideo = thisMediaType === 'video';
  const isImageEdit = thisTrainingDetails?.type === 'Image Edit';
  const thisDefaultTrainingState = isVideo ? defaultTrainingStateVideo : defaultTrainingState;
  const domainColor = useDomainColor();
  const isGreen = domainColor === 'green';

  const {
    updateImage,
    setImageList,
    setInitialImageList,
    setLabelType,
    setTriggerWord,
    setTriggerWordInvalid,
    setOwnRights,
    setShareDataset,
    setAttest,
    setInitialLabelType,
    setInitialTriggerWord,
    setInitialOwnRights,
    setInitialShareDataset,
    setAutoLabeling,
    updateDatasetImages,
    updateDatasetLabelType,
    updateDatasetImage,
  } = trainingStore;

  const {
    imageList,
    initialImageList,
    labelType,
    triggerWord,
    triggerWordInvalid,
    ownRights,
    shareDataset,
    attested,
    initialLabelType,
    initialTriggerWord,
    initialOwnRights,
    initialShareDataset,
    autoLabeling,
    autoCaptioning,
    datasets,
  } = useTrainingImageStore((state) => state[model.id] ?? { ...thisDefaultTrainingState });

  const [page, setPage] = useState(1);
  const [zipping, setZipping] = useState<boolean>(false);
  const [loadingZip, setLoadingZip] = useState<boolean>(false);
  const [modelFileId, setModelFileId] = useState<number | undefined>(undefined);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchCaption, setSearchCaption] = useState<string>('');
  const [isZoomed, setIsZoomed] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [accordionUpload, setAccordionUpload] = useState<string | null>(
    imageList.length > 0 ? null : 'uploading'
  );
  const showImgResizeDown = useRef<number>(0);
  const showImgResizeUp = useRef<number>(0);
  const showImgTooSmall = useRef<string[]>([]);
  const showImgCorrupt = useRef<string[]>([]);

  const theme = useMantineTheme();
  const queryUtils = trpc.useUtils();
  const { upload, getStatus: getUploadStatus } = useS3UploadStore();
  const { connected } = useSignalContext();

  const existingDataFile = thisModelVersion.files[0];
  const existingMetadata = existingDataFile?.metadata as FileMetadata | null;

  const notificationId = `${thisModelVersion.id}-uploading-data-notification`;
  const notificationFailBase: NotificationData & { id: string } = {
    id: notificationId,
    icon: <IconX size={18} />,
    color: 'red',
    title: 'Failed to upload archive',
    message: 'Please try again (or contact us if it continues)',
    autoClose: false,
    loading: false,
  };

  const mediaExts = isVideo ? { ...imageExts, ...videoExts } : imageExts;
  const allowedDropTypes = [
    ...IMAGE_MIME_TYPE,
    ...ZIP_MIME_TYPE,
    ...(isVideo ? VIDEO_MIME_TYPE : []),
  ];

  const { uploading } = getUploadStatus((file) => file.meta?.versionId === thisModelVersion.id);

  const thisStep = 2;
  const maxImgPerPage = 9;

  const getResizedImgUrl = async (
    data: FileWithPath | Blob,
    type: string,
    fileName?: string
  ): Promise<string> => {
    const blob = new Blob([data], { type: type });
    const imgUrl = URL.createObjectURL(blob);

    // Skip validation for non-image types (e.g., videos)
    if (!IMAGE_MIME_TYPE.includes(type as never)) return imgUrl;

    let img: HTMLImageElement;
    try {
      img = await createImageElement(imgUrl);
    } catch (loadError) {
      const name = fileName ?? 'image';
      console.error(`[ImageValidation] createImageElement failed for "${name}"`, {
        error: loadError,
        errorMessage: loadError instanceof Error ? loadError.message : String(loadError),
        type,
      });
      URL.revokeObjectURL(imgUrl);
      showImgCorrupt.current.push(name);
      throw new Error(`Image "${name}" failed to load and may be corrupt.`);
    }

    let { width, height } = img;

    // Hard reject images where EITHER dimension is below the absolute minimum
    // The training service requires images to be at least 64px in both dimensions
    if (width < absoluteMinDimension || height < absoluteMinDimension) {
      URL.revokeObjectURL(imgUrl);
      const name = fileName ?? 'image';
      showImgTooSmall.current.push(name);
      throw new Error(
        `Image "${name}" is too small (${width}x${height}). Minimum dimension is ${absoluteMinDimension}px.`
      );
    }

    // Note: Image integrity is already validated by createImageElement() which loads
    // the image and attempts decode(). If we reach this point, the image loaded successfully.
    // Previous canvas-based validation was removed as it caused false positives under
    // memory pressure when processing large batches of images concurrently.

    // both w and h must be less than the max
    const goodMax = width <= maxWidth && height <= maxHeight;
    // one of h and w must be more than the min
    const goodMin = width >= minWidth || height >= minHeight;

    if (goodMax && goodMin) return imgUrl;

    if (!goodMax) {
      if (width > height) {
        if (width > maxWidth) {
          height = height * (maxWidth / width);
          width = maxWidth;
          showImgResizeDown.current += 1;
        }
      } else {
        if (height > maxHeight) {
          width = width * (maxHeight / height);
          height = maxHeight;
          showImgResizeDown.current += 1;
        }
      }
    } else if (!goodMin) {
      if (width > height) {
        height = height * (minWidth / width);
        width = minWidth;
        showImgResizeUp.current += 1;
      } else {
        width = width * (minHeight / height);
        height = minHeight;
        showImgResizeUp.current += 1;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Error resizing image');
    ctx.drawImage(img, 0, 0, width, height);

    // Normalize MIME type - 'image/jpg' is not valid, browsers expect 'image/jpeg'
    const normalizedType = type === 'image/jpg' ? 'image/jpeg' : type;
    // Use high quality for JPEG to prevent compression artifacts
    const quality = normalizedType === 'image/jpeg' ? 0.92 : undefined;

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (file) => {
          // Revoke the original blob URL to prevent memory leaks
          URL.revokeObjectURL(imgUrl);
          if (!file) {
            reject(
              new Error(`Failed to resize image - canvas.toBlob returned null for type ${type}`)
            );
          } else {
            resolve(URL.createObjectURL(file));
          }
        },
        normalizedType,
        quality
      );
    });
  };

  const showResizeWarnings = () => {
    if (showImgResizeDown.current) {
      showWarningNotification({
        title: `${showImgResizeDown.current} file${
          showImgResizeDown.current === 1 ? '' : 's'
        } resized down`,
        message: `Max image dimensions are ${maxWidth}w and ${maxHeight}h.`,
        autoClose: false,
      });
      showImgResizeDown.current = 0;
    }
    if (showImgResizeUp.current) {
      showWarningNotification({
        title: `${showImgResizeUp.current} file${
          showImgResizeUp.current === 1 ? '' : 's'
        } resized up`,
        message: `Min image dimensions are ${minWidth}w or ${minHeight}h.`,
        autoClose: false,
      });
      showImgResizeUp.current = 0;
    }

    if (showImgTooSmall.current.length) {
      const count = showImgTooSmall.current.length;
      const fileNames =
        count <= 3
          ? showImgTooSmall.current.join(', ')
          : `${showImgTooSmall.current.slice(0, 3).join(', ')} and ${count - 3} more`;
      showErrorNotification({
        title: `${count} file${count === 1 ? '' : 's'} rejected - too small`,
        error: new Error(
          `Images must be at least ${absoluteMinDimension}x${absoluteMinDimension}px. Skipped: ${fileNames}`
        ),
        autoClose: false,
      });
      showImgTooSmall.current = [];
    }
    if (showImgCorrupt.current.length) {
      const count = showImgCorrupt.current.length;
      const fileNames =
        count <= 3
          ? showImgCorrupt.current.join(', ')
          : `${showImgCorrupt.current.slice(0, 3).join(', ')} and ${count - 3} more`;
      showErrorNotification({
        title: `${count} file${count === 1 ? '' : 's'} rejected - corrupt`,
        error: new Error(`These images appear to be corrupt and were skipped: ${fileNames}`),
        autoClose: false,
      });
      showImgCorrupt.current = [];
    }
  };

  const parseExisting = async (mvId: number) => {
    const url = createModelFileDownloadUrl({
      versionId: mvId,
      type: 'Training Data',
    });
    const result = await fetch(url);
    if (!result.ok) {
      return;
    }
    const blob = await result.blob();
    return new File([blob], `${mvId}_training_data.zip`, {
      type: blob.type,
    });
  };

  const parseExistingAndHandle = async (mvId: number) => {
    const zipFile = await parseExisting(mvId);
    if (!zipFile) return;
    return await handleZip(zipFile, false);
  };

  const handleZip = async (f: FileWithPath, showNotif = true, source?: ImageDataType['source']) => {
    if (showNotif) setLoadingZip(true);

    const parsedFiles: ImageDataType[] = [];

    const zipReader = await getJSZip();
    const zData = await zipReader.loadAsync(f);

    const zipEntries = Object.entries(zData.files);
    const imageEntries = zipEntries.filter(([zname, zf]) => {
      if (zf.dir) return false;
      if (zname.startsWith('__MACOSX/') || zname.endsWith('.DS_STORE')) return false;
      const fileExt = (zname.split('.').pop() || '').toLowerCase();
      return fileExt in mediaExts;
    });

    console.log(
      `[ZipProcessing] Starting to process ${imageEntries.length} images from zip (total entries: ${zipEntries.length})`
    );
    let completedCount = 0;
    const totalImages = imageEntries.length;

    // Use pLimit to process images with controlled concurrency (max 10 at a time)
    // This prevents memory pressure from loading too many images simultaneously
    const ret = await Promise.all(
      Object.entries(zData.files).map(([zname, zf]) =>
        limit(async () => {
          let hasLabelFiles = false;

          if (zf.dir) return;
          if (zname.startsWith('__MACOSX/') || zname.endsWith('.DS_STORE')) return;

          // - we could read the type here with some crazy blob/hex inspecting
          const fileSplit = zname.split('.');
          const fileExt = (fileSplit.pop() || '').toLowerCase();
          const baseFileName = fileSplit.join('.');
          if (fileExt in mediaExts) {
            const imgBlob = await zf.async('blob');
            try {
              const scaledUrl = await getResizedImgUrl(imgBlob, mediaExts[fileExt], zname);
              const czFile = zipReader.file(`${baseFileName}.txt`);
              let labelStr = '';
              if (czFile) {
                labelStr = await czFile.async('string');
                hasLabelFiles = true;
              }
              parsedFiles.push({
                name: zname,
                type: mediaExts[fileExt],
                url: scaledUrl,
                label: labelStr,
                invalidLabel: false,
                source: source ?? null,
              });
              completedCount++;
              // Log progress every 10 images to reduce console spam
              if (completedCount % 10 === 0 || completedCount === totalImages) {
                console.log(`[ZipProcessing] Progress: ${completedCount}/${totalImages}`);
              }
            } catch (err) {
              completedCount++;
              console.error(
                `[ZipProcessing] Failed "${zname}" (${completedCount}/${totalImages})`,
                err
              );
              // Error already tracked and will be shown in showResizeWarnings
            }
          }
          return hasLabelFiles;
        })
      )
    );

    const hasAnyLabelFiles = ret.some((r) => r === true);

    showResizeWarnings();

    if (showNotif) {
      if (parsedFiles.length > 0) {
        showSuccessNotification({
          title: 'Zip parsed successfully!',
          message: `Found ${parsedFiles.length} files.`,
        });
      } else {
        showErrorNotification({
          error: new Error('Could not find any valid files in zip.'),
          autoClose: false,
        });
      }
      setLoadingZip(false);
    }

    return { parsedFiles, hasAnyLabelFiles };
  };

  const handleDrop = async (
    fileList: FileWithPath[],
    data?: { [p: string]: Pick<ImageDataType, 'label' | 'source'> },
    datasetId?: number
  ) => {
    const newFiles = await Promise.all(
      fileList.map(async (f) => {
        if (ZIP_MIME_TYPE.includes(f.type as never) || f.name.endsWith('.zip')) {
          const source = data?.[f.name]?.source ?? null;
          return await handleZip(f, !source, source);
        } else if (!allowedDropTypes.includes(f.type as never)) {
          showErrorNotification({
            error: new Error(`Skipping invalid file: "${f.name}".`),
          });
          return { parsedFiles: [] as ImageDataType[], hasAnyLabelFiles: false };
        } else {
          try {
            const scaledUrl = await getResizedImgUrl(f, f.type, f.name);
            const label = data?.[f.name]?.label ?? '';
            const source = data?.[f.name]?.source ?? null;
            const parsed: ImageDataType[] = [
              { name: f.name, type: f.type, url: scaledUrl, invalidLabel: false, label, source },
            ];

            return {
              parsedFiles: parsed,
              hasAnyLabelFiles: label !== '',
            };
          } catch {
            // Error already tracked and will be shown in showResizeWarnings
            return { parsedFiles: [] as ImageDataType[], hasAnyLabelFiles: false };
          }
        }
      })
    );

    showResizeWarnings();

    const filteredFiles = newFiles
      .map((nf) => nf.parsedFiles)
      .flat()
      .filter(isDefined);

    // Determine target list for max file check
    const targetList =
      datasetId !== undefined
        ? datasets.find((d) => d.id === datasetId)?.imageList ?? []
        : imageList;

    if (filteredFiles.length > MAX_FILES_ALLOWED - targetList.length) {
      showErrorNotification({
        title: 'Too many files',
        error: new Error(`Truncating to ${MAX_FILES_ALLOWED}.`),
        autoClose: false,
      });
      filteredFiles.splice(MAX_FILES_ALLOWED - targetList.length);
    }

    // Add images to specific dataset or global imageList
    if (datasetId !== undefined) {
      updateDatasetImages(model.id, thisMediaType, datasetId, targetList.concat(filteredFiles));
    } else {
      setImageList(model.id, thisMediaType, imageList.concat(filteredFiles));
    }

    const labelsPresent = newFiles.map((nf) => nf.hasAnyLabelFiles).some((hl) => hl);
    if (labelsPresent) {
      dialogStore.trigger({
        component: LabelSelectModal,
        props: { modelId: model.id, mediaType: thisMediaType },
      });
    }

    if (filteredFiles.length > 0) {
      setAccordionUpload(null);
    }
  };

  const handleImport = async (
    assets: SelectedImage[],
    source: ImageSelectSource,
    datasetId?: number
  ) => {
    const importNotifId = `${thisModelVersion.id}-importing-asset-${new Date().toISOString()}`;
    showNotification({
      id: importNotifId,
      loading: true,
      autoClose: false,
      withCloseButton: false,
      message: `Importing ${assets.length} ${source === 'training' ? 'dataset' : 'asset'}${
        assets.length !== 1 ? 's' : ''
      }...`,
    });

    let files;
    if (source === 'training') {
      files = await Promise.all(
        assets.map(async (i) => {
          try {
            const file = await parseExisting(Number(i.url));
            if (!file) return;

            return {
              file,
              url: i.url,
              label: '',
            };
          } catch (e) {
            return;
          }
        })
      );
    } else {
      files = await Promise.all(
        assets.map((i, idx) =>
          limit(async () => {
            try {
              const result = await fetch(getEdgeUrl(i.url));
              if (!result.ok) return;

              const blob = await result.blob();
              return {
                file: new File(
                  [blob],
                  `imported_${new Date().toISOString()}_${idx}.${
                    i.type === 'video' ? 'mp4' : 'jpg'
                  }`,
                  {
                    type: [...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE].includes(blob.type as never)
                      ? blob.type
                      : i.type === 'video'
                      ? MIME_TYPES.mp4
                      : MIME_TYPES.jpeg,
                  }
                ),
                label: i.label,
                url: i.url,
              };
            } catch (e) {
              return;
            }
          })
        )
      );
    }

    const goodFiles = files.filter(isDefined);

    if (goodFiles.length !== 0) {
      await handleDrop(
        goodFiles.map((f) => f.file),
        goodFiles.reduce(
          (acc, f) => ({
            ...acc,
            [f.file.name]: { label: f.label, source: { type: source, url: f.url } },
          }),
          {} as Record<string, Pick<ImageDataType, 'label' | 'source'>>
        ),
        datasetId
      );
    }

    const fileDiff = files.length - goodFiles.length;

    hideNotification(importNotifId);

    if (fileDiff !== 0) {
      showWarningNotification({
        message: `${fileDiff} ${source === 'training' ? 'dataset' : 'file'}${
          fileDiff === 1 ? '' : 's'
        } could not be imported`,
        autoClose: false,
      });
    }
  };

  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation({
    async onSuccess(_response, request) {
      setInitialTriggerWord(model.id, thisMediaType, triggerWord);

      queryUtils.training.getModelBasic.setData({ id: model.id }, (old) => {
        if (!old) return old;

        const versionToUpdate = old.modelVersions.find((mv) => mv.id === thisModelVersion.id);
        if (!versionToUpdate) return old;
        versionToUpdate.trainedWords = request.trainedWords ?? [];

        return {
          ...old,
          modelVersions: [
            versionToUpdate,
            ...old.modelVersions.filter((mv) => mv.id !== thisModelVersion.id),
          ],
        };
      });

      await queryUtils.model.getMyTrainingModels.invalidate();
    },
  });
  const updateFileMutation = trpc.modelFile.update.useMutation({
    async onSuccess(_response, request) {
      setInitialLabelType(model.id, thisMediaType, labelType);
      setInitialOwnRights(model.id, thisMediaType, ownRights);
      setInitialShareDataset(model.id, thisMediaType, shareDataset);

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

      await queryUtils.model.getMyTrainingModels.invalidate();
      // queryUtils.model.getMyTrainingModels.setInfiniteData(
      //   {}, // fix this to have right filters
      //   produce((old) => {
      //     if (!old?.pages?.length) return;
      //
      //     for (const page of old.pages) {
      //       for (const item of page.items) {
      //         if (item.id === thisModelVersion.id) {
      //           item.files[0].metadata = request.metadata!;
      //           return;
      //         }
      //       }
      //     }
      //   })
      // );
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
        withCloseButton: false,
        loading: false,
      });

      setInitialImageList(model.id, thisMediaType, imageList);

      queryUtils.training.getModelBasic.setData({ id: model.id }, (old) => {
        if (!old) return old;

        const versionToUpdate = old.modelVersions.find((mv) => mv.id === thisModelVersion.id);
        if (!versionToUpdate) return old;
        versionToUpdate.files = [
          {
            id: response.id,
            name: request.name!,
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

      await queryUtils.model.getMyTrainingModels.invalidate();

      // queryUtils.model.getMyTrainingModels.setInfiniteData(
      //   {}, // fix this to have limit and page?
      //   produce((old) => {
      //     if (!old?.pages?.length) return;
      //
      //     for (const page of old.pages) {
      //       for (const item of page.items) {
      //         if (item.id === thisModelVersion.id) {
      //           item.files = [
      //             {
      //               id: response.id,
      //               url: request.url!,
      //               type: request.type!,
      //               metadata: request.metadata!,
      //               sizeKB: request.sizeKB!,
      //             },
      //           ];
      //           return;
      //         }
      //       }
      //     }
      //   })
      // );

      goNext(model.id, thisStep, () => setZipping(false));
    },
    onError(error) {
      setZipping(false);
      updateNotification({
        ...notificationFailBase,
        message: error.message,
      });
    },
  });

  const submitTagMutation = trpc.training.autoTag.useMutation({
    // TODO allow people to rerun failed images
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to auto tag',
        autoClose: false,
      });
      setAutoLabeling(model.id, thisMediaType, { ...thisDefaultTrainingState.autoLabeling });
    },
  });
  const submitCaptionMutation = trpc.training.autoCaption.useMutation({
    // TODO allow people to rerun failed images
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Failed to auto caption',
        autoClose: false,
      });
      setAutoLabeling(model.id, thisMediaType, { ...thisDefaultTrainingState.autoLabeling });
    },
  });

  useEffect(() => {
    if (existingDataFile) {
      setModelFileId(existingDataFile.id);
      const fileLabelType = existingMetadata?.labelType ?? 'tag';
      const fileOwnRights = existingMetadata?.ownRights ?? false;
      const fileShareDataset = existingMetadata?.shareDataset ?? false;

      setLabelType(model.id, thisMediaType, fileLabelType);
      setInitialLabelType(model.id, thisMediaType, fileLabelType);
      setOwnRights(model.id, thisMediaType, fileOwnRights);
      setInitialOwnRights(model.id, thisMediaType, fileOwnRights);
      setShareDataset(model.id, thisMediaType, fileShareDataset);
      setInitialShareDataset(model.id, thisMediaType, fileShareDataset);

      const thisTrainedWord =
        thisModelVersion.trainedWords && thisModelVersion.trainedWords.length > 0
          ? thisModelVersion.trainedWords[0]
          : '';
      setTriggerWord(model.id, thisMediaType, thisTrainedWord);
      setInitialTriggerWord(model.id, thisMediaType, thisTrainedWord);

      if (imageList.length === 0) {
        setLoadingZip(true);
        parseExistingAndHandle(thisModelVersion.id)
          .then((files) => {
            if (files) {
              const flatFiles = files.parsedFiles.flat();
              setImageList(model.id, thisMediaType, flatFiles);
              setInitialImageList(
                model.id,
                thisMediaType,
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

  useEffect(() => {
    if (autoLabeling.isRunning || !autoLabeling.url) return;
    setAutoLabeling(model.id, thisMediaType, { isRunning: true });

    if (labelType === 'caption') {
      submitCaptionMutation.mutate({
        modelId: model.id,
        url: autoLabeling.url,
        temperature: autoCaptioning.temperature,
        maxNewTokens: autoCaptioning.maxNewTokens,
      });
    } else {
      submitTagMutation.mutate({ modelId: model.id, url: autoLabeling.url });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLabeling.url]);

  const hasIssues = imageList.some((i) => i.invalidLabel);

  const filteredImages = useMemo(() => {
    return imageList.filter((i) => {
      if (hasIssues && onlyIssues && !i.invalidLabel) return false;

      if (labelType === 'caption') {
        if (!searchCaption.length && !selectedTags.length) return true;
        if (selectedTags.includes(blankTagStr) && i.label.length === 0) return true;
        return searchCaption.length > 0
          ? i.label.toLowerCase().includes(searchCaption.toLowerCase())
          : false;
      } else {
        if (!selectedTags.length) return true;
        const capts: string[] = [];
        if (selectedTags.includes(blankTagStr) && getTextTagsAsList(i.label).length === 0)
          capts.push(blankTagStr);
        const mergedCapts = capts.concat(
          getTextTagsAsList(i.label).filter((c) => selectedTags.includes(c))
        );
        return mergedCapts.length > 0;
      }
    });
  }, [imageList, labelType, selectedTags, searchCaption, onlyIssues, hasIssues]);

  useEffect(() => {
    if (page > 1 && filteredImages.length <= (page - 1) * maxImgPerPage) {
      setPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTags, searchCaption]);

  const handleNextAfterCheck = async (dlOnly = false) => {
    setZipping(true);

    const zip = await getJSZip();

    await Promise.all(
      imageList.map(async (imgData, idx) => {
        const filenameBase = String(idx).padStart(3, '0');

        let label = imgData.label;

        if (triggerWord.length) {
          const separator = labelType === 'caption' ? '' : ',';
          const regMatch =
            labelType === 'caption'
              ? new RegExp(`^${triggerWord}( |$)`)
              : new RegExp(`^${triggerWord}(${separator}|$)`);

          if (!regMatch.test(label)) {
            label =
              label.length > 0
                ? labelType === 'caption'
                  ? [triggerWord, label].join(' ')
                  : [triggerWord, label].join(`${separator} `)
                : triggerWord;
          }
        }

        label.length > 0 && zip.file(`${filenameBase}.txt`, label);

        const imgBlob = await fetch(imgData.url).then((res) => res.blob());

        // TODO [bw] unregister here

        zip.file(`${filenameBase}.${imgData.type.split('/').pop() ?? 'jpeg'}`, imgBlob);
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

      hideNotification(notificationId);
      showNotification({
        id: notificationId,
        loading: true,
        autoClose: false,
        withCloseButton: false,
        title: 'Creating and uploading archive',
        message: `Packaging ${imageList.length} file${imageList.length !== 1 ? 's' : ''}...`,
      });

      try {
        await upsertVersionMutation.mutateAsync({
          id: thisModelVersion.id,
          name: thisModelVersion.name,
          modelId: model.id,
          baseModel: thisModelVersion.baseModel as BaseModel,
          trainedWords: triggerWord.length ? [triggerWord] : [],
        });
      } catch (e: unknown) {
        setZipping(false);
        updateNotification({
          ...notificationFailBase,
          message:
            e instanceof Error
              ? e.message.startsWith('Unexpected token')
                ? 'Server error :('
                : e.message
              : '',
        });
        return;
      }

      const blobFile = new File([content], fileName, {
        type: 'application/zip',
      });

      try {
        const uploadResp = await upload(
          {
            file: blobFile,
            type: UploadType.TrainingImages,
            meta: {
              versionId: thisModelVersion.id,
              labelType,
              ownRights,
              shareDataset,
              numImages: imageList.length,
              numCaptions: imageList.filter((i) => i.label.length > 0).length,
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
                  ...notificationFailBase,
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
            ...notificationFailBase,
          });
        }
      } catch (e) {
        setZipping(false);
        updateNotification({
          ...notificationFailBase,
          message:
            e instanceof Error
              ? e.message.startsWith('Unexpected token')
                ? 'Server error :('
                : e.message
              : '',
        });
      }
    });
  };

  const handleNext = async () => {
    if (!attested.status) {
      setAttest(model.id, thisMediaType, {
        ...attested,
        error: 'You must agree before proceeding.',
      });
      return;
    }
    setAttest(model.id, thisMediaType, { ...attested, error: '' });

    if (
      isEqual(imageList, initialImageList) &&
      isEqual(triggerWord, initialTriggerWord) &&
      imageList.length !== 0
    ) {
      if (
        !isEqual(shareDataset, initialShareDataset) ||
        !isEqual(ownRights, initialOwnRights) ||
        !isEqual(labelType, initialLabelType)
      ) {
        setZipping(true);
        await updateFileMutation.mutateAsync({
          id: modelFileId!,
          metadata: { ...existingMetadata!, ownRights, shareDataset, labelType },
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
      if (isVideo && imageList.some((i) => i.label.length === 0)) {
        showErrorNotification({
          error: new Error('All files must have a label for video training'),
          autoClose: false,
        });
        return;
      }

      const issues: string[] = [];

      const { blockedFor, success } = auditPrompt(triggerWord, undefined, isGreen);
      if (!success) {
        issues.push(...blockedFor);
        if (!triggerWordInvalid) {
          setTriggerWordInvalid(model.id, thisMediaType, true);
        }
      } else {
        if (triggerWordInvalid) {
          setTriggerWordInvalid(model.id, thisMediaType, false);
        }
      }

      imageList.forEach((i) => {
        if (i.label.length > 0) {
          const { blockedFor, success } = auditPrompt(i.label, undefined, isGreen);
          if (!success) {
            issues.push(...blockedFor);
            if (!i.invalidLabel) {
              updateImage(model.id, thisMediaType, {
                matcher: getShortNameFromUrl(i),
                invalidLabel: true,
              });
            }
          } else {
            if (i.invalidLabel) {
              updateImage(model.id, thisMediaType, {
                matcher: getShortNameFromUrl(i),
                invalidLabel: false,
              });
            }
          }
        } else {
          if (i.invalidLabel) {
            updateImage(model.id, thisMediaType, {
              matcher: getShortNameFromUrl(i),
              invalidLabel: false,
            });
          }
        }
      });
      if (issues.length > 0) {
        showNotification({
          icon: <IconX size={18} />,
          autoClose: false,
          color: 'red',
          title: 'Inappropriate labels',
          message: `One or more labels/trigger words have been blocked. Please review these and resubmit. Reason: ${uniq(
            issues
          ).join(', ')}`,
        });
        return;
      }

      // if no labels, warn
      if (imageList.filter((i) => i.label.length > 0).length === 0 && !triggerWord.length) {
        return openConfirmModal({
          title: (
            <Group gap="xs">
              <IconAlertTriangle color="gold" />
              <Text size="lg">Missing labels</Text>
            </Group>
          ),
          children:
            'You have not provided any labels for your files. This can produce an inflexible model. We will also attempt to generate sample files, but they may not be what you are looking for. Are you sure you want to continue?',
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
        title: 'No files provided',
        message: 'Must select at least 1 file.',
      });
    }
  };

  const totalLabeled = imageList.filter((i) => i.label && i.label.length > 0).length;

  const importedUrls = useMemo(
    () => imageList.filter((i) => isDefined(i.source?.url)).map((i) => i.source!.url!),
    [imageList]
  );

  useCatchNavigation({
    unsavedChanges:
      !isEqual(imageList, initialImageList) ||
      !isEqual(shareDataset, initialShareDataset) ||
      !isEqual(ownRights, initialOwnRights) ||
      !isEqual(labelType, initialLabelType) ||
      !isEqual(triggerWord, initialTriggerWord),
    // message: ``,
  });

  // Image Edit training uses multi-dataset view
  if (isImageEdit) {
    return (
      <>
        <Stack>
          <Paper mb="md" radius="md" p="xl" withBorder>
            <div className="flex flex-col gap-4">
              <Title order={4}>Acknowledgement</Title>
              {attested.status ? (
                <ContentClamp maxHeight={28}>
                  <AttestDiv />
                </ContentClamp>
              ) : (
                <div>
                  <AttestDiv />
                </div>
              )}
              <Checkbox
                label="By agreeing to this attestation, I acknowledge that I have complied with these conditions and accept full responsibility for any legal or ethical implications that arise from the use of this content."
                checked={attested.status}
                error={attested.error}
                onChange={(event) =>
                  setAttest(model.id, thisMediaType, {
                    status: event.currentTarget.checked,
                    error: '',
                  })
                }
              />
            </div>
          </Paper>

          {attested.status && (
            <TrainingDatasetsView model={model}>
              {(dataset) => {
                const datasetImportedUrls = dataset.imageList
                  .filter((i) => isDefined(i.source?.url))
                  .map((i) => i.source!.url!);

                return (
                  <Stack>
                    {/* Import buttons */}
                    <Paper p="md" withBorder radius="sm">
                      <Stack>
                        <Text size="sm">
                          Add images to this dataset from various sources, or drag and drop files
                          below.
                        </Text>
                        <Group mt="xs" justify="center" grow>
                          <Button
                            variant="light"
                            onClick={() => {
                              openImageSelectModal({
                                title: 'Select Media',
                                selectSource: 'generation',
                                onSelect: async (media) => {
                                  await handleImport(media, 'generation', dataset.id);
                                },
                                importedUrls: datasetImportedUrls,
                                videoAllowed: false,
                              });
                            }}
                          >
                            Import from Generator
                          </Button>
                          <Button
                            variant="light"
                            onClick={() => {
                              openImageSelectModal({
                                title: 'Select Media',
                                selectSource: 'uploaded',
                                onSelect: async (media) => {
                                  await handleImport(media, 'uploaded', dataset.id);
                                },
                                importedUrls: datasetImportedUrls,
                                videoAllowed: false,
                              });
                            }}
                          >
                            Add from Profile
                          </Button>
                          <Button
                            variant="light"
                            onClick={() => {
                              openImageSelectModal({
                                title: 'Select Datasets',
                                selectSource: 'training',
                                onSelect: async (datasets) => {
                                  await handleImport(datasets, 'training', dataset.id);
                                },
                                importedUrls: datasetImportedUrls,
                                videoAllowed: false,
                              });
                            }}
                          >
                            Re-use a Dataset
                          </Button>
                        </Group>

                        <Divider label="OR" labelPosition="center" />

                        <ImageDropzone
                          onDrop={async (files) => {
                            await handleDrop(files, undefined, dataset.id);
                          }}
                          label="Drag images or zips here (or click to select files)"
                          description={
                            <Text mt="xs" fz="sm" c={theme.colors.red[5]}>
                              Changes made here are not permanently saved until you hit
                              &quot;Next&quot;
                            </Text>
                          }
                          max={MAX_FILES_ALLOWED}
                          count={dataset.imageList.length}
                          accept={[...IMAGE_MIME_TYPE, ...ZIP_MIME_TYPE]}
                          onExceedMax={() =>
                            showErrorNotification({
                              title: 'Too many files',
                              error: new Error(`Truncating to ${MAX_FILES_ALLOWED}.`),
                              autoClose: false,
                            })
                          }
                        />
                      </Stack>
                    </Paper>

                    {/* Images section (simplified - no labeling for Image Edit) */}
                    {dataset.imageList.length > 0 && (
                      <Paper p="md" withBorder radius="sm">
                        <Stack>
                          <Group justify="space-between">
                            <Text fw={500}>Images ({dataset.imageList.length})</Text>
                            <Button
                              size="compact-xs"
                              color="red"
                              variant="subtle"
                              leftSection={<IconTrash size={14} />}
                              onClick={() => {
                                openConfirmModal({
                                  title: 'Clear all images?',
                                  children: `This will remove all ${dataset.imageList.length} images from this dataset.`,
                                  labels: { cancel: 'Cancel', confirm: 'Clear All' },
                                  confirmProps: { color: 'red' },
                                  centered: true,
                                  onConfirm: () =>
                                    updateDatasetImages(model.id, thisMediaType, dataset.id, []),
                                });
                              }}
                            >
                              Clear All
                            </Button>
                          </Group>

                          {/* Image grid - shows filename for pairing reference */}
                          <SimpleGrid cols={{ base: 2, sm: 4, md: 6 }}>
                            {dataset.imageList.map((imgData, index) => (
                              <Card
                                key={`${imgData.url}-${index}`}
                                shadow="sm"
                                radius="sm"
                                withBorder
                                className="p-0"
                              >
                                <div className={styles.imgOverlay}>
                                  <Group gap={4} className={clsx(styles.trash)}>
                                    <Tooltip label="Remove file">
                                      <LegacyActionIcon
                                        color="red"
                                        variant="filled"
                                        size="sm"
                                        onClick={() => {
                                          const newList = dataset.imageList.filter(
                                            (i) => i.url !== imgData.url
                                          );
                                          updateDatasetImages(
                                            model.id,
                                            thisMediaType,
                                            dataset.id,
                                            newList
                                          );
                                        }}
                                      >
                                        <IconTrash size={14} />
                                      </LegacyActionIcon>
                                    </Tooltip>
                                  </Group>
                                  <MImage
                                    alt={imgData.name}
                                    src={imgData.url}
                                    style={{
                                      height: '100px',
                                      width: '100%',
                                      objectFit: 'cover',
                                    }}
                                  />
                                </div>
                                {/* Show filename for pairing reference */}
                                <Text
                                  size="xs"
                                  c="dimmed"
                                  ta="center"
                                  p={4}
                                  className="truncate"
                                  title={imgData.name}
                                >
                                  {imgData.name}
                                </Text>
                              </Card>
                            ))}
                          </SimpleGrid>
                        </Stack>
                      </Paper>
                    )}
                  </Stack>
                );
              }}
            </TrainingDatasetsView>
          )}
        </Stack>
        <Group justify="flex-end" mt="xl">
          <Button variant="default" onClick={() => goBack(model.id, thisStep)}>
            Back
          </Button>
          <Button
            onClick={handleNext}
            disabled={autoLabeling.isRunning}
            loading={zipping || uploading > 0}
          >
            Next
          </Button>
        </Group>
      </>
    );
  }

  return (
    <>
      <Stack>
        {attested.status && (
          <>
            <Accordion
              value={accordionUpload}
              onChange={setAccordionUpload}
              styles={(theme) => ({
                content: {
                  padding: theme.spacing.xs,
                },
                item: {
                  // overflow: 'hidden',
                  border: 'none',
                  background: 'transparent',
                },
                control: {
                  padding: theme.spacing.xs,
                  lineHeight: 'normal',
                },
              })}
            >
              <Accordion.Item value="uploading">
                <Accordion.Control>Upload Files</Accordion.Control>
                <Accordion.Panel>
                  <Stack>
                    <Text size="sm">
                      You can add an existing dataset for your model, or create a new one here. Not
                      sure what to do? Read our{' '}
                      <Anchor
                        href="https://education.civitai.com/using-civitai-the-on-site-lora-trainer"
                        target="_blank"
                        rel="nofollow noreferrer"
                      >
                        Dataset and Training Guidelines
                      </Anchor>{' '}
                      for more info.
                    </Text>

                    <Group mt="xs" justify="center" grow>
                      <Button
                        variant="light"
                        onClick={() => {
                          openImageSelectModal({
                            title: 'Select Media',
                            selectSource: 'generation',
                            onSelect: async (media) => {
                              await handleImport(media, 'generation');
                            },
                            importedUrls,
                            videoAllowed: isVideo,
                          });
                        }}
                      >
                        Import from Generator
                      </Button>
                      <Button
                        variant="light"
                        onClick={() => {
                          openImageSelectModal({
                            title: 'Select Media',
                            selectSource: 'uploaded',
                            onSelect: async (media) => {
                              await handleImport(media, 'uploaded');
                            },
                            importedUrls,
                            videoAllowed: isVideo,
                          });
                        }}
                      >
                        Add from Profile
                      </Button>
                      <Button
                        variant="light"
                        onClick={() => {
                          openImageSelectModal({
                            title: 'Select Datasets',
                            selectSource: 'training',
                            onSelect: async (datasets) => {
                              await handleImport(datasets, 'training');
                            },
                            importedUrls,
                            videoAllowed: isVideo,
                          });
                        }}
                      >
                        Re-use a Dataset
                      </Button>
                    </Group>

                    <Divider label="OR" labelPosition="center" />

                    {isVideo && (
                      <DismissibleAlert
                        color="green"
                        // eslint-disable-next-line tailwindcss/migration-from-tailwind-2
                        className="bg-emerald-200 bg-opacity-20 dark:bg-emerald-900 dark:bg-opacity-20"
                        title="Now accepting videos!"
                        content={
                          <Text>
                            You can now upload videos for training (<Code color="teal">mp4</Code>{' '}
                            and <Code color="teal">webm</Code>).
                          </Text>
                        }
                        id="training-accept-videos-alert"
                      />
                    )}

                    <ImageDropzone
                      onDrop={handleDrop}
                      label={`${
                        isVideo ? 'Drag images, zips, or videos' : 'Drag images or zips'
                      } here (or click to select files)`}
                      description={
                        <Text mt="xs" fz="sm" c={theme.colors.red[5]}>
                          Changes made here are not permanently saved until you hit &quot;Next&quot;
                        </Text>
                      }
                      max={MAX_FILES_ALLOWED}
                      // loading={isLoading}
                      count={imageList.length}
                      accept={allowedDropTypes}
                      onExceedMax={() =>
                        showErrorNotification({
                          title: 'Too many files',
                          error: new Error(`Truncating to ${MAX_FILES_ALLOWED}.`),
                          autoClose: false,
                        })
                      }
                    />
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
            <Divider />

            {imageList.length > 0 && (
              <Group my="md" justify="space-between">
                <Paper className="bg-gray-0 dark:bg-dark-6" shadow="xs" radius="sm" px={8} py={2}>
                  <Text
                    style={{ lineHeight: '22px' }}
                    c={
                      totalLabeled === 0
                        ? theme.colors.red[5]
                        : totalLabeled < imageList.length
                        ? theme.colors.orange[5]
                        : theme.colors.green[5]
                    }
                  >
                    {`${totalLabeled} / ${imageList.length} labeled`}
                  </Text>
                </Paper>
                <Group gap="xs">
                  <Button size="compact-sm" color="indigo" onClick={() => setIsZoomed((z) => !z)}>
                    {isZoomed ? <IconZoomOut size={16} /> : <IconZoomIn size={16} />}
                    <Text inline ml={4} inherit>
                      Zoom {isZoomed ? 'Out' : 'In'}
                    </Text>
                  </Button>
                  <Tooltip
                    label="Not connected - will not receive updates. Please try refreshing the page."
                    disabled={connected}
                  >
                    <Button
                      size="compact-sm"
                      color="violet"
                      disabled={autoLabeling.isRunning || !connected}
                      style={!connected ? { pointerEvents: 'initial' } : undefined}
                      onClick={() =>
                        dialogStore.trigger({
                          component: AutoLabelModal,
                          props: { modelId: model.id, mediaType: thisMediaType },
                        })
                      }
                    >
                      <Group gap={4}>
                        <IconTags size={16} />
                        <Text inherit>Auto Label</Text>
                        {Date.now() < new Date('2024-09-27').getTime() && (
                          <Badge color="green" variant="filled" size="sm" ml={4}>
                            NEW
                          </Badge>
                        )}
                      </Group>
                    </Button>
                  </Tooltip>
                  <Button
                    size="compact-sm"
                    color="cyan"
                    loading={zipping}
                    onClick={() => handleNextAfterCheck(true)}
                  >
                    <IconFileDownload size={16} />
                    <Text inline ml={4} inherit>
                      Download
                    </Text>
                  </Button>

                  <Button
                    size="compact-sm"
                    color="red"
                    disabled={autoLabeling.isRunning}
                    onClick={() => {
                      openConfirmModal({
                        title: 'Remove all files?',
                        children: 'This cannot be undone.',
                        labels: { cancel: 'Cancel', confirm: 'Confirm' },
                        centered: true,
                        onConfirm: () => {
                          setImageList(model.id, thisMediaType, []);
                          setAccordionUpload('uploading');
                        },
                      });
                    }}
                  >
                    <IconTrash size={16} />
                    <Text inline ml={4} inherit>
                      Reset
                    </Text>
                  </Button>
                </Group>
              </Group>
            )}
            {filteredImages.length > maxImgPerPage && (
              <Pagination
                withEdges
                mb="md"
                value={page}
                onChange={setPage}
                total={Math.ceil(filteredImages.length / maxImgPerPage)}
              />
            )}
            {autoLabeling.isRunning && (
              <Paper className="bg-gray-0 dark:bg-dark-6" my="lg" p="md" withBorder>
                <Stack>
                  <Text>Running auto labeling...</Text>
                  {autoLabeling.successes + autoLabeling.fails.length > 0 ? (
                    <Progress.Root size="xl" radius="xl">
                      <Progress.Section
                        value={
                          ((autoLabeling.successes + autoLabeling.fails.length) /
                            autoLabeling.total) *
                          100
                        }
                        striped
                        animated
                      >
                        <Progress.Label>
                          {`${autoLabeling.successes + autoLabeling.fails.length} / ${
                            autoLabeling.total
                          }`}
                        </Progress.Label>
                      </Progress.Section>
                    </Progress.Root>
                  ) : (
                    <Progress.Root size="xl" radius="xl">
                      <Progress.Section value={100} striped animated>
                        <Progress.Label>Waiting for data...</Progress.Label>
                      </Progress.Section>
                    </Progress.Root>
                  )}
                </Stack>
              </Paper>
            )}
            {imageList.length > 0 && (
              <Paper px="md" py="xs" shadow="xs" radius="sm" withBorder>
                <Group>
                  <Group gap={4} wrap="nowrap">
                    <Text>Trigger Word</Text>
                    <InfoPopover size="xs" iconProps={{ size: 16 }}>
                      Word that serves as an &quot;activator&quot; for your LoRA during generation.
                      <br />
                      This will be prepended to all labels.
                    </InfoPopover>
                  </Group>
                  <TextInput
                    placeholder='Add a trigger word, ex. "unique-word" (optional)'
                    value={triggerWord}
                    onChange={(event) =>
                      setTriggerWord(model.id, thisMediaType, event.currentTarget.value)
                    }
                    onBlur={() => {
                      const { blockedFor, success } = auditPrompt(triggerWord, undefined, isGreen);
                      if (!success) {
                        if (!triggerWordInvalid) {
                          setTriggerWordInvalid(model.id, thisMediaType, true);
                          showNotification({
                            icon: <IconX size={18} />,
                            autoClose: false,
                            color: 'red',
                            title: 'Inappropriate labels',
                            message: `One or more trigger words have been blocked. Please review. Reason: ${blockedFor.join(
                              ', '
                            )}`,
                          });
                        }
                      } else {
                        if (triggerWordInvalid) {
                          setTriggerWordInvalid(model.id, thisMediaType, false);
                        }
                      }
                    }}
                    style={{ flexGrow: 1 }}
                    className={clsx({ [styles.badLabel]: triggerWordInvalid })}
                    rightSection={
                      <LegacyActionIcon
                        onClick={() => {
                          setTriggerWord(model.id, thisMediaType, '');
                        }}
                        disabled={!triggerWord.length}
                      >
                        <IconX size={16} />
                      </LegacyActionIcon>
                    }
                  />
                </Group>
              </Paper>
            )}
            {imageList.length > 0 && (
              <TrainingImagesSwitchLabel modelId={model.id} mediaType={thisMediaType} />
            )}
            {imageList.length > 0 ? (
              labelType === 'caption' ? (
                <TrainingImagesCaptionViewer
                  selectedTags={selectedTags}
                  setSelectedTags={setSelectedTags}
                  searchCaption={searchCaption}
                  setSearchCaption={setSearchCaption}
                  numImages={filteredImages.length}
                />
              ) : (
                <TrainingImagesTagViewer
                  selectedTags={selectedTags}
                  setSelectedTags={setSelectedTags}
                  modelId={model.id}
                  mediaType={thisMediaType}
                  numImages={filteredImages.length}
                />
              )
            ) : (
              <></>
            )}
            {hasIssues && (
              <Checkbox
                label="Show only inappropriate labels"
                checked={onlyIssues}
                onChange={(event) => setOnlyIssues(event.currentTarget.checked)}
              />
            )}
            {loadingZip ? (
              <Center mt="md" style={{ flexDirection: 'column' }}>
                <Loader />
                <Text>Parsing existing files...</Text>
              </Center>
            ) : imageList.length > 0 && filteredImages.length === 0 ? (
              <Stack mt="md" align="center">
                <ThemeIcon size={64} radius={100}>
                  <IconCloudOff size={64 / 1.6} />
                </ThemeIcon>
                <Text size="lg" align="center">
                  No files found
                </Text>
              </Stack>
            ) : (
              // nb: if we want to break out of container, add margin: 0 calc(50% - 45vw);
              <SimpleGrid cols={{ base: 1, sm: isZoomed ? 1 : 3 }}>
                {filteredImages
                  .slice((page - 1) * maxImgPerPage, (page - 1) * maxImgPerPage + maxImgPerPage)
                  .map((imgData, index) => {
                    return (
                      <Card
                        key={`${imgData.url}-${index}`}
                        shadow="sm"
                        radius="sm"
                        withBorder
                        className={clsx('p-1', { [styles.badLabel]: imgData.invalidLabel })}
                      >
                        <Card.Section className="-mx-1 -mt-1" mb="xs">
                          <div className={styles.imgOverlay}>
                            <Group gap={4} className={clsx(styles.trash)}>
                              <Tooltip label="Remove labels">
                                <LegacyActionIcon
                                  color="violet"
                                  variant="filled"
                                  size="md"
                                  disabled={autoLabeling.isRunning || !imgData.label.length}
                                  onClick={() => {
                                    updateImage(model.id, thisMediaType, {
                                      matcher: getShortNameFromUrl(imgData),
                                      label: '',
                                    });
                                  }}
                                >
                                  <IconTagsOff />
                                </LegacyActionIcon>
                              </Tooltip>
                              <Tooltip label="Remove file">
                                <LegacyActionIcon
                                  color="red"
                                  variant="filled"
                                  size="md"
                                  disabled={autoLabeling.isRunning}
                                  onClick={() => {
                                    const newLen = imageList.length - 1;
                                    setImageList(
                                      model.id,
                                      thisMediaType,
                                      imageList.filter((i) => i.url !== imgData.url)
                                    );
                                    if (
                                      page === Math.ceil(imageList.length / maxImgPerPage) &&
                                      newLen % maxImgPerPage === 0
                                    )
                                      setPage(Math.max(page - 1, 1));

                                    if (newLen < 1) {
                                      setAccordionUpload('uploading');
                                    }
                                  }}
                                >
                                  <IconTrash />
                                </LegacyActionIcon>
                              </Tooltip>
                            </Group>
                            {imgData.source?.type && (
                              <div className={clsx(styles.source)}>
                                <Badge
                                  variant="filled"
                                  className="px-1"
                                  leftSection={
                                    // <ThemeIcon color="blue" size="lg" radius="xl" variant="filled">
                                    <IconTransferIn size={14} />
                                    // </ThemeIcon>
                                  }
                                >
                                  <Text inherit>{imgData.source.type}</Text>
                                </Badge>
                              </div>
                            )}
                            {VIDEO_MIME_TYPE.includes(imgData.type as never) ? (
                              <video
                                loop
                                playsInline
                                disablePictureInPicture
                                muted
                                autoPlay
                                controls={false}
                                height={isZoomed ? '100%' : 250}
                                // TODO possibly object-contain
                                className={clsx('w-full object-cover', {
                                  ['!h-[250px]']: !isZoomed,
                                })}
                              >
                                <source src={imgData.url} type={imgData.type} />
                              </video>
                            ) : (
                              <MImage
                                alt={imgData.name}
                                src={imgData.url}
                                style={{
                                  height: isZoomed ? '100%' : '250px',
                                  width: '100%',
                                  // if we want to show full image, change objectFit to contain
                                  objectFit: 'cover',
                                  // object-position: top;
                                }}
                              />
                            )}
                          </div>
                        </Card.Section>
                        {labelType === 'caption' ? (
                          <TrainingImagesCaptions
                            imgData={imgData}
                            modelId={model.id}
                            mediaType={thisMediaType}
                            searchCaption={searchCaption}
                          />
                        ) : (
                          <TrainingImagesTags
                            imgData={imgData}
                            modelId={model.id}
                            mediaType={thisMediaType}
                            selectedTags={selectedTags}
                          />
                        )}
                      </Card>
                    );
                  })}
              </SimpleGrid>
            )}
            {filteredImages.length > maxImgPerPage && (
              <Pagination
                withEdges
                mt="md"
                value={page}
                onChange={setPage}
                total={Math.ceil(filteredImages.length / maxImgPerPage)}
              />
            )}

            {imageList.length > 0 && (
              <Paper mt="xl" radius="md" p="xl" withBorder>
                <Stack>
                  <Title order={4}>Data Ownership and Sharing</Title>
                  <Text size="sm">
                    Your dataset is temporarily stored for the purposes of training. After training
                    is complete, the dataset is removed. By default, it is not public. Read our{' '}
                    <Text
                      component={Link}
                      c="blue.4"
                      href="/content/training/data-policy"
                      target="_blank"
                    >
                      dataset storage policy
                    </Text>
                    .
                  </Text>
                  <Checkbox
                    label="I own the rights to all these files"
                    checked={ownRights}
                    onChange={(event) => {
                      setOwnRights(model.id, thisMediaType, event.currentTarget.checked);
                      !event.currentTarget.checked &&
                        setShareDataset(model.id, thisMediaType, false);
                    }}
                  />
                  <Checkbox
                    label="I want to share my dataset"
                    disabled={!ownRights}
                    checked={shareDataset}
                    onChange={(event) =>
                      setShareDataset(model.id, thisMediaType, event.currentTarget.checked)
                    }
                  />
                </Stack>
              </Paper>
            )}
          </>
        )}
        <Paper mb="md" radius="md" p="xl" withBorder>
          <div className="flex flex-col gap-4">
            <Title order={4}>Acknowledgement</Title>
            {attested.status ? (
              <ContentClamp maxHeight={28}>
                <AttestDiv />
              </ContentClamp>
            ) : (
              <div>
                <AttestDiv />
              </div>
            )}
            <Checkbox
              label="By agreeing to this attestation, I acknowledge that I have complied with these conditions and accept full responsibility for any legal or ethical implications that arise from the use of this content."
              checked={attested.status}
              error={attested.error}
              onChange={(event) =>
                setAttest(model.id, thisMediaType, {
                  status: event.currentTarget.checked,
                  error: '',
                })
              }
            />
          </div>
        </Paper>
      </Stack>
      <Group justify="flex-end">
        <Button variant="default" onClick={() => goBack(model.id, thisStep)}>
          Back
        </Button>
        <Button
          onClick={handleNext}
          disabled={autoLabeling.isRunning}
          loading={zipping || uploading > 0}
        >
          Next
        </Button>
      </Group>
    </>
  );
};

const AttestDiv = () => {
  return (
    <>
      <Text size="sm" mb={4}>
        By uploading this training data, I confirm that:
      </Text>
      <List size="sm" type="ordered">
        <List.Item mb={2}>
          Consent: If the content depicts the likeness of a real person, I am either that person or
          have obtained clear, explicit consent from that person for their likeness to be used in
          this creation of this model.
        </List.Item>
        <List.Item mb={2}>
          Responsibility: I understand that I am solely responsible for ensuring that all necessary
          permissions have been obtained, and I acknowledge that failure to do so may result in the
          removal of content, my account, or other actions by Civitai.
        </List.Item>
        <List.Item mb={2}>
          Accuracy: I attest that the likeness depicted in this model aligns with the consents
          granted, and I will immediately remove or modify the content if consent is revoked.
        </List.Item>
        <List.Item mb={2}>
          Legality: I will not upload any material that is illegal or exploitative (e.g., child
          sexual abuse material, non-consensual imagery, extremist propaganda). Such content will be
          removed and reported to the relevant authorities.
        </List.Item>
        <List.Item mb={2}>
          Safety: I confirm that my training data and the intended use of this resource comply with
          Civitai’s{' '}
          <Link href="/safety" color="blue">
            <Text component="span" c="primary" size="sm" style={{ textDecoration: 'underline' }}>
              Responsible Resource Development
            </Text>
          </Link>{' '}
          guidelines, including prohibitions on depictions of minors, sexualized depictions of real
          people, and extreme, graphic, or illegal content.
        </List.Item>
      </List>
    </>
  );
};
