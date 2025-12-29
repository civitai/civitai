import {
  Alert,
  useMantineTheme,
  useComputedColorScheme,
  Text,
  createSafeContext,
  Card,
  ActionIcon,
  Loader,
  Tooltip,
} from '@mantine/core';
import type { Dispatch, DragEvent, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  isOrchestratorUrl,
  maxOrchestratorImageFileSize,
  maxUpscaleSize,
  minUploadSize,
} from '~/server/common/constants';
import { withController } from '~/libs/form/hoc/withController';
import { fetchBlobAsFile, getBase64 } from '~/utils/file-utils';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { imageToJpegBlob, resizeImage } from '~/shared/utils/canvas-utils';
import { getImageDimensions } from '~/utils/image-utils';
import { ExifParser } from '~/utils/metadata';
import clsx from 'clsx';
import type { Blob as ImageBlob } from '@civitai/client';
import { almostEqual, formatBytes } from '~/utils/number-helpers';
import { Dropzone } from '@mantine/dropzone';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { IconBrush, IconUpload, IconX } from '@tabler/icons-react';
import { getRandomId } from '~/utils/string-helpers';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ImageCropModal } from '~/components/Generation/Input/ImageCropModal';
import { DrawingEditorModal } from './DrawingEditor/DrawingEditorModal';
import type { DrawingLine } from './DrawingEditor/drawing.types';
import { create } from 'zustand';
import { isAndroidDevice } from '~/utils/device-helpers';

type AspectRatio = `${number}:${number}`;

type SourceImageUploadProps = {
  value?: SourceImageProps[] | null;
  onChange?: (value: SourceImageProps[] | null) => void;
  children: (previewItems: ImagePreview[]) => React.ReactNode;
  max?: number;
  warnOnMissingAiMetadata?: boolean;
  aspect?: 'square' | 'video';
  cropToFirstImage?: boolean;
  aspectRatios?: AspectRatio[];
  error?: string;
  id?: string;
  /** Enable drawing overlay tools */
  enableDrawing?: boolean;
  /** Called when user completes a drawing overlay */
  onDrawingComplete?: (value: SourceImageProps, index: number) => void;
};

type ImageComplete = {
  status: 'complete';
  url: string;
  width: number;
  height: number;
  id?: string;
  linkToId?: string;
};

type ImageCrop = { status: 'cropping'; url: string; id: string };

type ImagePreview =
  | ImageCrop
  | { status: 'uploading'; url: string; id: string }
  | { status: 'error'; url: string; src: string | Blob | File; error: string; id: string }
  | ImageComplete;

type SourceImageUploadContext = {
  previewItems: ImagePreview[];
  setError: Dispatch<SetStateAction<string | null>>;
  setUploads: Dispatch<SetStateAction<ImagePreview[]>>;
  max: number;
  missingAiMetadata: Record<string, boolean>;
  removeItem: (index: number) => void;
  aspect: 'square' | 'video';
  cropToFirstImage: boolean;
  aspectRatios?: AspectRatio[];
  onChange: (value: (string | File)[]) => Promise<void>;
  enableDrawing?: boolean;
  handleDrawingUpload: (index: number, drawingBlob: Blob) => Promise<void>;
};

const [Provider, useContext] = createSafeContext<SourceImageUploadContext>(
  'missing SourceImageUploadContext'
);

const iconSize = 18;
const maxSizeFormatted = formatBytes(maxOrchestratorImageFileSize);
export function SourceImageUploadMultiple({
  value,
  onChange,
  children,
  max = 1,
  warnOnMissingAiMetadata = false,
  aspect = 'square',
  cropToFirstImage = false,
  aspectRatios,
  error: initialError,
  id,
  enableDrawing = false,
  onDrawingComplete,
}: SourceImageUploadProps) {
  const [uploads, setUploads] = useState<ImagePreview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [missingAiMetadata, setMissingAiMetadata] = useState<Record<string, boolean>>({});

  const previewImages = useMemo(() => {
    if (!value) return [];
    const images: ImageComplete[] = value.map((val) => ({ status: 'complete', ...val }));
    for (const item of uploads.filter(
      (x) => x.status === 'complete' || x.status === 'cropping'
    ) as ImageComplete[]) {
      const lastIndex = images.findLastIndex((x) => x.url === item.url && !x.linkToId);
      if (lastIndex > -1) images[lastIndex].linkToId = item.id;
    }
    return images;
  }, [value, uploads]);

  const previewItems = useMemo(() => {
    return [...previewImages.filter((x) => !x.linkToId), ...uploads];
  }, [previewImages, uploads]);

  useEffect(() => {
    if (uploads.length > 0 && uploads.every((x) => x.status === 'complete')) setUploads([]);
  }, [uploads]);

  const getShouldCrop = useCallback((previewImages: { width: number; height: number }[]) => {
    if (!previewImages.length) return false;
    let allMatch = true;
    if (cropToFirstImage) {
      const { width, height } = previewImages[0];
      const ratio = width / height;
      allMatch = previewImages.every(({ width, height }) =>
        almostEqual(ratio, width / height, 0.01)
      );
    } else if (!!aspectRatios?.length) {
      const ratios = aspectRatios.map((ratio) => {
        const [w, h] = ratio.split(':').map(Number);
        return w / h;
      });
      allMatch = previewImages.every(({ width, height }) =>
        ratios.some((r) => almostEqual(r, width / height, 0.01))
      );
    }
    return !allMatch;
  }, []);

  useEffect(() => {
    if (getShouldCrop(previewImages)) {
      handleCrop(
        previewImages.map((x) => x.url),
        'replace'
      );
    }
  }, [previewImages]);

  function removeItem(index: number) {
    const item = previewItems[index];

    if (item.id) {
      setImageUploading(item.id, false);
      setUploads((state) => state.filter((x) => x.id !== item.id));
      const linkedIdIndex = previewImages?.findIndex((x) => x.linkToId === item.id);
      if (value && linkedIdIndex > -1) {
        const copy = [...value];
        copy.splice(linkedIdIndex, 1);
        onChange?.(copy);
      }
    } else if (value) {
      const copy = [...value];
      copy.splice(index, 1);
      onChange?.(copy);
    }
  }

  // handle update value
  useEffect(() => {
    const completed = previewItems.filter((x) => x.status === 'complete') as ImageComplete[];
    if (!completed.length) onChange?.(null);
    else if (completed.length !== value?.length) {
      onChange?.(
        completed.map(({ url, width, height }) => ({ url, width, height })) as SourceImageProps[]
      );
    }
  }, [previewItems]);

  // handle missing ai metadata
  useEffect(() => {
    if (warnOnMissingAiMetadata && value) {
      for (const { url } of value) {
        if (!missingAiMetadata[url]) {
          fetchBlobAsFile(url).then(async (file) => {
            if (file) {
              const parser = await ExifParser(file);
              const meta = await parser.getMetadata();
              setMissingAiMetadata((state) => ({
                ...state,
                [url]: !Object.keys(meta).length && !parser.isMadeOnSite(),
              }));
            }
          });
        }
      }
    }
  }, [value, warnOnMissingAiMetadata]);

  // TODO - better error messaging

  const imagesMissingMetadataCount = previewImages.filter((x) => missingAiMetadata[x.url]).length;
  const _error = initialError ?? error;

  async function handleUpload(src: string | Blob | File, originUrl?: string) {
    const previewUrl = originUrl ?? (typeof src !== 'string' ? URL.createObjectURL(src) : src);
    const id = getRandomId();
    setUploads((items) => {
      const copy = [...items];
      const index = copy.findIndex((x) => x.url === previewUrl);
      if (index > -1) copy[index].status = 'uploading';
      else copy.push({ status: 'uploading', url: previewUrl, id });
      return copy;
    });

    try {
      const response = await uploadOrchestratorImage(src, id);
      setUploads((items) => {
        const index = items.findIndex((x) => x.status === 'uploading' && x.url === previewUrl);
        if (index > -1) {
          if (response.blockedReason || !response.available || !response.url)
            items[index] = {
              status: 'error',
              url: previewUrl,
              src,
              error: response.blockedReason ?? 'Unexpected image upload error',
              id,
            };
          else
            items[index] = {
              status: 'complete',
              url: response.url,
              width: response.width,
              height: response.height,
              id,
            };
        }
        return [...items];
      });
    } catch (e) {
      setError((e as Error).message);
      setUploads((items) => items.filter((x) => x.id !== id));
    }
  }

  async function handleCrop(items: (string | Blob | File)[], action: 'add' | 'replace' = 'add') {
    const urls = items.map((src) => (typeof src !== 'string' ? URL.createObjectURL(src) : src));
    const previewUrls = previewItems.filter((x) => x.status === 'complete').map((x) => x.url);
    const allUrls = action === 'add' ? [...previewUrls, ...urls] : urls;
    const withAspectRatio = await Promise.all(
      allUrls.map(async (url) => {
        const { width, height } = await getImageDimensions(url);
        const aspectRatio = Math.round(((width / height) * 100) / 100);
        return { url, width, height, aspectRatio };
      })
    );

    const shouldCrop = getShouldCrop(withAspectRatio);

    if (!shouldCrop) {
      await Promise.all(urls.map((url) => handleUpload(url)));
    } else {
      const incoming: ImageCrop[] = urls.map((url) => ({
        status: 'cropping',
        id: getRandomId(),
        url,
      }));

      setUploads(incoming);

      dialogStore.trigger({
        id: 'image-crop-modal',
        component: ImageCropModal,
        props: {
          images: withAspectRatio,
          onConfirm: async (output) => {
            const toUpload = output.filter(({ cropped }) => !!cropped);
            await Promise.all(
              toUpload.map(async ({ cropped, src }) => handleUpload(cropped!, src))
            );
          },
          onCancel: () => setUploads([]),
          aspectRatios,
        },
      });
    }
  }

  // handle adding new urls or files
  async function handleChange(value: (string | File)[]) {
    await handleCrop(value);
  }

  // handle drawing upload for individual images
  async function handleDrawingUpload(index: number, drawingBlob: Blob) {
    const base64 = await getBase64(drawingBlob);
    const response = await uploadOrchestratorImage(base64, getRandomId());

    if (response.url && response.available) {
      const newImage = { url: response.url, width: response.width, height: response.height };
      onDrawingComplete?.(newImage, index);
    }
  }

  return (
    <Provider
      value={{
        previewItems,
        setError,
        setUploads,
        max,
        missingAiMetadata,
        removeItem,
        aspect,
        cropToFirstImage,
        aspectRatios,
        onChange: handleChange,
        enableDrawing,
        handleDrawingUpload,
      }}
    >
      <div className="flex flex-col gap-3 bg-gray-2 p-3 dark:bg-dark-8" id={id}>
        {children(previewItems)}

        {_error && <Alert color="red">{_error}</Alert>}
        {imagesMissingMetadataCount > 0 && (
          <Alert
            color="yellow"
            title={`We couldn't detect valid metadata in ${
              imagesMissingMetadataCount > 1 ? 'these images' : 'this image'
            }.`}
          >
            {`Outputs based on ${
              imagesMissingMetadataCount > 1 ? 'these images' : 'this image'
            } must be PG, PG-13, or they will be blocked and you will not be refunded.`}
          </Alert>
        )}
      </div>
    </Provider>
  );
}

SourceImageUploadMultiple.Dropzone = function ImageDropzone({ className }: { className?: string }) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const { previewItems, setError, max, aspect, onChange } = useContext();
  const canAddFiles = previewItems.length < max;

  async function handleDrop(files: File[]) {
    setError(null);
    const remaining = max - previewItems.length;
    const toUpload = files
      .filter((file) => {
        const tooLarge = file.size > maxOrchestratorImageFileSize;
        if (tooLarge) setError(`Images should not exceed ${maxSizeFormatted}`);
        return !tooLarge;
      })
      .splice(0, remaining);
    await onChange(toUpload);
  }

  async function handleDropCapture(e: DragEvent) {
    setError(null);
    const url = e.dataTransfer.getData('text/uri-list');
    if (!!url?.length && previewItems.length < max) await onChange([url]);
  }

  if (!canAddFiles) return null;
  return (
    <Dropzone
      accept={IMAGE_MIME_TYPE}
      disabled={!canAddFiles}
      onDrop={handleDrop}
      onDropCapture={handleDropCapture}
      className={clsx(
        'flex  items-center justify-center',
        aspect === 'square' ? 'aspect-square' : 'aspect-video',
        {
          ['bg-gray-0 dark:bg-dark-6 border-gray-2 dark:border-dark-5 cursor-not-allowed [&_*]:text-gray-5 [&_*]:dark:text-dark-3']:
            !canAddFiles,
        },
        className
      )}
      useFsAccessApi={!isAndroidDevice()}
    >
      <div className="pointer-events-none flex items-center justify-center gap-2">
        <Dropzone.Accept>
          <IconUpload
            size={iconSize}
            stroke={1.5}
            color={theme.colors[theme.primaryColor][colorScheme === 'dark' ? 4 : 6]}
          />
        </Dropzone.Accept>
        <Dropzone.Reject>
          <IconX
            size={iconSize}
            stroke={1.5}
            color={theme.colors.red[colorScheme === 'dark' ? 4 : 6]}
          />
        </Dropzone.Reject>
        <Dropzone.Idle>
          <IconUpload size={iconSize} stroke={1.5} />
        </Dropzone.Idle>

        <Text>{max === 1 ? 'Image' : 'Images'}</Text>
      </div>
    </Dropzone>
  );
};

SourceImageUploadMultiple.Image = function ImagePreview({
  className,
  index,
  ...previewItem
}: ImagePreview & { className?: string; index: number }) {
  const { missingAiMetadata, removeItem, aspect, setError, enableDrawing, handleDrawingUpload } =
    useContext();
  const [drawingLines, setDrawingLines] = useState<DrawingLine[]>([]);

  function handleRemoveItem() {
    removeItem(index);
  }

  function handleError() {
    handleRemoveItem();
    setError('Failed to load image');
  }

  async function handleDrawingComplete(drawingBlob: Blob, lines: DrawingLine[]) {
    setDrawingLines(lines);
    await handleDrawingUpload(index, drawingBlob);
  }

  function handleOpenDrawingEditor() {
    if (previewItem.status !== 'complete') return;

    dialogStore.trigger({
      id: `drawing-editor-modal-${index}`,
      component: DrawingEditorModal,
      props: {
        sourceImage: {
          url: previewItem.url,
          width: previewItem.width,
          height: previewItem.height,
        },
        onConfirm: handleDrawingComplete,
        initialLines: drawingLines,
      },
    });
  }

  return (
    <Card
      withBorder
      p={0}
      className={clsx(
        'relative overflow-visible rounded',
        {
          ['rounded-md border-2 border-solid border-yellow-4 ']: missingAiMetadata[previewItem.url],
        },
        className
      )}
    >
      <Card.Section p={0} m={0} withBorder>
        <div
          className={clsx(
            'relative flex items-center justify-center',
            aspect === 'square' ? 'aspect-square' : 'aspect-video'
          )}
        >
          {(previewItem.status === 'uploading' || previewItem.status === 'cropping') && (
            <Loader size="sm" />
          )}
          {previewItem.status === 'complete' && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewItem.url}
                className="size-full object-contain"
                alt="image"
                onError={handleError}
              />
              <div className="absolute bottom-0 right-0 rounded-br-md rounded-tl-md bg-dark-9/50 px-2 text-white">
                {previewItem.width} x {previewItem.height}
              </div>
              {enableDrawing && (
                <Tooltip label="Draw on image" withArrow>
                  <ActionIcon
                    variant="filled"
                    size="sm"
                    className="absolute left-0 top-0 m-1 rounded-md"
                    onClick={handleOpenDrawingEditor}
                  >
                    <IconBrush size={16} />
                  </ActionIcon>
                </Tooltip>
              )}
            </>
          )}
          {previewItem.status === 'error' && (
            <Text c="red" size="sm" align="center">
              {previewItem.error}
            </Text>
          )}
        </div>
      </Card.Section>
      <ActionIcon
        className="absolute -right-2 -top-2 z-10"
        variant="filled"
        color="red"
        size="sm"
        onClick={handleRemoveItem}
      >
        <IconX size={16} />
      </ActionIcon>
    </Card>
  );
};

export async function uploadOrchestratorImage(src: string | Blob | File, id: string) {
  let body: string;
  if (typeof src === 'string' && isOrchestratorUrl(src)) {
    body = src;
  } else {
    const resized = await resizeImage(src, {
      maxHeight: maxUpscaleSize,
      maxWidth: maxUpscaleSize,
      minWidth: minUploadSize,
      minHeight: minUploadSize,
    });
    const jpegBlob = await imageToJpegBlob(resized);
    body = await getBase64(jpegBlob);
  }
  try {
    setImageUploading(id, true);
    const response = await fetch('/api/orchestrator/uploadImage', { method: 'POST', body });
    setImageUploading(id, false);

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error(await response.text());
      } else {
        throw new Error(response.statusText);
      }
    }
    const blob: ImageBlob = await response.json();
    const size = await getImageDimensions(src);
    return { ...blob, ...size };
  } catch (e) {
    const error = e as Error;
    const size = await getImageDimensions(src);

    return {
      url: body,
      ...size,
      available: false,
      blockedReason: error.message,
    };
  }
}

export const InputSourceImageUploadMultiple = withController(SourceImageUploadMultiple);

export const useImagesUploadingStore = create<{ uploading: string[] }>(() => ({ uploading: [] }));
function setImageUploading(id: string, uploading: boolean) {
  if (uploading) {
    useImagesUploadingStore.setState((state) => ({ uploading: [...state.uploading, id] }));
  } else {
    useImagesUploadingStore.setState((state) => ({
      uploading: state.uploading.filter((uploadId) => uploadId !== id),
    }));
  }
}
