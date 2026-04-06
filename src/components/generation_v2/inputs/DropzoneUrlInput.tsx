/**
 * DropzoneUrlInput
 *
 * A composite input that combines a drop target with a URL text input.
 * The entire container is a drop target (dashed border). Inside, there's a text
 * input for pasting URLs and a "Choose..." button to open the file picker.
 * Below the input row, hint text describes accepted inputs.
 *
 * Uses native HTML5 drag/drop + hidden file input instead of Mantine Dropzone
 * because Dropzone's inner wrapper sets pointer-events:none which blocks
 * interaction with the TextInput.
 *
 * When a file is dropped or chosen, it's uploaded via uploadConsumerBlob and
 * the resulting URL is passed to onChange. When a URL is typed/pasted, it's
 * passed directly.
 */

import { Button, Input, Loader, Text, TextInput } from '@mantine/core';
import clsx from 'clsx';
import { useCallback, useRef, useState } from 'react';
import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import { formatBytes } from '~/utils/number-helpers';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';

// =============================================================================
// Types
// =============================================================================

export interface DropzoneUrlInputProps {
  /** Current URL value */
  value: string | null;
  /** Called with the URL when it changes (from typed input, file upload, or drag) */
  onChange: (url: string | null) => void;
  /** Label above the input (omit to render without a label row) */
  label?: string;
  /** Tooltip text shown in an info popover */
  tooltip?: string;
  /** Placeholder text for the URL input */
  placeholder?: string;
  /** Hint text below the input row */
  hint?: string;
  /** MIME types to accept for file uploads */
  accept?: string[];
  /** Max file size in bytes */
  maxFileSize?: number;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Input size */
  size?: 'xs' | 'sm' | 'md';
}

// =============================================================================
// Component
// =============================================================================

export function DropzoneUrlInput({
  value,
  onChange,
  label,
  tooltip,
  placeholder = 'Add a file or provide a URL',
  hint,
  accept,
  maxFileSize,
  disabled = false,
  size = 'xs',
}: DropzoneUrlInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadFile = useCallback(
    async (file: File) => {
      if (accept?.length && !accept.includes(file.type)) return;

      if (maxFileSize && file.size > maxFileSize) {
        setError(`File must be smaller than ${formatBytes(maxFileSize)}`);
        return;
      }

      setIsUploading(true);
      setError(null);

      try {
        const blob = await uploadConsumerBlob(file);
        if (blob.blockedReason || !blob.available || !blob.url) {
          throw new Error(blob.blockedReason ?? 'Upload failed');
        }
        onChange(blob.url);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to upload file');
      } finally {
        setIsUploading(false);
      }
    },
    [onChange, maxFileSize, accept]
  );

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (!disabled && !isUploading) setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
  }

  async function handleNativeDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled || isUploading) return;

    // Check for URL drops first
    const url = e.dataTransfer.getData('text/uri-list');
    if (url?.length) {
      setError(null);
      onChange(url);
      return;
    }

    // File drops
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) await uploadFile(files[0]);
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) uploadFile(files[0]);
    e.target.value = ''; // Reset so same file can be re-selected
  }

  const handleUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value || null);
    },
    [onChange]
  );

  return (
    <div className="flex flex-col gap-1">
      {/* Label + tooltip */}
      {label && (
        <div className="flex items-center gap-1">
          <Input.Label size={size}>{label}</Input.Label>
          {tooltip && (
            <InfoPopover size="xs" iconProps={{ size: 14 }} type="hover">
              <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                {tooltip}
              </Text>
            </InfoPopover>
          )}
        </div>
      )}

      {/* Native drop target wrapping the input row + hint */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleNativeDrop}
        className={clsx(
          'rounded-md border border-dashed p-3',
          isDragOver
            ? 'border-blue-5 bg-blue-0 dark:border-blue-7 dark:bg-blue-9/20'
            : 'border-gray-4 dark:border-dark-4'
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={accept?.join(',')}
          onChange={handleFileInputChange}
        />
        <div className="flex flex-col gap-2">
          {/* Input row */}
          <div className="flex items-center gap-2">
            <TextInput
              className="flex-1"
              placeholder={placeholder}
              value={value ?? ''}
              onChange={handleUrlChange}
              size={size}
              disabled={disabled || isUploading}
              rightSection={isUploading ? <Loader size={14} /> : undefined}
            />
            <Button
              variant="default"
              size={size}
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || isUploading}
            >
              Choose...
            </Button>
          </div>

          {/* Hint text */}
          {hint && (
            <Text size="xs" c="dimmed">
              {hint}
            </Text>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <Text size="xs" c="red">
          {error}
        </Text>
      )}
    </div>
  );
}
