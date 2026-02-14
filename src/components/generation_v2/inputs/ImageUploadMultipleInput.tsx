/**
 * ImageUploadMultipleInput
 *
 * A form input component for uploading multiple images (for img2img, video generation, etc.)
 *
 * Value format: ImageValue[] | null
 *
 * Styling:
 * - Compact dropzone + horizontal image strip layout for all non-slot modes
 * - slots: Side-by-side named slots (e.g., first/last frame)
 *
 * Drawing support:
 * - When enableDrawing is true, images can be annotated with drawings
 * - Annotations are stored in the source-metadata store keyed by composite URL
 * - The store enables re-editing: looking up a composite URL retrieves the original image + lines
 */

import { useMemo } from 'react';
import type { InputWrapperProps } from '@mantine/core';
import { Input, Text } from '@mantine/core';
import { IconPhoto } from '@tabler/icons-react';
import {
  SourceImageUploadMultiple,
  type ImageAnnotation,
  type ImageSlot,
} from '~/components/Generation/Input/SourceImageUploadMultiple';
import type { DrawingElement } from '~/components/Generation/Input/DrawingEditor/drawing.types';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import {
  useSourceMetadataStore,
  sourceMetadataStore,
} from '~/store/source-metadata.store';

// =============================================================================
// Types
// =============================================================================

/** Image value type - can be minimal (just url, width, height) or full SourceImageProps */
export type ImageValue = { url: string; width: number; height: number } & Partial<
  Omit<SourceImageProps, 'url' | 'width' | 'height'>
>;

export interface ImageUploadMultipleInputProps
  extends Omit<InputWrapperProps, 'children' | 'onChange'> {
  value?: ImageValue[] | null;
  onChange?: (value: ImageValue[]) => void;
  /** Maximum number of images that can be uploaded */
  max?: number;
  /**
   * Named slots for fixed-position images (e.g., first/last frame).
   * When provided, renders side-by-side dropzones with labels.
   */
  slots?: ImageSlot[];
  /** Aspect ratio mode for the dropzone/preview (only affects multi-image grid mode) */
  aspect?: 'square' | 'video';
  /** Whether to warn when AI metadata is missing from uploaded images */
  warnOnMissingAiMetadata?: boolean;
  /** Allowed aspect ratios for cropping */
  aspectRatios?: `${number}:${number}`[];
  /** Whether to crop subsequent images to match the first image's aspect ratio */
  cropToFirstImage?: boolean;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Enable drawing overlay tools on images (for img2img:edit workflows) */
  enableDrawing?: boolean;
}

// Re-export ImageSlot for convenience
export type { ImageSlot };

// =============================================================================
// Component
// =============================================================================

export function ImageUploadMultipleInput({
  value,
  onChange,
  max = 1,
  slots,
  aspect = 'square',
  warnOnMissingAiMetadata = false,
  aspectRatios,
  cropToFirstImage = false,
  label,
  description,
  error,
  required,
  disabled,
  enableDrawing = false,
  ...inputWrapperProps
}: ImageUploadMultipleInputProps) {
  const isSlotsMode = !!slots?.length;

  // Build annotations array from the store for the current images
  const metadataByUrl = useSourceMetadataStore((state) => state.metadataByUrl);
  const annotations = useMemo(() => {
    if (!enableDrawing || !value?.length) return undefined;
    const result: ImageAnnotation[] = [];
    for (const img of value) {
      const annotation = metadataByUrl[img.url]?.annotation;
      if (annotation) {
        result.push({ ...annotation, compositeUrl: img.url });
      }
    }
    return result.length > 0 ? result : undefined;
  }, [enableDrawing, value, metadataByUrl]);

  function handleDrawingComplete(
    compositeImage: SourceImageProps,
    index: number,
    lines: DrawingElement[]
  ) {
    const currentImages = value ?? [];
    const currentImage = currentImages[index];
    if (!currentImage) return;

    // Check if this image already has an annotation (re-editing)
    const existingAnnotation = sourceMetadataStore.getAnnotation(currentImage.url);

    // The original is either from existing annotation or the current image
    const originalImage = existingAnnotation
      ? {
          url: existingAnnotation.originalUrl,
          width: existingAnnotation.originalWidth,
          height: existingAnnotation.originalHeight,
        }
      : currentImage;

    // 1. Replace the image with the composite
    const updatedImages = [...currentImages];
    updatedImages[index] = compositeImage;
    onChange?.(updatedImages);

    // 2. Clean up old annotation (if re-editing, the old composite URL entry is stale)
    if (existingAnnotation) {
      sourceMetadataStore.removeAnnotation(currentImage.url);
    }

    // 3. Store new annotation keyed by composite URL
    sourceMetadataStore.setAnnotation(compositeImage.url, {
      originalUrl: originalImage.url,
      originalWidth: originalImage.width,
      originalHeight: originalImage.height,
      lines,
    });
  }

  function handleRemove(removedImage: SourceImageProps) {
    sourceMetadataStore.removeAnnotation(removedImage.url);
  }

  // For slots mode, use the built-in slots layout
  if (isSlotsMode) {
    return (
      <Input.Wrapper
        {...inputWrapperProps}
        label={label}
        description={description}
        error={error}
        required={required}
      >
        <SourceImageUploadMultiple
          value={value as SourceImageProps[] | null | undefined}
          onChange={(v) => onChange?.(v ?? [])}
          slots={slots}
          warnOnMissingAiMetadata={warnOnMissingAiMetadata}
          aspectRatios={aspectRatios}
          cropToFirstImage={cropToFirstImage}
          disabled={disabled}
        />
      </Input.Wrapper>
    );
  }

  // Compact layout for both single and multiple image modes
  return (
    <Input.Wrapper
      {...inputWrapperProps}
      label={label}
      description={description}
      error={error}
      required={required}
    >
      <SourceImageUploadMultiple
        value={value as SourceImageProps[] | null | undefined}
        onChange={(v) => onChange?.(v ?? [])}
        max={max}
        aspect={aspect}
        warnOnMissingAiMetadata={warnOnMissingAiMetadata}
        aspectRatios={aspectRatios}
        cropToFirstImage={cropToFirstImage}
        disabled={disabled}
        enableDrawing={enableDrawing}
        annotations={annotations}
        onDrawingComplete={enableDrawing ? handleDrawingComplete : undefined}
        onRemove={enableDrawing ? handleRemove : undefined}
      >
        {(previewItems) => {
          const hasImages = previewItems.length > 0;
          const canAddMore = previewItems.length < max;
          const completedCount = previewItems.filter((item) => item.status === 'complete').length;

          return (
            <div className="flex flex-col gap-3">
              {/* Dropzone - always visible until limit reached */}
              {canAddMore && (
                <SourceImageUploadMultiple.Dropzone className="min-h-[100px]">
                  <div className="flex flex-col items-center justify-center gap-1 py-2">
                    <IconPhoto size={32} stroke={1.5} />
                    <Text size="sm" c="dimmed">
                      {hasImages ? 'Add more images' : 'Drop images here or click to select'}
                    </Text>
                    {max > 1 && (
                      <Text size="xs" c="dimmed">
                        {completedCount} of {max} images
                      </Text>
                    )}
                  </div>
                </SourceImageUploadMultiple.Dropzone>
              )}

              {/* Horizontal scrolling image strip */}
              {hasImages && (
                <div className="flex gap-3 overflow-x-auto">
                  {previewItems.map((item, i) => (
                    <div key={i} className="w-[140px] shrink-0">
                      <SourceImageUploadMultiple.Image index={i} {...item} />
                    </div>
                  ))}
                </div>
              )}

              {/* Show count when at limit (only for multi-image mode) */}
              {!canAddMore && max > 1 && (
                <Text size="xs" c="dimmed">
                  {completedCount} of {max} images (limit reached)
                </Text>
              )}
            </div>
          );
        }}
      </SourceImageUploadMultiple>
    </Input.Wrapper>
  );
}
