/**
 * ImageUploadMultipleInput
 *
 * A form input component for uploading multiple images (for img2img, video generation, etc.)
 * Wraps the SourceImageUploadMultiple component.
 *
 * Value format: SourceImageProps[] | null
 */

import type { InputWrapperProps } from '@mantine/core';
import { Input } from '@mantine/core';
import { SourceImageUploadMultiple } from '~/components/Generation/Input/SourceImageUploadMultiple';
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
  /** Aspect ratio mode for the dropzone/preview */
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

// =============================================================================
// Component
// =============================================================================

export function ImageUploadMultipleInput({
  value,
  onChange,
  max = 1,
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
        error={typeof error === 'string' ? error : undefined}
      >
        {(previewItems) => (
          <div
            className={
              max === 1
                ? 'mx-auto w-full max-w-80'
                : 'grid grid-cols-2 gap-4 @xs:grid-cols-3 @sm:grid-cols-4'
            }
          >
            {previewItems.map((item, i) => (
              <SourceImageUploadMultiple.Image key={i} index={i} {...item} />
            ))}
            <SourceImageUploadMultiple.Dropzone />
          </div>
        )}
      </SourceImageUploadMultiple>
    </Input.Wrapper>
  );
}
