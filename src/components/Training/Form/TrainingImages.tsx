import {
  Accordion,
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Checkbox,
  createStyles,
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
import { FileWithPath } from '@mantine/dropzone';
import { openConfirmModal } from '@mantine/modals';
import { hideNotification, showNotification, updateNotification } from '@mantine/notifications';
import type { NotificationProps } from '@mantine/notifications/lib/types';
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
import { saveAs } from 'file-saver';
import { capitalize, isEqual, uniq } from 'lodash-es';
import dynamic from 'next/dynamic';
import pLimit from 'p-limit';
import React, { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { openImageSelectModal } from '~/components/Dialog/dialog-registry';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { ImageSelectSource } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { SelectedImage } from '~/components/Training/Form/ImageSelectModal';
import { getTextTagsAsList, goBack, goNext } from '~/components/Training/Form/TrainingCommon';
import {
  TrainingImagesSwitchLabel,
  TrainingImagesTags,
  TrainingImagesTagViewer,
} from '~/components/Training/Form/TrainingImagesTagViewer';
import { useCatchNavigation } from '~/hooks/useCatchNavigation';
import { BaseModel, constants } from '~/server/common/constants';
import { UploadType } from '~/server/common/enums';
import { IMAGE_MIME_TYPE, MIME_TYPES, ZIP_MIME_TYPE } from '~/server/common/mime-types';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { ModelFileVisibility } from '~/shared/utils/prisma/enums';
import { useS3UploadStore } from '~/store/s3-upload.store';
import {
  defaultTrainingState,
  defaultTrainingStateVideo,
  getShortNameFromUrl,
  type ImageDataType,
  LabelTypes,
  trainingStore,
  useTrainingImageStore,
} from '~/store/training.store';
import { TrainingModelData } from '~/types/router';
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

const TrainingImagesCaptions = dynamic(() =>
  import('~/components/Training/Form/TrainingImagesCaptionViewer').then(
    (x) => x.TrainingImagesCaptions
  )
);
const TrainingImagesCaptionViewer = dynamic(() =>
  import('~/components/Training/Form/TrainingImagesCaptionViewer').then(
    (x) => x.TrainingImagesCaptionViewer
  )
);

const AutoLabelModal = dynamic(() =>
  import('components/Training/Form/TrainingAutoLabelModal').then((m) => m.AutoLabelModal)
);

const MAX_FILES_ALLOWED = 1000;

export const blankTagStr = '@@none@@';

const limit = pLimit(10);

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
  badLabel: {
    // more border
    border: '1px solid red',
    boxShadow: '0 0 10px red',
  },
  trash: {
    display: 'none',
    position: 'absolute',
    top: 0,
    right: 0,
    zIndex: 10,
    margin: 4,
  },
  source: {
    display: 'none',
    position: 'absolute',
    top: 0,
    left: 0,
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

const minWidth = 256;
const minHeight = 256;
const maxWidth = 2048;
const maxHeight = 2048;

export const labelDescriptions: { [p in LabelTypes]: ReactNode } = {
  tag: (
    <Stack spacing={0}>
      <Text>Short, comma-separated descriptions.</Text>
      <Text fs="italic">Ex: &quot;dolphin, ocean, jumping, gorgeous scenery&quot;</Text>
      <Text mt="sm">
        Preferred for <Badge color="violet">SD1</Badge> and <Badge color="grape">SDXL</Badge>{' '}
        models.
      </Text>
    </Stack>
  ),
  caption: (
    <Stack spacing={0}>
      <Text>Natural language, long-form sentences.</Text>
      <Text fs="italic">
        Ex: &quot;There is a dolphin in the ocean. It is jumping out against a gorgeous backdrop of
        a setting sun.&quot;
      </Text>
      <Text mt="sm">
        Preferred for <Badge color="red">Flux</Badge>, <Badge color="pink">SD3</Badge>, and{' '}
        <Badge color="teal">Video</Badge> models.
      </Text>
    </Stack>
  ),
};

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
        <Group spacing="xs">
          <IconInfoCircle />
          <Text size="lg">Found label files</Text>
        </Group>
      }
    >
      <Stack>
        <Stack spacing={0}>
          <Text>You&apos;ve included some labeling (.txt) files.</Text>{' '}
          <Text>Which type are they?</Text>
        </Stack>
        <Group spacing="xs">
          <Text size="sm">Current type: </Text>
          <Badge>{labelType}</Badge>
        </Group>
        <Group spacing="xs">
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
          <Text>{labelDescriptions[labelValue]}</Text>
        </Paper>
        <Group position="right" mt="xl">
          <Button onClick={handleSelect}>OK</Button>
        </Group>
      </Stack>
    </Modal>
  );
};

export const TrainingFormImages = ({ model }: { model: NonNullable<TrainingModelData> }) => {
  const thisModelVersion = model.modelVersions[0];
  const thisMediaType =
    (thisModelVersion.trainingDetails as TrainingDetailsObj | undefined)?.mediaType ?? 'image';
  const thisDefaultTrainingState =
    thisMediaType === 'video' ? defaultTrainingStateVideo : defaultTrainingState;

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

  const theme = useMantineTheme();
  const { classes, cx } = useStyles();
  const queryUtils = trpc.useUtils();
  const { upload, getStatus: getUploadStatus } = useS3UploadStore();
  const { connected } = useSignalContext();

  const existingDataFile = thisModelVersion.files[0];
  const existingMetadata = existingDataFile?.metadata as FileMetadata | null;

  const notificationId = `${thisModelVersion.id}-uploading-data-notification`;
  const notificationFailBase: NotificationProps & { id: string } = {
    id: notificationId,
    icon: <IconX size={18} />,
    color: 'red',
    title: 'Failed to upload archive',
    message: 'Please try again (or contact us if it continues)',
    autoClose: false,
  };

  const { uploading } = getUploadStatus((file) => file.meta?.versionId === thisModelVersion.id);

  const thisStep = 2;
  const maxImgPerPage = 9;

  const getResizedImgUrl = async (data: FileWithPath | Blob, type: string): Promise<string> => {
    const blob = new Blob([data], { type: type });
    const imgUrl = URL.createObjectURL(blob);
    const img = await createImageElement(imgUrl);
    let { width, height } = img;

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

    return new Promise((resolve, reject) => {
      canvas.toBlob((file) => {
        if (!file) reject();
        else resolve(URL.createObjectURL(file));
      }, type);
    });
  };

  const showResizeWarnings = () => {
    if (showImgResizeDown.current) {
      showWarningNotification({
        title: `${showImgResizeDown.current} image${
          showImgResizeDown.current === 1 ? '' : 's'
        } resized down`,
        message: `Max image dimensions are ${maxWidth}w and ${maxHeight}h.`,
        autoClose: false,
      });
      showImgResizeDown.current = 0;
    }
    if (showImgResizeUp.current) {
      showWarningNotification({
        title: `${showImgResizeUp.current} image${
          showImgResizeUp.current === 1 ? '' : 's'
        } resized up`,
        message: `Min image dimensions are ${minWidth}w or ${minHeight}h.`,
        autoClose: false,
      });
      showImgResizeUp.current = 0;
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

    const ret = await Promise.all(
      Object.entries(zData.files).map(async ([zname, zf]) => {
        let hasLabelFiles = false;

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
            let labelStr = '';
            if (czFile) {
              labelStr = await czFile.async('string');
              hasLabelFiles = true;
            }
            parsedFiles.push({
              name: zname,
              type: imageExts[fileExt],
              url: scaledUrl,
              label: labelStr,
              invalidLabel: false,
              source: source ?? null,
            });
          } catch (e) {
            showErrorNotification({
              error: new Error(`An error occurred while parsing "${zname}".`),
            });
          }
        }
        return hasLabelFiles;
      })
    );

    const hasAnyLabelFiles = ret.some((r) => r === true);

    showResizeWarnings();

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

    return { parsedFiles, hasAnyLabelFiles };
  };

  const handleDrop = async (
    fileList: FileWithPath[],
    data?: { [p: string]: Pick<ImageDataType, 'label' | 'source'> }
  ) => {
    const newFiles = await Promise.all(
      fileList.map(async (f) => {
        if (ZIP_MIME_TYPE.includes(f.type as never) || f.name.endsWith('.zip')) {
          const source = data?.[f.name]?.source ?? null;
          return await handleZip(f, !source, source);
        } else {
          try {
            const scaledUrl = await getResizedImgUrl(f, f.type);
            const label = data?.[f.name]?.label ?? '';
            const source = data?.[f.name]?.source ?? null;
            const parsed: ImageDataType[] = [
              { name: f.name, type: f.type, url: scaledUrl, invalidLabel: false, label, source },
            ];

            return {
              parsedFiles: parsed,
              hasAnyLabelFiles: label !== '',
            };
          } catch (e) {
            showErrorNotification({
              error: new Error(`An error occurred while parsing "${f.name}".`),
            });
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
    if (filteredFiles.length > MAX_FILES_ALLOWED - imageList.length) {
      showErrorNotification({
        title: 'Too many images',
        error: new Error(`Truncating to ${MAX_FILES_ALLOWED}.`),
        autoClose: false,
      });
      filteredFiles.splice(MAX_FILES_ALLOWED - imageList.length);
    }
    setImageList(model.id, thisMediaType, imageList.concat(filteredFiles));

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

  const handleImport = async (images: SelectedImage[], source: ImageSelectSource) => {
    const importNotifId = `${thisModelVersion.id}-importing-images-${new Date().toISOString()}`;
    showNotification({
      id: importNotifId,
      loading: true,
      autoClose: false,
      disallowClose: true,
      message: `Importing ${images.length} ${source === 'training' ? 'dataset' : 'image'}${
        images.length !== 1 ? 's' : ''
      }...`,
    });

    let files;
    if (source === 'training') {
      files = await Promise.all(
        images.map(async (i) => {
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
        images.map((i, idx) =>
          limit(async () => {
            try {
              const result = await fetch(getEdgeUrl(i.url));
              if (!result.ok) return;

              const blob = await result.blob();
              return {
                file: new File([blob], `imported_${new Date().toISOString()}_${idx}.jpg`, {
                  type: IMAGE_MIME_TYPE.includes(blob.type as never) ? blob.type : MIME_TYPES.jpeg,
                }),
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
        )
      );
    }

    const fileDiff = files.length - goodFiles.length;

    hideNotification(importNotifId);

    if (fileDiff !== 0) {
      showWarningNotification({
        message: `${fileDiff} ${source === 'training' ? 'dataset' : 'image'}${
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
        disallowClose: false,
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
          const separator = labelType === 'caption' ? '.' : ',';
          const regMatch = new RegExp(`^${triggerWord}(${separator}|$)`);

          if (!regMatch.test(label)) {
            label = label.length > 0 ? [triggerWord, label].join(`${separator} `) : triggerWord;
          }
        }

        label.length > 0 && zip.file(`${filenameBase}.txt`, label);

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

      hideNotification(notificationId);
      showNotification({
        id: notificationId,
        loading: true,
        autoClose: false,
        disallowClose: true,
        title: 'Creating and uploading archive',
        message: `Packaging ${imageList.length} image${imageList.length !== 1 ? 's' : ''}...`,
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
      const issues: string[] = [];

      const { blockedFor, success } = auditPrompt(triggerWord);
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
          const { blockedFor, success } = auditPrompt(i.label);
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
            <Group spacing="xs">
              <IconAlertTriangle color="gold" />
              <Text size="lg">Missing labels</Text>
            </Group>
          ),
          children:
            'You have not provided any labels for your images. This can produce an inflexible model. We will also attempt to generate sample images, but they may not be what you are looking for. Are you sure you want to continue?',
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
                <Accordion.Control>Upload Images</Accordion.Control>
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

                    <Group mt="xs" position="center" grow>
                      <Button
                        variant="light"
                        onClick={() => {
                          openImageSelectModal({
                            title: 'Select Images',
                            selectSource: 'generation',
                            onSelect: async (images) => {
                              await handleImport(images, 'generation');
                            },
                            importedUrls,
                          });
                        }}
                      >
                        Import from Generator
                      </Button>
                      <Button
                        variant="light"
                        onClick={() => {
                          openImageSelectModal({
                            title: 'Select Images',
                            selectSource: 'uploaded',
                            onSelect: async (images) => {
                              await handleImport(images, 'uploaded');
                            },
                            importedUrls,
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
                          });
                        }}
                      >
                        Re-use a Dataset
                      </Button>
                    </Group>

                    <Divider label="OR" labelPosition="center" />

                    <ImageDropzone
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
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
            <Divider />

            {imageList.length > 0 && (
              <Group my="md" position="apart">
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
                <Group spacing="xs">
                  <Button compact color="indigo" onClick={() => setIsZoomed((z) => !z)}>
                    {isZoomed ? <IconZoomOut size={16} /> : <IconZoomIn size={16} />}
                    <Text inline ml={4}>
                      Zoom {isZoomed ? 'Out' : 'In'}
                    </Text>
                  </Button>
                  <Tooltip
                    label="Not connected - will not receive updates. Please try refreshing the page."
                    disabled={connected}
                  >
                    <Button
                      compact
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
                      <Group spacing={4}>
                        <IconTags size={16} />
                        <Text>Auto Label</Text>
                        {Date.now() < new Date('2024-09-27').getTime() && (
                          <Badge color="green" variant="filled" size="sm" ml={4}>
                            NEW
                          </Badge>
                        )}
                      </Group>
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
                    disabled={autoLabeling.isRunning}
                    onClick={() => {
                      openConfirmModal({
                        title: 'Remove all images?',
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
                    <Text inline ml={4}>
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
                page={page}
                onChange={setPage}
                total={Math.ceil(filteredImages.length / maxImgPerPage)}
              />
            )}
            {autoLabeling.isRunning && (
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
                  <Text>Running auto labeling...</Text>
                  {autoLabeling.successes + autoLabeling.fails.length > 0 ? (
                    <Progress
                      value={
                        ((autoLabeling.successes + autoLabeling.fails.length) /
                          autoLabeling.total) *
                        100
                      }
                      label={`${autoLabeling.successes + autoLabeling.fails.length} / ${
                        autoLabeling.total
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
              <Paper px="md" py="xs" shadow="xs" radius="sm" withBorder>
                <Group>
                  <Group spacing={4} noWrap>
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
                      const { blockedFor, success } = auditPrompt(triggerWord);
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
                    className={cx({ [classes.badLabel]: triggerWordInvalid })}
                    rightSection={
                      <ActionIcon
                        onClick={() => {
                          setTriggerWord(model.id, thisMediaType, '');
                        }}
                        disabled={!triggerWord.length}
                      >
                        <IconX size={16} />
                      </ActionIcon>
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
                <Text>Parsing existing images...</Text>
              </Center>
            ) : imageList.length > 0 && filteredImages.length === 0 ? (
              <Stack mt="md" align="center">
                <ThemeIcon size={64} radius={100}>
                  <IconCloudOff size={64 / 1.6} />
                </ThemeIcon>
                <Text size={20} align="center">
                  No images found
                </Text>
              </Stack>
            ) : (
              // nb: if we want to break out of container, add margin: 0 calc(50% - 45vw);
              <SimpleGrid cols={isZoomed ? 1 : 3} breakpoints={[{ maxWidth: 'sm', cols: 1 }]}>
                {filteredImages
                  .slice((page - 1) * maxImgPerPage, (page - 1) * maxImgPerPage + maxImgPerPage)
                  .map((imgData, index) => {
                    return (
                      <Card
                        key={index}
                        shadow="sm"
                        p={4}
                        radius="sm"
                        withBorder
                        className={cx({ [classes.badLabel]: imgData.invalidLabel })}
                      >
                        <Card.Section mb="xs">
                          <div className={classes.imgOverlay}>
                            <Group spacing={4} className={cx(classes.trash, 'trashIcon')}>
                              <Tooltip label="Remove labels">
                                <ActionIcon
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
                                </ActionIcon>
                              </Tooltip>
                              <Tooltip label="Remove image">
                                <ActionIcon
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
                                </ActionIcon>
                              </Tooltip>
                            </Group>
                            {imgData.source?.type && (
                              <div className={cx(classes.source, 'trashIcon')}>
                                <Badge
                                  variant="filled"
                                  className="px-1"
                                  leftSection={
                                    // <ThemeIcon color="blue" size="lg" radius="xl" variant="filled">
                                    <IconTransferIn size={14} />
                                    // </ThemeIcon>
                                  }
                                >
                                  <Text>{imgData.source.type}</Text>
                                </Badge>
                              </div>
                            )}
                            <MImage
                              alt={imgData.name}
                              src={imgData.url}
                              imageProps={{
                                style: {
                                  height: isZoomed ? '100%' : '250px',
                                  width: '100%',
                                  // if we want to show full image, change objectFit to contain
                                  objectFit: 'cover',
                                  // object-position: top;
                                },
                                // onLoad: () => URL.revokeObjectURL(imageUrl)
                              }}
                            />
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
                page={page}
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
              <ContentClamp maxHeight={30}>
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
      <Group position="right">
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
          Consent: If the content depicts the likeness of a real person, who is not a public figure,
          I am either that person or have obtained clear, explicit consent from that person for
          their likeness to be used in this model.
        </List.Item>
        <List.Item mb={2}>
          Responsibility: I understand that I am solely responsible for ensuring that all necessary
          permissions have been obtained, and I acknowledge that failure to do so may result in the
          removal of content, my account or other actions by Civitai.
        </List.Item>
        <List.Item mb={2}>
          Accuracy: I attest that the likeness depicted in this model aligns with the consents
          granted, and I will immediately remove or modify the content if consent is revoked.
        </List.Item>
      </List>
    </>
  );
};
