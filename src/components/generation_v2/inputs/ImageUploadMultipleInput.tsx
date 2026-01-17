/**
 * ImageUploadMultipleInput
 *
 * A form input component for uploading multiple images (for img2img, video generation, etc.)
 *
 * Value format: ImageValue[] | null
 *
 * Styling:
 * - max=1: Single image mode with full-width dropzone/preview (similar to VideoInput)
 * - max>1: Horizontal strip layout with large dropzone when empty, compact when images exist
 * - slots: Side-by-side named slots (e.g., first/last frame)
 */

import type { InputWrapperProps } from '@mantine/core';
import { Input, Text } from '@mantine/core';
import { IconPhoto } from '@tabler/icons-react';
import {
  SourceImageUploadMultiple,
  type ImageSlot,
} from '~/components/Generation/Input/SourceImageUploadMultiple';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';

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
  ...inputWrapperProps
}: ImageUploadMultipleInputProps) {
  const isSlotsMode = !!slots?.length;
  const isSingleMode = max === 1 && !isSlotsMode;

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

  // For single mode, use the built-in VideoInput-style layout
  if (isSingleMode) {
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
          max={1}
          warnOnMissingAiMetadata={warnOnMissingAiMetadata}
          aspectRatios={aspectRatios}
          cropToFirstImage={cropToFirstImage}
          disabled={disabled}
        />
      </Input.Wrapper>
    );
  }

  // For multiple mode, use improved layout
  // Note: canAddMore is computed inside the render function using previewItems.length
  // to account for uploading items

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
                    <Text size="xs" c="dimmed">
                      {completedCount} of {max} images
                    </Text>
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

              {/* Show count when at limit */}
              {!canAddMore && (
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
