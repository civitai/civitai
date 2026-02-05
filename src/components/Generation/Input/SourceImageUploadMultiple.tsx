import {
  Alert,
  useMantineTheme,
  useComputedColorScheme,
  Text,
  createSafeContext,
  Card,
  ActionIcon,
  Loader,
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
import { fetchBlobAsFile } from '~/utils/file-utils';
import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { imageToJpegBlob, resizeImage } from '~/shared/utils/canvas-utils';
import { getImageDimensions } from '~/utils/image-utils';
import { ExifParser } from '~/utils/metadata';
import clsx from 'clsx';
import { almostEqual, formatBytes } from '~/utils/number-helpers';
import { Dropzone } from '@mantine/dropzone';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { IconPalette, IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { getRandomId } from '~/utils/string-helpers';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ImageCropModal } from '~/components/Generation/Input/ImageCropModal';
import { DrawingEditorModal } from './DrawingEditor/DrawingEditorModal';
import type { DrawingElement, DrawingElementSchema } from './DrawingEditor/drawing.types';
import { create } from 'zustand';
import { isAndroidDevice } from '~/utils/device-helpers';
import { isMobileDevice } from '~/hooks/useIsMobile';
import { sourceMetadataStore } from '~/store/source-metadata.store';
import { extractSourceMetadataFromUrl } from '~/utils/metadata/extract-source-metadata';

type AspectRatio = `${number}:${number}`;

/** Tracks original image info for images that have been annotated (drawn on) */
export type ImageAnnotation = {
  originalUrl: string;
  originalWidth: number;
  originalHeight: number;
  compositeUrl: string;
  lines: DrawingElementSchema[];
};

/** Configuration for a single image slot */
export type ImageSlot = {
  /** Label displayed above the slot */
  label: string;
  /** Whether this slot is required */
  required?: boolean;
};

type SourceImageUploadProps = {
  value?: SourceImageProps[] | null;
  onChange?: (value: SourceImageProps[] | null) => void;
  /**
   * Render function for custom layouts (multi-image mode).
   * If not provided and max=1, uses single-image VideoInput-style layout.
   */
  children?: (previewItems: ImagePreview[]) => React.ReactNode;
  /**
   * Named slots for fixed-position images (e.g., first/last frame).
   * When provided, renders side-by-side dropzones with labels.
   * Value array indices map to slot indices.
   */
  slots?: ImageSlot[];
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
  onDrawingComplete?: (value: SourceImageProps, index: number, elements: DrawingElement[]) => void;
  /** Annotations tracking original images for composites (used for re-editing) */
  annotations?: ImageAnnotation[] | null;
  /** Called when an image is removed (for annotation cleanup) */
  onRemove?: (removedImage: SourceImageProps, index: number) => void;
  /** Whether the input is disabled */
  disabled?: boolean;
};

type ImageComplete = {
  status: 'complete';
  url: string;
  width: number;
  height: number;
  id?: string;
  linkToId?: string;
  /** Slot index for slots mode */
  slotIndex?: number;
};

type ImageCrop = { status: 'cropping'; url: string; id: string; slotIndex?: number };

type ImagePreview =
  | ImageCrop
  | { status: 'uploading'; url: string; id: string; slotIndex?: number }
  | {
      status: 'error';
      url: string;
      src: string | Blob | File;
      error: string;
      id: string;
      slotIndex?: number;
    }
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
  handleDrawingUpload: (
    index: number,
    drawingBlob: Blob,
    elements: DrawingElement[]
  ) => Promise<void>;
  annotations?: ImageAnnotation[] | null;
  disabled?: boolean;
  slots?: ImageSlot[];
  /** Upload a file to a specific slot (for slots mode) */
  handleSlotUpload?: (slotIndex: number, file: File) => Promise<void>;
  /** Remove image from a specific slot */
  removeSlotItem?: (slotIndex: number) => void;
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
  slots,
  max = 1,
  warnOnMissingAiMetadata = false,
  aspect = 'square',
  cropToFirstImage = false,
  aspectRatios,
  error: initialError,
  id,
  enableDrawing = false,
  onDrawingComplete,
  annotations,
  onRemove,
  disabled = false,
}: SourceImageUploadProps) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const isSlotsMode = !!slots?.length;
  const isSingleMode = max === 1 && !children && !isSlotsMode;
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

    // Call onRemove callback if this is a complete image (for annotation cleanup)
    if (item.status === 'complete') {
      onRemove?.({ url: item.url, width: item.width, height: item.height }, index);
      // Remove source metadata from store
      sourceMetadataStore.removeMetadata(item.url);
    }

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

  // Extract and store source metadata for enhancement workflows
  useEffect(() => {
    if (!value) return;

    for (const { url } of value) {
      // Check if metadata already exists in the store
      const existing = sourceMetadataStore.getMetadata(url);
      if (existing) continue;

      // Extract metadata from the image
      extractSourceMetadataFromUrl(url).then((metadata) => {
        if (metadata) {
          sourceMetadataStore.setMetadata(url, metadata);
        }
      });
    }
  }, [value]);

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
  async function handleDrawingUpload(index: number, drawingBlob: Blob, elements: DrawingElement[]) {
    const response = await uploadOrchestratorImage(drawingBlob, getRandomId());

    if (response.url && response.available) {
      const newImage = { url: response.url, width: response.width, height: response.height };
      onDrawingComplete?.(newImage, index, elements);
    }
  }

  // Slots mode: upload to a specific slot
  async function handleSlotUpload(slotIndex: number, file: File) {
    // Check file size
    if (file.size > maxOrchestratorImageFileSize) {
      setError(`Images should not exceed ${maxSizeFormatted}`);
      return;
    }

    setError(null);
    const previewUrl = URL.createObjectURL(file);
    const uploadId = getRandomId();

    // Add uploading state for this slot
    setUploads((items) => {
      // Remove any existing upload for this slot
      const filtered = items.filter((x) => x.slotIndex !== slotIndex);
      return [...filtered, { status: 'uploading', url: previewUrl, id: uploadId, slotIndex }];
    });

    try {
      const response = await uploadOrchestratorImage(file, uploadId);

      if (response.blockedReason || !response.available || !response.url) {
        setUploads((items) =>
          items.map((item) =>
            item.id === uploadId
              ? {
                  status: 'error',
                  url: previewUrl,
                  src: file,
                  error: response.blockedReason ?? 'Upload failed',
                  id: uploadId,
                  slotIndex,
                }
              : item
          )
        );
        return;
      }

      // Update value at the slot index
      const newImage: SourceImageProps = {
        url: response.url,
        width: response.width,
        height: response.height,
      };

      const newValue = value ? [...value] : [];
      // Ensure array is large enough
      while (newValue.length <= slotIndex) {
        newValue.push(undefined as unknown as SourceImageProps);
      }
      newValue[slotIndex] = newImage;

      // Filter out undefined values for sparse arrays, but keep position
      onChange?.(newValue.filter(Boolean) as SourceImageProps[]);

      // Clear upload state for this slot
      setUploads((items) => items.filter((x) => x.id !== uploadId));
    } catch (e) {
      setError((e as Error).message);
      setUploads((items) => items.filter((x) => x.id !== uploadId));
    }
  }

  // Slots mode: remove image from a specific slot
  function removeSlotItem(slotIndex: number) {
    if (!value) return;

    // Get the image at this slot index
    const imageAtSlot = value[slotIndex];
    if (imageAtSlot) {
      onRemove?.(imageAtSlot, slotIndex);
      // Remove source metadata from store
      sourceMetadataStore.removeMetadata(imageAtSlot.url);
    }

    const newValue = [...value];
    newValue.splice(slotIndex, 1);
    onChange?.(newValue.length > 0 ? newValue : null);

    // Clear any upload state for this slot
    setUploads((items) => items.filter((x) => x.slotIndex !== slotIndex));
  }

  // Single mode render - VideoInput-style layout
  const renderSingleMode = () => {
    const firstImage = previewItems.find((item) => item.status === 'complete') as
      | ImageComplete
      | undefined;
    const isUploading = previewItems.some(
      (item) => item.status === 'uploading' || item.status === 'cropping'
    );

    if (firstImage) {
      // Calculate aspect ratio to prevent layout shift during image load
      const aspectRatio =
        firstImage.width && firstImage.height ? firstImage.width / firstImage.height : undefined;

      // Show the image preview
      return (
        <Card withBorder padding={0} className="relative overflow-hidden">
          <div
            className="relative w-full"
            style={{
              // Use aspect-ratio to reserve space and prevent layout shift
              aspectRatio: aspectRatio,
              maxHeight: 200,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={firstImage.url} alt="Uploaded image" className="size-full object-contain" />
          </div>

          <SourceImageUploadMultiple.Dimensions
            width={firstImage.width}
            height={firstImage.height}
          />
          <SourceImageUploadMultiple.CloseButton
            onClick={() => removeItem(0)}
            disabled={disabled}
          />
        </Card>
      );
    }

    if (isUploading) {
      // Show loading state
      return (
        <div className="flex min-h-[200px] items-center justify-center rounded border border-dashed border-gray-4 dark:border-dark-4">
          <Loader size="md" />
        </div>
      );
    }

    // Show the dropzone
    return (
      <Dropzone
        onDrop={async (files) => {
          setError(null);
          const toUpload = files
            .filter((file) => {
              const tooLarge = file.size > maxOrchestratorImageFileSize;
              if (tooLarge) setError(`Images should not exceed ${maxSizeFormatted}`);
              return !tooLarge;
            })
            .slice(0, 1);
          if (toUpload.length > 0) await handleChange(toUpload);
        }}
        accept={IMAGE_MIME_TYPE}
        maxFiles={1}
        disabled={disabled}
        className="cursor-pointer"
        useFsAccessApi={!isAndroidDevice()}
      >
        <div className="flex flex-col items-center justify-center gap-2 py-8">
          <Dropzone.Accept>
            <IconUpload
              size={50}
              stroke={1.5}
              color={theme.colors[theme.primaryColor][colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={50}
              stroke={1.5}
              color={theme.colors.red[colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconPhoto size={50} stroke={1.5} />
          </Dropzone.Idle>
          <Text size="sm" c="dimmed" ta="center">
            Drag an image here or click to select
          </Text>
          <Text size="xs" c="dimmed">
            PNG, JPG, WebP supported (max {maxSizeFormatted})
          </Text>
        </div>
      </Dropzone>
    );
  };

  // Slots mode render - side-by-side dropzones with labels
  const renderSlot = (slot: ImageSlot, slotIndex: number) => {
    const imageAtSlot = value?.[slotIndex];
    const uploadForSlot = uploads.find((u) => u.slotIndex === slotIndex);
    const isUploading = uploadForSlot?.status === 'uploading';
    const uploadError = uploadForSlot?.status === 'error' ? uploadForSlot.error : null;

    return (
      <div key={slotIndex} className="flex flex-1 flex-col gap-1">
        <Text size="sm" c="dimmed" ta="center">
          {slot.label}
        </Text>
        {imageAtSlot ? (
          // Show image preview
          <Card withBorder padding={0} className="relative overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageAtSlot.url}
              alt={slot.label}
              className="max-h-[200px] w-full object-contain"
            />
            <SourceImageUploadMultiple.Dimensions
              width={imageAtSlot.width}
              height={imageAtSlot.height}
            />
            <SourceImageUploadMultiple.CloseButton
              onClick={() => removeSlotItem(slotIndex)}
              disabled={disabled}
            />
          </Card>
        ) : isUploading ? (
          // Show loading state
          <div className="flex min-h-[150px] items-center justify-center rounded border border-dashed border-gray-4 dark:border-dark-4">
            <Loader size="md" />
          </div>
        ) : (
          // Show dropzone
          <Dropzone
            onDrop={async (files) => {
              if (files.length > 0) await handleSlotUpload(slotIndex, files[0]);
            }}
            accept={IMAGE_MIME_TYPE}
            maxFiles={1}
            disabled={disabled}
            className="cursor-pointer"
            useFsAccessApi={!isAndroidDevice()}
          >
            <div className="flex flex-col items-center justify-center gap-2 py-6">
              <Dropzone.Accept>
                <IconUpload
                  size={32}
                  stroke={1.5}
                  color={theme.colors[theme.primaryColor][colorScheme === 'dark' ? 4 : 6]}
                />
              </Dropzone.Accept>
              <Dropzone.Reject>
                <IconX
                  size={32}
                  stroke={1.5}
                  color={theme.colors.red[colorScheme === 'dark' ? 4 : 6]}
                />
              </Dropzone.Reject>
              <Dropzone.Idle>
                <IconPhoto size={32} stroke={1.5} />
              </Dropzone.Idle>
              <Text size="xs" c="dimmed" ta="center">
                Drop image here
              </Text>
            </div>
          </Dropzone>
        )}
        {uploadError && (
          <Text size="xs" c="red" ta="center">
            {uploadError}
          </Text>
        )}
      </div>
    );
  };

  const renderSlotsMode = () => {
    if (!slots) return null;
    return <div className="flex gap-2">{slots.map((slot, index) => renderSlot(slot, index))}</div>;
  };

  return (
    <Provider
      value={{
        previewItems,
        setError,
        setUploads,
        max: isSlotsMode ? slots!.length : max,
        missingAiMetadata,
        removeItem,
        aspect,
        cropToFirstImage,
        aspectRatios,
        onChange: handleChange,
        enableDrawing,
        handleDrawingUpload,
        annotations,
        disabled,
        slots,
        handleSlotUpload,
        removeSlotItem,
      }}
    >
      {isSlotsMode ? (
        <div className="flex w-full flex-col gap-2" id={id}>
          {renderSlotsMode()}
          {_error && <Alert color="red">{_error}</Alert>}
          {imagesMissingMetadataCount > 0 && (
            <Alert color="yellow" title="We couldn't detect valid metadata in one or more images.">
              Outputs based on these images must be PG, PG-13, or they will be blocked and you will
              not be refunded.
            </Alert>
          )}
        </div>
      ) : isSingleMode ? (
        <div className="flex w-full flex-col gap-2" id={id}>
          {renderSingleMode()}
          {_error && <Alert color="red">{_error}</Alert>}
          {imagesMissingMetadataCount > 0 && (
            <Alert color="yellow" title="We couldn't detect valid metadata in this image.">
              Outputs based on this image must be PG, PG-13, or they will be blocked and you will
              not be refunded.
            </Alert>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3" id={id}>
          {children?.(previewItems)}

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
      )}
    </Provider>
  );
}

// =============================================================================
// Shared Sub-components
// =============================================================================

/** Shared close button for image cards */
SourceImageUploadMultiple.CloseButton = function CloseButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <ActionIcon
      className="absolute right-0 top-0"
      variant="filled"
      color="red"
      size="sm"
      onClick={onClick}
      disabled={disabled}
    >
      <IconX size={16} />
    </ActionIcon>
  );
};

/** Shared dimensions overlay for image cards */
SourceImageUploadMultiple.Dimensions = function Dimensions({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  return (
    <div className="absolute bottom-0 right-0 rounded-br-md rounded-tl-md bg-dark-9/70 px-2 py-0.5 text-xs text-white">
      {width} x {height}
    </div>
  );
};

SourceImageUploadMultiple.Dropzone = function ImageDropzone({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const { previewItems, setError, max, aspect, onChange, disabled } = useContext();
  const canAddFiles = previewItems.length < max && !disabled;

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
        'flex items-center justify-center',
        !children && (aspect === 'square' ? 'aspect-square' : 'aspect-video'),
        {
          ['bg-gray-0 dark:bg-dark-6 border-gray-2 dark:border-dark-5 cursor-not-allowed [&_*]:text-gray-5 [&_*]:dark:text-dark-3']:
            !canAddFiles,
        },
        className
      )}
      useFsAccessApi={!isAndroidDevice()}
    >
      {children ?? (
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
      )}
    </Dropzone>
  );
};

SourceImageUploadMultiple.Image = function ImagePreview({
  className,
  index,
  ...previewItem
}: ImagePreview & { className?: string; index: number }) {
  const {
    missingAiMetadata,
    removeItem,
    aspect,
    setError,
    enableDrawing,
    handleDrawingUpload,
    annotations,
    disabled,
  } = useContext();
  const [drawingLines, setDrawingLines] = useState<DrawingElement[]>([]);
  const isMobile = isMobileDevice();

  // Check if this image is a composite (has been annotated)
  const annotation = annotations?.find((a) => a.compositeUrl === previewItem.url);
  const isAnnotated = !!annotation;

  function handleRemoveItem() {
    removeItem(index);
  }

  function handleError() {
    handleRemoveItem();
    setError('Failed to load image');
  }

  async function handleDrawingComplete(drawingBlob: Blob, elements: DrawingElement[]) {
    setDrawingLines(elements);
    await handleDrawingUpload(index, drawingBlob, elements);
  }

  // Get initial lines from annotation if this is an annotated image, otherwise from local state
  const initialLines = isAnnotated ? annotation.lines : drawingLines;

  function handleOpenDrawingEditor() {
    if (previewItem.status !== 'complete') return;

    // If this is a composite, use the original image for the drawing editor
    const sourceImage = isAnnotated
      ? {
          url: annotation.originalUrl,
          width: annotation.originalWidth,
          height: annotation.originalHeight,
        }
      : {
          url: previewItem.url,
          width: previewItem.width,
          height: previewItem.height,
        };

    dialogStore.trigger({
      id: `drawing-editor-modal-${index}`,
      component: DrawingEditorModal,
      props: {
        sourceImage,
        onConfirm: handleDrawingComplete,
        initialLines,
      },
    });
  }

  return (
    <Card
      withBorder
      p={0}
      className={clsx(
        'relative overflow-hidden',
        {
          ['border-2 border-solid border-yellow-4 ']: missingAiMetadata[previewItem.url],
        },
        className
      )}
    >
      <Card.Section p={0} m={0} withBorder>
        <div
          className={clsx(
            'group relative flex items-center justify-center',
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
              <SourceImageUploadMultiple.Dimensions
                width={previewItem.width}
                height={previewItem.height}
              />
              {enableDrawing &&
                (isMobile ? (
                  // Mobile: Large prominent button bottom-left
                  <ActionIcon
                    variant="white"
                    color="dark"
                    size="lg"
                    className="absolute bottom-1 left-1 m-0 rounded-md shadow-lg"
                    onClick={handleOpenDrawingEditor}
                  >
                    <IconPalette size={24} />
                  </ActionIcon>
                ) : (
                  // Desktop: Full hover overlay
                  <div
                    className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={handleOpenDrawingEditor}
                  >
                    <div className="flex items-center gap-2 rounded-md bg-white/90 px-3 py-2 text-dark-9">
                      <IconPalette size={20} />
                      <span className="text-sm font-medium">Sketch Edit</span>
                    </div>
                  </div>
                ))}
            </>
          )}
          {previewItem.status === 'error' && (
            <Text c="red" size="sm" align="center">
              {previewItem.error}
            </Text>
          )}
        </div>
      </Card.Section>
      <SourceImageUploadMultiple.CloseButton onClick={handleRemoveItem} disabled={disabled} />
    </Card>
  );
};

export async function uploadOrchestratorImage(src: string | Blob | File, id: string) {
  const originalSize = await getImageDimensions(src);

  // If already an orchestrator URL, return it directly
  if (typeof src === 'string' && isOrchestratorUrl(src)) {
    return {
      url: src,
      ...originalSize,
      available: true,
      type: 'image',
      id: '',
    };
  }

  try {
    setImageUploading(id, true);

    // Resize and convert to JPEG blob
    const resized = await resizeImage(src, {
      maxHeight: maxUpscaleSize,
      maxWidth: maxUpscaleSize,
      minWidth: minUploadSize,
      minHeight: minUploadSize,
    });
    const jpegBlob = await imageToJpegBlob(resized);

    // Get dimensions after resizing
    const resizedSize = await getImageDimensions(jpegBlob);

    // Upload using presigned URL
    const blob = await uploadConsumerBlob(jpegBlob);
    setImageUploading(id, false);

    return { ...blob, ...resizedSize };
  } catch (e) {
    setImageUploading(id, false);
    const error = e as Error;

    return {
      url: typeof src === 'string' ? src : URL.createObjectURL(src),
      ...originalSize,
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
